/// <reference path="harness.ts" />

namespace ts.TestFSWithWatch {
    const { content: libFileContent } = Harness.getDefaultLibraryFile(Harness.IO);
    export const libFile: FileOrFolder = {
        path: "/a/lib/lib.d.ts",
        content: libFileContent
    };

    export const safeList = {
        path: <Path>"/safeList.json",
        content: JSON.stringify({
            commander: "commander",
            express: "express",
            jquery: "jquery",
            lodash: "lodash",
            moment: "moment",
            chroma: "chroma-js"
        })
    };

    function getExecutingFilePathFromLibFile(): string {
        return combinePaths(getDirectoryPath(libFile.path), "tsc.js");
    }

    interface TestServerHostCreationParameters {
        useCaseSensitiveFileNames?: boolean;
        executingFilePath?: string;
        currentDirectory?: string;
        newLine?: string;
    }

    export function createWatchedSystem(fileOrFolderList: ReadonlyArray<FileOrFolder>, params?: TestServerHostCreationParameters): TestServerHost {
        if (!params) {
            params = {};
        }
        const host = new TestServerHost(/*withSafelist*/ false,
            params.useCaseSensitiveFileNames !== undefined ? params.useCaseSensitiveFileNames : false,
            params.executingFilePath || getExecutingFilePathFromLibFile(),
            params.currentDirectory || "/",
            fileOrFolderList,
            params.newLine);
        return host;
    }

    export function createServerHost(fileOrFolderList: ReadonlyArray<FileOrFolder>, params?: TestServerHostCreationParameters): TestServerHost {
        if (!params) {
            params = {};
        }
        const host = new TestServerHost(/*withSafelist*/ true,
            params.useCaseSensitiveFileNames !== undefined ? params.useCaseSensitiveFileNames : false,
            params.executingFilePath || getExecutingFilePathFromLibFile(),
            params.currentDirectory || "/",
            fileOrFolderList,
            params.newLine);
        return host;
    }

    export interface FileOrFolder {
        path: string;
        content?: string;
        fileSize?: number;
    }

    interface FSEntry {
        path: Path;
        fullPath: string;
    }

    interface File extends FSEntry {
        content: string;
        fileSize?: number;
    }

    interface Folder extends FSEntry {
        entries: FSEntry[];
    }

    function isFolder(s: FSEntry): s is Folder {
        return s && isArray((<Folder>s).entries);
    }

    function isFile(s: FSEntry): s is File {
        return s && isString((<File>s).content);
    }

    function invokeWatcherCallbacks<T>(callbacks: T[], invokeCallback: (cb: T) => void): void {
        if (callbacks) {
            // The array copy is made to ensure that even if one of the callback removes the callbacks,
            // we dont miss any callbacks following it
            const cbs = callbacks.slice();
            for (const cb of cbs) {
                invokeCallback(cb);
            }
        }
    }

    function getDiffInKeys(map: Map<any>, expectedKeys: ReadonlyArray<string>) {
        if (map.size === expectedKeys.length) {
            return "";
        }
        const notInActual: string[] = [];
        const duplicates: string[] = [];
        const seen = createMap<true>();
        forEach(expectedKeys, expectedKey => {
            if (seen.has(expectedKey)) {
                duplicates.push(expectedKey);
                return;
            }
            seen.set(expectedKey, true);
            if (!map.has(expectedKey)) {
                notInActual.push(expectedKey);
            }
        });
        const inActualNotExpected: string[] = [];
        map.forEach((_value, key) => {
            if (!seen.has(key)) {
                inActualNotExpected.push(key);
            }
            seen.set(key, true);
        });
        return `\n\nNotInActual: ${notInActual}\nDuplicates: ${duplicates}\nInActualButNotInExpected: ${inActualNotExpected}`;
    }

    function checkMapKeys(caption: string, map: Map<any>, expectedKeys: ReadonlyArray<string>) {
        assert.equal(map.size, expectedKeys.length, `${caption}: incorrect size of map: Actual keys: ${arrayFrom(map.keys())} Expected: ${expectedKeys}${getDiffInKeys(map, expectedKeys)}`);
        for (const name of expectedKeys) {
            assert.isTrue(map.has(name), `${caption} is expected to contain ${name}, actual keys: ${arrayFrom(map.keys())}`);
        }
    }

