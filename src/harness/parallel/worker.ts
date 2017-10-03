namespace Harness.Parallel.Worker {
    let errors: ErrorInfo[] = [];
    let passing = 0;
    let reportedUnitTests = false;

    type Executor = {name: string, callback: Function, kind: "suite" | "test"} | never;

    function resetShimHarnessAndExecute(runner: RunnerBase) {
        if (reportedUnitTests) {
            errors = [];
            passing = 0;
            testList.length = 0;
        }
        reportedUnitTests = true;
        const start = +(new Date());
        runner.initializeTests();
        testList.forEach(({ name, callback, kind }) => executeCallback(name, callback, kind));
        return { errors, passing, duration: +(new Date()) - start };
    }


    let beforeEachFunc: Function;
    const namestack: string[] = [];
    let testList: Executor[] = [];
    function shimMochaHarness() {
        (global as any).before = undefined;
        (global as any).after = undefined;
        (global as any).beforeEach = undefined;
        describe = ((name, callback) => {
            testList.push({ name, callback, kind: "suite" });
        }) as Mocha.IContextDefinition;
        it = ((name, callback) => {
            if (!testList) {
                throw new Error("Tests must occur within a describe block");
            }
            testList.push({ name, callback, kind: "test" });
        }) as Mocha.ITestDefinition;
    }

    function executeSuiteCallback(name: string, callback: Function) {
        const fakeContext: Mocha.ISuiteCallbackContext = {
            retries() { return this; },
            slow() { return this; },
            timeout() { return this; },
        };
        namestack.push(name);
        let beforeFunc: Function;
        (before as any) = (cb: Function) => beforeFunc = cb;
        let afterFunc: Function;
        (after as any) = (cb: Function) => afterFunc = cb;
        const savedBeforeEach = beforeEachFunc;
        (beforeEach as any) = (cb: Function) => beforeEachFunc = cb;
        const savedTestList = testList;

        testList = [];
        try {
            callback.call(fakeContext);
        }
        catch (e) {
            errors.push({ error: `Error executing suite: ${e.message}`, stack: e.stack, name: namestack.join(" ") });
            return cleanup();
        }
        try {
            beforeFunc && beforeFunc();
        }
        catch (e) {
            errors.push({ error: `Error executing before function: ${e.message}`, stack: e.stack, name: namestack.join(" ") });
            return cleanup();
        }
        finally {
            beforeFunc = undefined;
        }
        testList.forEach(({ name, callback, kind }) => executeCallback(name, callback, kind));

        try {
            afterFunc && afterFunc();
        }
        catch (e) {
            errors.push({ error: `Error executing after function: ${e.message}`, stack: e.stack, name: namestack.join(" ") });
        }
        finally {
            afterFunc = undefined;
            cleanup();
        }
        function cleanup() {
            testList.length = 0;
            testList = savedTestList;
            beforeEachFunc = savedBeforeEach;
            namestack.pop();
        }
    }

    function executeCallback(name: string, callback: Function, kind: "suite" | "test") {
        if (kind === "suite") {
            executeSuiteCallback(name, callback);
        }
        else {
            executeTestCallback(name, callback);
        }
    }

    function executeTestCallback(name: string, callback: Function) {
        const fakeContext: Mocha.ITestCallbackContext = {
            skip() { return this; },
            timeout() { return this; },
            retries() { return this; },
            slow() { return this; },
        };
        namestack.push(name);
        name = namestack.join(" ");
        if (beforeEachFunc) {
            try {
                beforeEachFunc();
            }
            catch (error) {
                errors.push({ error: error.message, stack: error.stack, name });
                namestack.pop();
                return;
            }
        }
        if (callback.length === 0) {
            try {
                // TODO: If we ever start using async test completions, polyfill promise return handling
                callback.call(fakeContext);
            }
            catch (error) {
                errors.push({ error: error.message, stack: error.stack, name });
                return;
            }
            finally {
                namestack.pop();
            }
            passing++;
        }
        else {
            // Uses `done` callback
            let completed = false;
            try {
                callback.call(fakeContext, (err: any) => {
                    if (completed) {
                        throw new Error(`done() callback called multiple times; ensure it is only called once.`);
                    }
                    if (err) {
                        errors.push({ error: err.toString(), stack: "", name });
                    }
                    else {
                        passing++;
                    }
                    completed = true;
                });
            }
            catch (error) {
                errors.push({ error: error.message, stack: error.stack, name });
                return;
            }
            finally {
                namestack.pop();
            }
            if (!completed) {
                errors.push({ error: "Test completes asynchronously, which is unsupported by the parallel harness", stack: "", name });
            }
        }
    }

    export function start() {
        let initialized = false;
        const runners = ts.createMap<RunnerBase>();
        process.on("message", (data: ParallelHostMessage) => {
            if (!initialized) {
                initialized = true;
                shimMochaHarness();
            }
            switch (data.type) {
                case "test":
                    const { runner, file } = data.payload;
                    if (!runner) {
                        console.error(data);
                    }
                    const message: ParallelResultMessage = { type: "result", payload: handleTest(runner, file) };
                    process.send(message);
                    break;
                case "close":
                    process.exit(0);
                    break;
                case "batch": {
                    const items = data.payload;
                    for (let i = 0; i < items.length; i++) {
                        const { runner, file } = items[i];
                        if (!runner) {
                            console.error(data);
                        }
                        let message: ParallelBatchProgressMessage | ParallelResultMessage;
                        const payload = handleTest(runner, file);
                        if (i === (items.length - 1)) {
                            message = { type: "result", payload };
                        }
                        else {
                            message = { type: "progress", payload };
                        }
                        process.send(message);
                    }
                    break;
                }
            }
        });
        process.on("uncaughtException", error => {
            const message: ParallelErrorMessage = { type: "error", payload: { error: error.message, stack: error.stack, name: namestack.join(" ") } };
            try {
                process.send(message);
            }
            catch (e) {
                console.error(error);
                throw error;
            }
        });
        if (!runUnitTests) {
            // ensure unit tests do not get run
            describe = ts.noop as any;
        }
        else {
            initialized = true;
            shimMochaHarness();
        }

        function handleTest(runner: TestRunnerKind, file: string) {
            if (!runners.has(runner)) {
                runners.set(runner, createRunner(runner));
            }
            const instance = runners.get(runner);
            instance.tests = [file];
            return { ...resetShimHarnessAndExecute(instance), runner, file };
        }
    }
}