    export function checkFileNames(caption: string, actualFileNames: ReadonlyArray<string>, expectedFileNames: string[]) {
        assert.equal(actualFileNames.length, expectedFileNames.length, `${caption}: incorrect actual number of files, expected ${expectedFileNames}, got ${actualFileNames}`);
        for (const f of expectedFileNames) {
            assert.isTrue(contains(actualFileNames, f), `${caption}: expected to find ${f} in ${actualFileNames}`);
        }
    }

    export function checkWatchedFiles(host: TestServerHost, expectedFiles: string[]) {
        checkMapKeys("watchedFiles", host.watchedFiles, expectedFiles);
    }

    export function checkWatchedDirectories(host: TestServerHost, expectedDirectories: string[], recursive = false) {
        checkMapKeys(`watchedDirectories${recursive ? " recursive" : ""}`, recursive ? host.watchedDirectoriesRecursive : host.watchedDirectories, expectedDirectories);
    }

    export function checkOutputContains(host: TestServerHost, expected: ReadonlyArray<string>) {
        const mapExpected = arrayToSet(expected);
        const mapSeen = createMap<true>();
        for (const f of host.getOutput()) {
            assert.isUndefined(mapSeen.get(f), `Already found ${f} in ${JSON.stringify(host.getOutput())}`);
            if (mapExpected.has(f)) {
                mapExpected.delete(f);
                mapSeen.set(f, true);
            }
        }
        assert.equal(mapExpected.size, 0, `Output has missing ${JSON.stringify(flatMapIter(mapExpected.keys(), key => key))} in ${JSON.stringify(host.getOutput())}`);
    }

    export function checkOutputDoesNotContain(host: TestServerHost, expectedToBeAbsent: string[] | ReadonlyArray<string>) {
        const mapExpectedToBeAbsent = arrayToSet(expectedToBeAbsent);
        for (const f of host.getOutput()) {
            assert.isFalse(mapExpectedToBeAbsent.has(f), `Contains ${f} in ${JSON.stringify(host.getOutput())}`);
        }
    }

    class Callbacks {
        private map: TimeOutCallback[] = [];
        private nextId = 1;

        register(cb: (...args: any[]) => void, args: any[]) {
            const timeoutId = this.nextId;
            this.nextId++;
            this.map[timeoutId] = cb.bind(/*this*/ undefined, ...args);
            return timeoutId;
        }

        unregister(id: any) {
            if (typeof id === "number") {
                delete this.map[id];
            }
        }

        count() {
            let n = 0;
            for (const _ in this.map) {
                n++;
            }
            return n;
        }

        invoke() {
            // Note: invoking a callback may result in new callbacks been queued,
            // so do not clear the entire callback list regardless. Only remove the
            // ones we have invoked.
            for (const key in this.map) {
                this.map[key]();
                delete this.map[key];
            }
        }
    }

    type TimeOutCallback = () => any;

    export interface TestFileWatcher {
        cb: FileWatcherCallback;
        fileName: string;
    }

    export interface TestDirectoryWatcher {
        cb: DirectoryWatcherCallback;
        directoryName: string;
    }

    export class TestServerHost implements server.ServerHost {
        args: string[] = [];

        private readonly output: string[] = [];

        private fs: Map<FSEntry> = createMap<FSEntry>();
        private getCanonicalFileName: (s: string) => string;
        private toPath: (f: string) => Path;
        private timeoutCallbacks = new Callbacks();
        private immediateCallbacks = new Callbacks();

        readonly watchedDirectories = createMultiMap<TestDirectoryWatcher>();
        readonly watchedDirectoriesRecursive = createMultiMap<TestDirectoryWatcher>();
        readonly watchedFiles = createMultiMap<TestFileWatcher>();

        constructor(public withSafeList: boolean, public useCaseSensitiveFileNames: boolean, private executingFilePath: string, private currentDirectory: string, fileOrFolderList: ReadonlyArray<FileOrFolder>, public readonly newLine = "\n") {
            this.getCanonicalFileName = createGetCanonicalFileName(useCaseSensitiveFileNames);
            this.toPath = s => toPath(s, currentDirectory, this.getCanonicalFileName);

            this.reloadFS(fileOrFolderList);
        }

        toNormalizedAbsolutePath(s: string) {
            return getNormalizedAbsolutePath(s, this.currentDirectory);
        }

        toFullPath(s: string) {
            return this.toPath(this.toNormalizedAbsolutePath(s));
        }

        reloadFS(fileOrFolderList: ReadonlyArray<FileOrFolder>) {
            const mapNewLeaves = createMap<true>();
            const isNewFs = this.fs.size === 0;
            // always inject safelist file in the list of files
            for (const fileOrDirectory of fileOrFolderList.concat(this.withSafeList ? safeList : [])) {
                const path = this.toFullPath(fileOrDirectory.path);
                mapNewLeaves.set(path, true);
                // If its a change
                const currentEntry = this.fs.get(path);
                if (currentEntry) {
                    if (isFile(currentEntry)) {
                        if (isString(fileOrDirectory.content)) {
                            // Update file
                            if (currentEntry.content !== fileOrDirectory.content) {
                                currentEntry.content = fileOrDirectory.content;
                                this.invokeFileWatcher(currentEntry.fullPath, FileWatcherEventKind.Changed);
                            }
                        }
                        else {
                            // TODO: Changing from file => folder
                        }
                    }
                    else {
                        // Folder
                        if (isString(fileOrDirectory.content)) {
                            // TODO: Changing from folder => file
                        }
                        else {
                            // Folder update: Nothing to do.
                        }
                    }
                }
                else {
                    this.ensureFileOrFolder(fileOrDirectory);
                }
            }

            if (!isNewFs) {
                this.fs.forEach((fileOrDirectory, path) => {
                    // If this entry is not from the new file or folder
                    if (!mapNewLeaves.get(path)) {
                        // Leaf entries that arent in new list => remove these
                        if (isFile(fileOrDirectory) || isFolder(fileOrDirectory) && fileOrDirectory.entries.length === 0) {
                            this.removeFileOrFolder(fileOrDirectory, folder => !mapNewLeaves.get(folder.path));
                        }
                    }
                });
            }
        }

        ensureFileOrFolder(fileOrDirectory: FileOrFolder) {
            if (isString(fileOrDirectory.content)) {
                const file = this.toFile(fileOrDirectory);
                Debug.assert(!this.fs.get(file.path));
                const baseFolder = this.ensureFolder(getDirectoryPath(file.fullPath));
                this.addFileOrFolderInFolder(baseFolder, file);
            }
            else {
                const fullPath = getNormalizedAbsolutePath(fileOrDirectory.path, this.currentDirectory);
                this.ensureFolder(fullPath);
            }
        }

        private ensureFolder(fullPath: string): Folder {
            const path = this.toPath(fullPath);
            let folder = this.fs.get(path) as Folder;
            if (!folder) {
                folder = this.toFolder(fullPath);
                const baseFullPath = getDirectoryPath(fullPath);
                if (fullPath !== baseFullPath) {
                    // Add folder in the base folder
                    const baseFolder = this.ensureFolder(baseFullPath);
                    this.addFileOrFolderInFolder(baseFolder, folder);
                }
                else {
                    // root folder
                    Debug.assert(this.fs.size === 0);
                    this.fs.set(path, folder);
                }
            }
            Debug.assert(isFolder(folder));
            return folder;
        }

        private addFileOrFolderInFolder(folder: Folder, fileOrDirectory: File | Folder) {
            folder.entries.push(fileOrDirectory);
            this.fs.set(fileOrDirectory.path, fileOrDirectory);

            if (isFile(fileOrDirectory)) {
                this.invokeFileWatcher(fileOrDirectory.fullPath, FileWatcherEventKind.Created);
            }
            this.invokeDirectoryWatcher(folder.fullPath, fileOrDirectory.fullPath);
        }

        private removeFileOrFolder(fileOrDirectory: File | Folder, isRemovableLeafFolder: (folder: Folder) => boolean) {
            const basePath = getDirectoryPath(fileOrDirectory.path);
            const baseFolder = this.fs.get(basePath) as Folder;
            if (basePath !== fileOrDirectory.path) {
                Debug.assert(!!baseFolder);
                filterMutate(baseFolder.entries, entry => entry !== fileOrDirectory);
            }
            this.fs.delete(fileOrDirectory.path);

            if (isFile(fileOrDirectory)) {
                this.invokeFileWatcher(fileOrDirectory.fullPath, FileWatcherEventKind.Deleted);
            }
            else {
                Debug.assert(fileOrDirectory.entries.length === 0);
                const relativePath = this.getRelativePathToDirectory(fileOrDirectory.fullPath, fileOrDirectory.fullPath);
                // Invoke directory and recursive directory watcher for the folder
                // Here we arent invoking recursive directory watchers for the base folders
                // since that is something we would want to do for both file as well as folder we are deleting
                invokeWatcherCallbacks(this.watchedDirectories.get(fileOrDirectory.path), cb => this.directoryCallback(cb, relativePath));
                invokeWatcherCallbacks(this.watchedDirectoriesRecursive.get(fileOrDirectory.path), cb => this.directoryCallback(cb, relativePath));
            }

            if (basePath !== fileOrDirectory.path) {
                if (baseFolder.entries.length === 0 && isRemovableLeafFolder(baseFolder)) {
                    this.removeFileOrFolder(baseFolder, isRemovableLeafFolder);
                }
                else {
                    this.invokeRecursiveDirectoryWatcher(baseFolder.fullPath, fileOrDirectory.fullPath);
                }
            }
        }

        private invokeFileWatcher(fileFullPath: string, eventKind: FileWatcherEventKind) {
            const callbacks = this.watchedFiles.get(this.toPath(fileFullPath));
            invokeWatcherCallbacks(callbacks, ({ cb, fileName }) => cb(fileName, eventKind));
        }

        private getRelativePathToDirectory(directoryFullPath: string, fileFullPath: string) {
            return getRelativePathToDirectoryOrUrl(directoryFullPath, fileFullPath, this.currentDirectory, this.getCanonicalFileName, /*isAbsolutePathAnUrl*/ false);
        }

        /**
         * This will call the directory watcher for the folderFullPath and recursive directory watchers for this and base folders
         */
        private invokeDirectoryWatcher(folderFullPath: string, fileName: string) {
            const relativePath = this.getRelativePathToDirectory(folderFullPath, fileName);
            invokeWatcherCallbacks(this.watchedDirectories.get(this.toPath(folderFullPath)), cb => this.directoryCallback(cb, relativePath));
            this.invokeRecursiveDirectoryWatcher(folderFullPath, fileName);
        }

        private directoryCallback({ cb, directoryName }: TestDirectoryWatcher, relativePath: string) {
            cb(combinePaths(directoryName, relativePath));
        }

        /**
         * This will call the recursive directory watcher for this directory as well as all the base directories
         */
        private invokeRecursiveDirectoryWatcher(fullPath: string, fileName: string) {
            const relativePath = this.getRelativePathToDirectory(fullPath, fileName);
            invokeWatcherCallbacks(this.watchedDirectoriesRecursive.get(this.toPath(fullPath)), cb => this.directoryCallback(cb, relativePath));
            const basePath = getDirectoryPath(fullPath);
            if (this.getCanonicalFileName(fullPath) !== this.getCanonicalFileName(basePath)) {
                this.invokeRecursiveDirectoryWatcher(basePath, fileName);
            }
        }

        private toFile(fileOrDirectory: FileOrFolder): File {
            const fullPath = getNormalizedAbsolutePath(fileOrDirectory.path, this.currentDirectory);
            return {
                path: this.toPath(fullPath),
                content: fileOrDirectory.content,
                fullPath,
                fileSize: fileOrDirectory.fileSize
            };
        }

        private toFolder(path: string): Folder {
            const fullPath = getNormalizedAbsolutePath(path, this.currentDirectory);
            return {
                path: this.toPath(fullPath),
                entries: [],
                fullPath
            };
        }

        fileExists(s: string) {
            const path = this.toFullPath(s);
            return isFile(this.fs.get(path));
        }

        readFile(s: string) {
            const fsEntry = this.fs.get(this.toFullPath(s));
            return isFile(fsEntry) ? fsEntry.content : undefined;
        }

        getFileSize(s: string) {
            const path = this.toFullPath(s);
            const entry = this.fs.get(path);
            if (isFile(entry)) {
                return entry.fileSize ? entry.fileSize : entry.content.length;
            }
            return undefined;
        }

        directoryExists(s: string) {
            const path = this.toFullPath(s);
            return isFolder(this.fs.get(path));
        }

        getDirectories(s: string) {
            const path = this.toFullPath(s);
            const folder = this.fs.get(path);
            if (isFolder(folder)) {
                return mapDefined(folder.entries, entry => isFolder(entry) ? getBaseFileName(entry.fullPath) : undefined);
            }
            Debug.fail(folder ? "getDirectories called on file" : "getDirectories called on missing folder");
            return [];
        }

        readDirectory(path: string, extensions?: ReadonlyArray<string>, exclude?: ReadonlyArray<string>, include?: ReadonlyArray<string>, depth?: number): string[] {
            return ts.matchFiles(this.toNormalizedAbsolutePath(path), extensions, exclude, include, this.useCaseSensitiveFileNames, this.getCurrentDirectory(), depth, (dir) => {
                const directories: string[] = [];
                const files: string[] = [];
                const dirEntry = this.fs.get(this.toPath(dir));
                if (isFolder(dirEntry)) {
                    dirEntry.entries.forEach((entry) => {
                        if (isFolder(entry)) {
                            directories.push(getBaseFileName(entry.fullPath));
                        }
                        else if (isFile(entry)) {
                            files.push(getBaseFileName(entry.fullPath));
                        }
                        else {
                            Debug.fail("Unknown entry");
                        }
                    });
                }
                return { directories, files };
            });
        }

        watchDirectory(directoryName: string, cb: DirectoryWatcherCallback, recursive: boolean): FileWatcher {
            const path = this.toFullPath(directoryName);
            const map = recursive ? this.watchedDirectoriesRecursive : this.watchedDirectories;
            const callback: TestDirectoryWatcher = {
                cb,
                directoryName
            };
            map.add(path, callback);
            return {
                close: () => map.remove(path, callback)
            };
        }

        createHash(s: string): string {
            return Harness.mockHash(s);
        }

        watchFile(fileName: string, cb: FileWatcherCallback) {
            const path = this.toFullPath(fileName);
            const callback: TestFileWatcher = { fileName, cb };
            this.watchedFiles.add(path, callback);
            return { close: () => this.watchedFiles.remove(path, callback) };
        }

        // TOOD: record and invoke callbacks to simulate timer events
        setTimeout(callback: TimeOutCallback, _time: number, ...args: any[]) {
            return this.timeoutCallbacks.register(callback, args);
        }

        clearTimeout(timeoutId: any): void {
            this.timeoutCallbacks.unregister(timeoutId);
        }

        checkTimeoutQueueLengthAndRun(expected: number) {
            this.checkTimeoutQueueLength(expected);
            this.runQueuedTimeoutCallbacks();
        }

        checkTimeoutQueueLength(expected: number) {
            const callbacksCount = this.timeoutCallbacks.count();
            assert.equal(callbacksCount, expected, `expected ${expected} timeout callbacks queued but found ${callbacksCount}.`);
        }

        runQueuedTimeoutCallbacks() {
            try {
                this.timeoutCallbacks.invoke();
            }
            catch (e) {
                if (e.message === this.existMessage) {
                    return;
                }
                throw e;
            }
        }

        runQueuedImmediateCallbacks() {
            this.immediateCallbacks.invoke();
        }

        setImmediate(callback: TimeOutCallback, _time: number, ...args: any[]) {
            return this.immediateCallbacks.register(callback, args);
        }

        clearImmediate(timeoutId: any): void {
            this.immediateCallbacks.unregister(timeoutId);
        }

        createDirectory(directoryName: string): void {
            const folder = this.toFolder(directoryName);

            // base folder has to be present
            const base = getDirectoryPath(folder.fullPath);
            const baseFolder = this.fs.get(base) as Folder;
            Debug.assert(isFolder(baseFolder));

            Debug.assert(!this.fs.get(folder.path));
            this.addFileOrFolderInFolder(baseFolder, folder);
        }

        writeFile(path: string, content: string): void {
            const file = this.toFile({ path, content });

            // base folder has to be present
            const base = getDirectoryPath(file.fullPath);
            const folder = this.fs.get(base) as Folder;
            Debug.assert(isFolder(folder));

            this.addFileOrFolderInFolder(folder, file);
        }

        write(message: string) {
            this.output.push(message);
        }

        getOutput(): ReadonlyArray<string> {
            return this.output;
        }

        clearOutput() {
            clear(this.output);
        }

        readonly existMessage = "System Exit";
        exitCode: number;
        readonly resolvePath = (s: string) => s;
        readonly getExecutingFilePath = () => this.executingFilePath;
        readonly getCurrentDirectory = () => this.currentDirectory;
        exit(exitCode?: number) {
            this.exitCode = exitCode;
            throw new Error(this.existMessage);
        }
        readonly getEnvironmentVariable = notImplemented;
    }
}
