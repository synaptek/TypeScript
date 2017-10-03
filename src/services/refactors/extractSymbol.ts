/// <reference path="../refactorProvider.ts" />
/// <reference path="../../compiler/checker.ts" />

/* @internal */
namespace ts.refactor.extractSymbol {
    const extractSymbol: Refactor = {
        name: "Extract Symbol",
        description: Diagnostics.Extract_symbol.message,
        getAvailableActions,
        getEditsForAction,
    };

    registerRefactor(extractSymbol);

    /**
     * Compute the associated code actions
     * Exported for tests.
     */
    export function getAvailableActions(context: RefactorContext): ApplicableRefactorInfo[] | undefined {
        const rangeToExtract = getRangeToExtract(context.file, { start: context.startPosition, length: getRefactorContextLength(context) });

        const targetRange: TargetRange = rangeToExtract.targetRange;
        if (targetRange === undefined) {
            return undefined;
        }

        const extractions = getPossibleExtractions(targetRange, context);
        if (extractions === undefined) {
            // No extractions possible
            return undefined;
        }

        const functionActions: RefactorActionInfo[] = [];
        const usedFunctionNames: Map<boolean> = createMap();

        const constantActions: RefactorActionInfo[] = [];
        const usedConstantNames: Map<boolean> = createMap();

        let i = 0;
        for (const {functionExtraction, constantExtraction} of extractions) {
            // Skip these since we don't have a way to report errors yet
            if (functionExtraction.errors.length === 0) {
                // Don't issue refactorings with duplicated names.
                // Scopes come back in "innermost first" order, so extractions will
                // preferentially go into nearer scopes
                const description = formatStringFromArgs(Diagnostics.Extract_to_0_in_1.message, [functionExtraction.description, functionExtraction.scopeDescription]);
                if (!usedFunctionNames.has(description)) {
                    usedFunctionNames.set(description, true);
                    functionActions.push({
                        description,
                        name: `function_scope_${i}`
                    });
                }
            }

            // Skip these since we don't have a way to report errors yet
            if (constantExtraction.errors.length === 0) {
                // Don't issue refactorings with duplicated names.
                // Scopes come back in "innermost first" order, so extractions will
                // preferentially go into nearer scopes
                const description = formatStringFromArgs(Diagnostics.Extract_to_0_in_1.message, [constantExtraction.description, constantExtraction.scopeDescription]);
                if (!usedConstantNames.has(description)) {
                    usedConstantNames.set(description, true);
                    constantActions.push({
                        description,
                        name: `constant_scope_${i}`
                    });
                }
            }

            // *do* increment i anyway because we'll look for the i-th scope
            // later when actually doing the refactoring if the user requests it
            i++;
        }

        const infos: ApplicableRefactorInfo[] = [];

        if (functionActions.length) {
            infos.push({
                name: extractSymbol.name,
                description: Diagnostics.Extract_function.message,
                actions: functionActions
            });
        }

        if (constantActions.length) {
            infos.push({
                name: extractSymbol.name,
                description: Diagnostics.Extract_constant.message,
                actions: constantActions
            });
        }

        return infos.length ? infos : undefined;
    }

    /* Exported for tests */
    export function getEditsForAction(context: RefactorContext, actionName: string): RefactorEditInfo | undefined {
        const rangeToExtract = getRangeToExtract(context.file, { start: context.startPosition, length: getRefactorContextLength(context) });
        const targetRange: TargetRange = rangeToExtract.targetRange;

        const parsedFunctionIndexMatch = /^function_scope_(\d+)$/.exec(actionName);
        if (parsedFunctionIndexMatch) {
            const index = +parsedFunctionIndexMatch[1];
            Debug.assert(isFinite(index), "Expected to parse a finite number from the function scope index");
            return getFunctionExtractionAtIndex(targetRange, context, index);
        }

        const parsedConstantIndexMatch = /^constant_scope_(\d+)$/.exec(actionName);
        if (parsedConstantIndexMatch) {
            const index = +parsedConstantIndexMatch[1];
            Debug.assert(isFinite(index), "Expected to parse a finite number from the constant scope index");
            return getConstantExtractionAtIndex(targetRange, context, index);
        }

        Debug.fail("Unrecognized action name");
    }

    // Move these into diagnostic messages if they become user-facing
    export namespace Messages {
        function createMessage(message: string): DiagnosticMessage {
            return { message, code: 0, category: DiagnosticCategory.Message, key: message };
        }

        export const CannotExtractRange: DiagnosticMessage = createMessage("Cannot extract range.");
        export const CannotExtractImport: DiagnosticMessage = createMessage("Cannot extract import statement.");
        export const CannotExtractSuper: DiagnosticMessage = createMessage("Cannot extract super call.");
        export const CannotExtractEmpty: DiagnosticMessage = createMessage("Cannot extract empty range.");
        export const ExpressionExpected: DiagnosticMessage = createMessage("expression expected.");
        export const StatementOrExpressionExpected: DiagnosticMessage = createMessage("Statement or expression expected.");
        export const CannotExtractRangeContainingConditionalBreakOrContinueStatements: DiagnosticMessage = createMessage("Cannot extract range containing conditional break or continue statements.");
        export const CannotExtractRangeContainingConditionalReturnStatement: DiagnosticMessage = createMessage("Cannot extract range containing conditional return statement.");
        export const CannotExtractRangeContainingLabeledBreakOrContinueStatementWithTargetOutsideOfTheRange: DiagnosticMessage = createMessage("Cannot extract range containing labeled break or continue with target outside of the range.");
        export const CannotExtractRangeThatContainsWritesToReferencesLocatedOutsideOfTheTargetRangeInGenerators: DiagnosticMessage = createMessage("Cannot extract range containing writes to references located outside of the target range in generators.");
        export const TypeWillNotBeVisibleInTheNewScope = createMessage("Type will not visible in the new scope.");
        export const FunctionWillNotBeVisibleInTheNewScope = createMessage("Function will not visible in the new scope.");
        export const CannotExtractIdentifier = createMessage("Select more than a single identifier.");
        export const CannotExtractExportedEntity = createMessage("Cannot extract exported declaration");
        export const CannotCombineWritesAndReturns = createMessage("Cannot combine writes and returns");
        export const CannotExtractReadonlyPropertyInitializerOutsideConstructor = createMessage("Cannot move initialization of read-only class property outside of the constructor");
        export const CannotExtractAmbientBlock = createMessage("Cannot extract code from ambient contexts");
        export const CannotAccessVariablesFromNestedScopes = createMessage("Cannot access variables from nested scopes");
        export const CannotExtractToOtherFunctionLike = createMessage("Cannot extract method to a function-like scope that is not a function");
        export const CannotExtractToJSClass = createMessage("Cannot extract constant to a class scope in JS");
        export const CannotExtractToExpressionArrowFunction = createMessage("Cannot extract constant to an arrow function without a block");
    }

    enum RangeFacts {
        None = 0,
        HasReturn = 1 << 0,
        IsGenerator = 1 << 1,
        IsAsyncFunction = 1 << 2,
        UsesThis = 1 << 3,
        /**
         * The range is in a function which needs the 'static' modifier in a class
         */
        InStaticRegion = 1 << 4
    }

    /**
     * Represents an expression or a list of statements that should be extracted with some extra information
     */
    interface TargetRange {
        readonly range: Expression | Statement[];
        readonly facts: RangeFacts;
        /**
         * A list of symbols that are declared in the selected range which are visible in the containing lexical scope
         * Used to ensure we don't turn something used outside the range free (or worse, resolve to a different entity).
         */
        readonly declarations: Symbol[];
    }

    /**
     * Result of 'getRangeToExtract' operation: contains either a range or a list of errors
     */
    type RangeToExtract = {
        readonly targetRange?: never;
        readonly errors: ReadonlyArray<Diagnostic>;
    } | {
            readonly targetRange: TargetRange;
            readonly errors?: never;
        };

    /*
     * Scopes that can store newly extracted method
     */
    type Scope = FunctionLikeDeclaration | SourceFile | ModuleBlock | ClassLikeDeclaration;

    /**
     * getRangeToExtract takes a span inside a text file and returns either an expression or an array
     * of statements representing the minimum set of nodes needed to extract the entire span. This
     * process may fail, in which case a set of errors is returned instead (these are currently
     * not shown to the user, but can be used by us diagnostically)
     */
    // exported only for tests
    export function getRangeToExtract(sourceFile: SourceFile, span: TextSpan): RangeToExtract {
        const { length } = span;

        if (length === 0) {
            return { errors: [createFileDiagnostic(sourceFile, span.start, length, Messages.CannotExtractEmpty)] };
        }

        // Walk up starting from the the start position until we find a non-SourceFile node that subsumes the selected span.
        // This may fail (e.g. you select two statements in the root of a source file)
        const start = getParentNodeInSpan(getTokenAtPosition(sourceFile, span.start, /*includeJsDocComment*/ false), sourceFile, span);
        // Do the same for the ending position
        const end = getParentNodeInSpan(findTokenOnLeftOfPosition(sourceFile, textSpanEnd(span)), sourceFile, span);

        const declarations: Symbol[] = [];

        // We'll modify these flags as we walk the tree to collect data
        // about what things need to be done as part of the extraction.
        let rangeFacts = RangeFacts.None;

        if (!start || !end) {
            // cannot find either start or end node
            return { errors: [createFileDiagnostic(sourceFile, span.start, length, Messages.CannotExtractRange)] };
        }

        if (start.parent !== end.parent) {
            // start and end nodes belong to different subtrees
            return { errors: [createFileDiagnostic(sourceFile, span.start, length, Messages.CannotExtractRange)] };
        }

        if (start !== end) {
            // start and end should be statements and parent should be either block or a source file
            if (!isBlockLike(start.parent)) {
                return { errors: [createFileDiagnostic(sourceFile, span.start, length, Messages.CannotExtractRange)] };
            }
            const statements: Statement[] = [];
            for (const statement of (<BlockLike>start.parent).statements) {
                if (statement === start || statements.length) {
                    const errors = checkNode(statement);
                    if (errors) {
                        return { errors };
                    }
                    statements.push(statement);
                }
                if (statement === end) {
                    break;
                }
            }
            return { targetRange: { range: statements, facts: rangeFacts, declarations } };
        }

        // We have a single node (start)
        const errors = checkRootNode(start) || checkNode(start);
        if (errors) {
            return { errors };
        }
        return { targetRange: { range: getStatementOrExpressionRange(start), facts: rangeFacts, declarations } };

        function checkRootNode(node: Node): Diagnostic[] | undefined {
            if (isIdentifier(isExpressionStatement(node) ? node.expression : node)) {
                return [createDiagnosticForNode(node, Messages.CannotExtractIdentifier)];
            }
            return undefined;
        }

        function checkForStaticContext(nodeToCheck: Node, containingClass: Node) {
            let current: Node = nodeToCheck;
            while (current !== containingClass) {
                if (current.kind === SyntaxKind.PropertyDeclaration) {
                    if (hasModifier(current, ModifierFlags.Static)) {
                        rangeFacts |= RangeFacts.InStaticRegion;
                    }
                    break;
                }
                else if (current.kind === SyntaxKind.Parameter) {
                    const ctorOrMethod = getContainingFunction(current);
                    if (ctorOrMethod.kind === SyntaxKind.Constructor) {
                        rangeFacts |= RangeFacts.InStaticRegion;
                    }
                    break;
                }
                else if (current.kind === SyntaxKind.MethodDeclaration) {
                    if (hasModifier(current, ModifierFlags.Static)) {
                        rangeFacts |= RangeFacts.InStaticRegion;
                    }
                }
                current = current.parent;
            }
        }

        // Verifies whether we can actually extract this node or not.
        function checkNode(nodeToCheck: Node): Diagnostic[] | undefined {
            const enum PermittedJumps {
                None = 0,
                Break = 1 << 0,
                Continue = 1 << 1,
                Return = 1 << 2
            }
            if (!isStatement(nodeToCheck) && !(isPartOfExpression(nodeToCheck) && isExtractableExpression(nodeToCheck))) {
                return [createDiagnosticForNode(nodeToCheck, Messages.StatementOrExpressionExpected)];
            }

            if (isInAmbientContext(nodeToCheck)) {
                return [createDiagnosticForNode(nodeToCheck, Messages.CannotExtractAmbientBlock)];
            }

            // If we're in a class, see whether we're in a static region (static property initializer, static method, class constructor parameter default)
            const containingClass: Node = getContainingClass(nodeToCheck);
            if (containingClass) {
                checkForStaticContext(nodeToCheck, containingClass);
            }

            let errors: Diagnostic[];
            let permittedJumps = PermittedJumps.Return;
            let seenLabels: __String[];

            visit(nodeToCheck);

            return errors;

            function visit(node: Node) {
                if (errors) {
                    // already found an error - can stop now
                    return true;
                }

                if (isDeclaration(node)) {
                    const declaringNode = (node.kind === SyntaxKind.VariableDeclaration) ? node.parent.parent : node;
                    if (hasModifier(declaringNode, ModifierFlags.Export)) {
                        (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.CannotExtractExportedEntity));
                        return true;
                    }
                    declarations.push(node.symbol);
                }

                // Some things can't be extracted in certain situations
                switch (node.kind) {
                    case SyntaxKind.ImportDeclaration:
                        (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.CannotExtractImport));
                        return true;
                    case SyntaxKind.SuperKeyword:
                        // For a super *constructor call*, we have to be extracting the entire class,
                        // but a super *method call* simply implies a 'this' reference
                        if (node.parent.kind === SyntaxKind.CallExpression) {
                            // Super constructor call
                            const containingClass = getContainingClass(node);
                            if (containingClass.pos < span.start || containingClass.end >= (span.start + span.length)) {
                                (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.CannotExtractSuper));
                                return true;
                            }
                        }
                        else {
                            rangeFacts |= RangeFacts.UsesThis;
                        }
                        break;
                }

                if (!node || isFunctionLikeDeclaration(node) || isClassLike(node)) {
                    switch (node.kind) {
                        case SyntaxKind.FunctionDeclaration:
                        case SyntaxKind.ClassDeclaration:
                            if (node.parent.kind === SyntaxKind.SourceFile && (node.parent as ts.SourceFile).externalModuleIndicator === undefined) {
                                // You cannot extract global declarations
                                (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.FunctionWillNotBeVisibleInTheNewScope));
                            }
                            break;
                    }

                    // do not dive into functions or classes
                    return false;
                }
                const savedPermittedJumps = permittedJumps;

                switch (node.kind) {
                    case SyntaxKind.IfStatement:
                        permittedJumps = PermittedJumps.None;
                        break;
                    case SyntaxKind.TryStatement:
                        // forbid all jumps inside try blocks
                        permittedJumps = PermittedJumps.None;
                        break;
                    case SyntaxKind.Block:
                        if (node.parent && node.parent.kind === SyntaxKind.TryStatement && (<TryStatement>node).finallyBlock === node) {
                            // allow unconditional returns from finally blocks
                            permittedJumps = PermittedJumps.Return;
                        }
                        break;
                    case SyntaxKind.CaseClause:
                        // allow unlabeled break inside case clauses
                        permittedJumps |= PermittedJumps.Break;
                        break;
                    default:
                        if (isIterationStatement(node, /*lookInLabeledStatements*/ false)) {
                            // allow unlabeled break/continue inside loops
                            permittedJumps |= PermittedJumps.Break | PermittedJumps.Continue;
                        }
                        break;
                }

                switch (node.kind) {
                    case SyntaxKind.ThisType:
                    case SyntaxKind.ThisKeyword:
                        rangeFacts |= RangeFacts.UsesThis;
                        break;
                    case SyntaxKind.LabeledStatement:
                        {
                            const label = (<LabeledStatement>node).label;
                            (seenLabels || (seenLabels = [])).push(label.escapedText);
                            forEachChild(node, visit);
                            seenLabels.pop();
                            break;
                        }
                    case SyntaxKind.BreakStatement:
                    case SyntaxKind.ContinueStatement:
                        {
                            const label = (<BreakStatement | ContinueStatement>node).label;
                            if (label) {
                                if (!contains(seenLabels, label.escapedText)) {
                                    // attempts to jump to label that is not in range to be extracted
                                    (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.CannotExtractRangeContainingLabeledBreakOrContinueStatementWithTargetOutsideOfTheRange));
                                }
                            }
                            else {
                                if (!(permittedJumps & (node.kind === SyntaxKind.BreakStatement ? PermittedJumps.Break : PermittedJumps.Continue))) {
                                    // attempt to break or continue in a forbidden context
                                    (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.CannotExtractRangeContainingConditionalBreakOrContinueStatements));
                                }
                            }
                            break;
                        }
                    case SyntaxKind.AwaitExpression:
                        rangeFacts |= RangeFacts.IsAsyncFunction;
                        break;
                    case SyntaxKind.YieldExpression:
                        rangeFacts |= RangeFacts.IsGenerator;
                        break;
                    case SyntaxKind.ReturnStatement:
                        if (permittedJumps & PermittedJumps.Return) {
                            rangeFacts |= RangeFacts.HasReturn;
                        }
                        else {
                            (errors || (errors = [])).push(createDiagnosticForNode(node, Messages.CannotExtractRangeContainingConditionalReturnStatement));
                        }
                        break;
                    default:
                        forEachChild(node, visit);
                        break;
                }

                permittedJumps = savedPermittedJumps;
            }
        }
    }

    function getStatementOrExpressionRange(node: Node): Statement[] | Expression {
        if (isStatement(node)) {
            return [node];
        }
        else if (isPartOfExpression(node)) {
            // If our selection is the expression in an ExpressionStatement, expand
            // the selection to include the enclosing Statement (this stops us
            // from trying to care about the return value of the extracted function
            // and eliminates double semicolon insertion in certain scenarios)
            return isExpressionStatement(node.parent) ? [node.parent] : node as Expression;
        }
        return undefined;
    }

    function isScope(node: Node): node is Scope {
        return isFunctionLikeDeclaration(node) || isSourceFile(node) || isModuleBlock(node) || isClassLike(node);
    }

    /**
     * Computes possible places we could extract the function into. For example,
     * you may be able to extract into a class method *or* local closure *or* namespace function,
     * depending on what's in the extracted body.
     */
    function collectEnclosingScopes(range: TargetRange): Scope[] | undefined {
        let current: Node = isReadonlyArray(range.range) ? first(range.range) : range.range;
        if (range.facts & RangeFacts.UsesThis) {
            // if range uses this as keyword or as type inside the class then it can only be extracted to a method of the containing class
            const containingClass = getContainingClass(current);
            if (containingClass) {
                return [containingClass];
            }
        }

        const start = current;

        let scopes: Scope[] | undefined = undefined;
        while (current) {
            // We want to find the nearest parent where we can place an "equivalent" sibling to the node we're extracting out of.
            // Walk up to the closest parent of a place where we can logically put a sibling:
            //  * Function declaration
            //  * Class declaration or expression
            //  * Module/namespace or source file
            if (current !== start && isScope(current)) {
                (scopes = scopes || []).push(current);
            }

            // A function parameter's initializer is actually in the outer scope, not the function declaration
            if (current && current.parent && current.parent.kind === SyntaxKind.Parameter) {
                // Skip all the way to the outer scope of the function that declared this parameter
                current = findAncestor(current, parent => isFunctionLikeDeclaration(parent)).parent;
            }
            else {
                current = current.parent;
            }

        }
        return scopes;
    }

    function getFunctionExtractionAtIndex(targetRange: TargetRange, context: RefactorContext, requestedChangesIndex: number): RefactorEditInfo {
        const { scopes, readsAndWrites: { target, usagesPerScope, functionErrorsPerScope } } = getPossibleExtractionsWorker(targetRange, context);
        Debug.assert(!functionErrorsPerScope[requestedChangesIndex].length, "The extraction went missing? How?");
        context.cancellationToken.throwIfCancellationRequested();
        return extractFunctionInScope(target, scopes[requestedChangesIndex], usagesPerScope[requestedChangesIndex], targetRange, context);
    }

    function getConstantExtractionAtIndex(targetRange: TargetRange, context: RefactorContext, requestedChangesIndex: number): RefactorEditInfo {
        const { scopes, readsAndWrites: { target, usagesPerScope, constantErrorsPerScope } } = getPossibleExtractionsWorker(targetRange, context);
        Debug.assert(!constantErrorsPerScope[requestedChangesIndex].length, "The extraction went missing? How?");
        context.cancellationToken.throwIfCancellationRequested();
        const expression = isExpression(target)
            ? target
            : (target.statements[0] as ExpressionStatement).expression;
        return extractConstantInScope(expression, scopes[requestedChangesIndex], usagesPerScope[requestedChangesIndex], targetRange.facts, context);
    }

    interface Extraction {
        readonly description: string;
        readonly scopeDescription: string;
        readonly errors: ReadonlyArray<Diagnostic>;
    }

    interface ScopeExtractions {
        readonly functionExtraction: Extraction;
        readonly constantExtraction: Extraction;
    }

    /**
     * Given a piece of text to extract ('targetRange'), computes a list of possible extractions.
     * Each returned ExtractResultForScope corresponds to a possible target scope and is either a set of changes
     * or an error explaining why we can't extract into that scope.
     */
    function getPossibleExtractions(targetRange: TargetRange, context: RefactorContext): ReadonlyArray<ScopeExtractions> | undefined {
        const { scopes, readsAndWrites: { functionErrorsPerScope, constantErrorsPerScope } } = getPossibleExtractionsWorker(targetRange, context);
        // Need the inner type annotation to avoid https://github.com/Microsoft/TypeScript/issues/7547
        const extractions = scopes.map((scope, i): ScopeExtractions => {
            const scopeDescription = isFunctionLikeDeclaration(scope)
                ? getDescriptionForFunctionLikeDeclaration(scope)
                : isClassLike(scope)
                    ? getDescriptionForClassLikeDeclaration(scope)
                    : getDescriptionForModuleLikeDeclaration(scope);
            return {
                functionExtraction: {
                    description: getDescriptionForFunctionInScope(scope),
                    errors: functionErrorsPerScope[i],
                    scopeDescription,
                },
                constantExtraction: {
                    description: getDescriptionForConstantInScope(scope),
                    errors: constantErrorsPerScope[i],
                    scopeDescription: (i === 0 && !isClassLike(scope))
                        ? "enclosing scope" // Like "global scope" and "module scope", this is not localized.
                        : scopeDescription,
                },
            };
        });
        return extractions;
    }

    function getPossibleExtractionsWorker(targetRange: TargetRange, context: RefactorContext): { readonly scopes: Scope[], readonly readsAndWrites: ReadsAndWrites } {
        const { file: sourceFile } = context;

        if (targetRange === undefined) {
            return undefined;
        }

        const scopes = collectEnclosingScopes(targetRange);
        if (scopes === undefined) {
            return undefined;
        }

        const enclosingTextRange = getEnclosingTextRange(targetRange, sourceFile);
        const readsAndWrites = collectReadsAndWrites(
            targetRange,
            scopes,
            enclosingTextRange,
            sourceFile,
            context.program.getTypeChecker(),
            context.cancellationToken);
        return { scopes, readsAndWrites };
    }

    function getDescriptionForFunctionInScope(scope: Scope): string {
        return isFunctionLikeDeclaration(scope)
            ? "inner function"
            : isClassLike(scope)
                ? "method"
                : "function";
    }
    function getDescriptionForConstantInScope(scope: Scope): string {
        return isClassLike(scope)
            ? "readonly field"
            : "constant";
    }
    function getDescriptionForFunctionLikeDeclaration(scope: FunctionLikeDeclaration): string {
        switch (scope.kind) {
            case SyntaxKind.Constructor:
                return "constructor";
            case SyntaxKind.FunctionExpression:
                return scope.name
                    ? `function expression '${scope.name.text}'`
                    : "anonymous function expression";
            case SyntaxKind.FunctionDeclaration:
                return `function '${scope.name.text}'`;
            case SyntaxKind.ArrowFunction:
                return "arrow function";
            case SyntaxKind.MethodDeclaration:
                return `method '${scope.name.getText()}`;
            case SyntaxKind.GetAccessor:
                return `'get ${scope.name.getText()}'`;
            case SyntaxKind.SetAccessor:
                return `'set ${scope.name.getText()}'`;
            default:
                Debug.assertNever(scope);
        }
    }
    function getDescriptionForClassLikeDeclaration(scope: ClassLikeDeclaration): string {
        return scope.kind === SyntaxKind.ClassDeclaration
            ? `class '${scope.name.text}'`
            : scope.name ? `class expression '${scope.name.text}'` : "anonymous class expression";
    }
    function getDescriptionForModuleLikeDeclaration(scope: SourceFile | ModuleBlock): string {
        return scope.kind === SyntaxKind.ModuleBlock
            ? `namespace '${scope.parent.name.getText()}'`
            : scope.externalModuleIndicator ? "module scope" : "global scope";
    }

    function getUniqueName(baseName: string, fileText: string): string {
        let nameText = baseName;
        for (let i = 1; fileText.indexOf(nameText) !== -1; i++) {
            nameText = `${baseName}_${i}`;
        }
        return nameText;
    }

    /**
     * Result of 'extractRange' operation for a specific scope.
     * Stores either a list of changes that should be applied to extract a range or a list of errors
     */
    function extractFunctionInScope(
        node: Statement | Expression | Block,
        scope: Scope,
        { usages: usagesInScope, typeParameterUsages, substitutions }: ScopeUsages,
        range: TargetRange,
        context: RefactorContext): RefactorEditInfo {

        const checker = context.program.getTypeChecker();

        // Make a unique name for the extracted function
        const file = scope.getSourceFile();
        const functionNameText = getUniqueName(isClassLike(scope) ? "newMethod" : "newFunction", file.text);
        const isJS = isInJavaScriptFile(scope);

        const functionName = createIdentifier(functionNameText);

        let returnType: TypeNode = undefined;
        const parameters: ParameterDeclaration[] = [];
        const callArguments: Identifier[] = [];
        let writes: UsageEntry[];
        usagesInScope.forEach((usage, name) => {
            let typeNode: TypeNode = undefined;
            if (!isJS) {
                let type = checker.getTypeOfSymbolAtLocation(usage.symbol, usage.node);
                // Widen the type so we don't emit nonsense annotations like "function fn(x: 3) {"
                type = checker.getBaseTypeOfLiteralType(type);
                typeNode = checker.typeToTypeNode(type, node, NodeBuilderFlags.NoTruncation);
            }

            const paramDecl = createParameter(
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                /*dotDotDotToken*/ undefined,
                /*name*/ name,
                /*questionToken*/ undefined,
                typeNode
            );
            parameters.push(paramDecl);
            if (usage.usage === Usage.Write) {
                (writes || (writes = [])).push(usage);
            }
            callArguments.push(createIdentifier(name));
        });

        const typeParametersAndDeclarations = arrayFrom(typeParameterUsages.values()).map(type => ({ type, declaration: getFirstDeclaration(type) }));
        const sortedTypeParametersAndDeclarations = typeParametersAndDeclarations.sort(compareTypesByDeclarationOrder);

        const typeParameters: ReadonlyArray<TypeParameterDeclaration> | undefined = sortedTypeParametersAndDeclarations.length === 0
            ? undefined
            : sortedTypeParametersAndDeclarations.map(t => t.declaration as TypeParameterDeclaration);

        // Strictly speaking, we should check whether each name actually binds to the appropriate type
        // parameter.  In cases of shadowing, they may not.
        const callTypeArguments: ReadonlyArray<TypeNode> | undefined = typeParameters !== undefined
            ? typeParameters.map(decl => createTypeReferenceNode(decl.name, /*typeArguments*/ undefined))
            : undefined;

        // Provide explicit return types for contextually-typed functions
        // to avoid problems when there are literal types present
        if (isExpression(node) && !isJS) {
            const contextualType = checker.getContextualType(node);
            returnType = checker.typeToTypeNode(contextualType);
        }

        const { body, returnValueProperty } = transformFunctionBody(node, writes, substitutions, !!(range.facts & RangeFacts.HasReturn));
        let newFunction: MethodDeclaration | FunctionDeclaration;

        if (isClassLike(scope)) {
            // always create private method in TypeScript files
            const modifiers: Modifier[] = isJS ? [] : [createToken(SyntaxKind.PrivateKeyword)];
            if (range.facts & RangeFacts.InStaticRegion) {
                modifiers.push(createToken(SyntaxKind.StaticKeyword));
            }
            if (range.facts & RangeFacts.IsAsyncFunction) {
                modifiers.push(createToken(SyntaxKind.AsyncKeyword));
            }
            newFunction = createMethod(
                /*decorators*/ undefined,
                modifiers.length ? modifiers : undefined,
                range.facts & RangeFacts.IsGenerator ? createToken(SyntaxKind.AsteriskToken) : undefined,
                functionName,
                /*questionToken*/ undefined,
                typeParameters,
                parameters,
                returnType,
                body
            );
        }
        else {
            newFunction = createFunctionDeclaration(
                /*decorators*/ undefined,
                range.facts & RangeFacts.IsAsyncFunction ? [createToken(SyntaxKind.AsyncKeyword)] : undefined,
                range.facts & RangeFacts.IsGenerator ? createToken(SyntaxKind.AsteriskToken) : undefined,
                functionName,
                typeParameters,
                parameters,
                returnType,
                body
            );
        }

        const changeTracker = textChanges.ChangeTracker.fromContext(context);
        const minInsertionPos = (isReadonlyArray(range.range) ? last(range.range) : range.range).end;
        const nodeToInsertBefore = getNodeToInsertFunctionBefore(minInsertionPos, scope);
        if (nodeToInsertBefore) {
            changeTracker.insertNodeBefore(context.file, nodeToInsertBefore, newFunction, { suffix: context.newLineCharacter + context.newLineCharacter });
        }
        else {
            changeTracker.insertNodeBefore(context.file, scope.getLastToken(), newFunction, { prefix: context.newLineCharacter, suffix: context.newLineCharacter });
        }

        const newNodes: Node[] = [];
        // replace range with function call
        const called = getCalledExpression(scope, range, functionNameText);

        let call: Expression = createCall(
            called,
            callTypeArguments, // Note that no attempt is made to take advantage of type argument inference
            callArguments);
        if (range.facts & RangeFacts.IsGenerator) {
            call = createYield(createToken(SyntaxKind.AsteriskToken), call);
        }
        if (range.facts & RangeFacts.IsAsyncFunction) {
            call = createAwait(call);
        }

        if (writes) {
            if (returnValueProperty) {
                // has both writes and return, need to create variable declaration to hold return value;
                newNodes.push(createVariableStatement(
                    /*modifiers*/ undefined,
                    [createVariableDeclaration(returnValueProperty, createKeywordTypeNode(SyntaxKind.AnyKeyword))]
                ));
            }

            const assignments = getPropertyAssignmentsForWrites(writes);
            if (returnValueProperty) {
                assignments.unshift(createShorthandPropertyAssignment(returnValueProperty));
            }

            // propagate writes back
            if (assignments.length === 1) {
                if (returnValueProperty) {
                    newNodes.push(createReturn(createIdentifier(returnValueProperty)));
                }
                else {
                    newNodes.push(createStatement(createBinary(assignments[0].name, SyntaxKind.EqualsToken, call)));

                    if (range.facts & RangeFacts.HasReturn) {
                        newNodes.push(createReturn());
                    }
                }
            }
            else {
                // emit e.g.
                //   { a, b, __return } = newFunction(a, b);
                //   return __return;
                newNodes.push(createStatement(createBinary(createObjectLiteral(assignments), SyntaxKind.EqualsToken, call)));
                if (returnValueProperty) {
                    newNodes.push(createReturn(createIdentifier(returnValueProperty)));
                }
            }
        }
        else {
            if (range.facts & RangeFacts.HasReturn) {
                newNodes.push(createReturn(call));
            }
            else if (isReadonlyArray(range.range)) {
                newNodes.push(createStatement(call));
            }
            else {
                newNodes.push(call);
            }
        }

        if (isReadonlyArray(range.range)) {
            changeTracker.replaceNodesWithNodes(context.file, range.range, newNodes, {
                nodeSeparator: context.newLineCharacter,
                suffix: context.newLineCharacter // insert newline only when replacing statements
            });
        }
        else {
            changeTracker.replaceNodeWithNodes(context.file, range.range, newNodes, { nodeSeparator: context.newLineCharacter });
        }

        const edits = changeTracker.getChanges();
        const renameRange = isReadonlyArray(range.range) ? first(range.range) : range.range;

        const renameFilename = renameRange.getSourceFile().fileName;
        const renameLocation = getRenameLocation(edits, renameFilename, functionNameText, /*isDeclaredBeforeUse*/ false);
        return { renameFilename, renameLocation, edits };
    }

    /**
     * Result of 'extractRange' operation for a specific scope.
     * Stores either a list of changes that should be applied to extract a range or a list of errors
     */
    function extractConstantInScope(
        node: Expression,
        scope: Scope,
        { substitutions }: ScopeUsages,
        rangeFacts: RangeFacts,
        context: RefactorContext): RefactorEditInfo {

        const checker = context.program.getTypeChecker();

        // Make a unique name for the extracted variable
        const file = scope.getSourceFile();
        const localNameText = getUniqueName(isClassLike(scope) ? "newProperty" : "newLocal", file.text);
        const isJS = isInJavaScriptFile(scope);

        const variableType = isJS
            ? undefined
            : checker.typeToTypeNode(checker.getContextualType(node));

        const initializer = transformConstantInitializer(node, substitutions);

        const changeTracker = textChanges.ChangeTracker.fromContext(context);

        if (isClassLike(scope)) {
            Debug.assert(!isJS); // See CannotExtractToJSClass
            const modifiers: Modifier[] = [];
            modifiers.push(createToken(SyntaxKind.PrivateKeyword));
            if (rangeFacts & RangeFacts.InStaticRegion) {
                modifiers.push(createToken(SyntaxKind.StaticKeyword));
            }
            modifiers.push(createToken(SyntaxKind.ReadonlyKeyword));

            const newVariable = createProperty(
                /*decorators*/ undefined,
                modifiers,
                localNameText,
                /*questionToken*/ undefined,
                variableType,
                initializer);

            const localReference = createPropertyAccess(
                rangeFacts & RangeFacts.InStaticRegion
                    ? createIdentifier(scope.name.getText())
                    : createThis(),
                createIdentifier(localNameText));

            // Declare
            const maxInsertionPos = node.pos;
            const nodeToInsertBefore = getNodeToInsertPropertyBefore(maxInsertionPos, scope);
            changeTracker.insertNodeBefore(context.file, nodeToInsertBefore, newVariable, { suffix: context.newLineCharacter + context.newLineCharacter });

            // Consume
            changeTracker.replaceNodeWithNodes(context.file, node, [localReference], { nodeSeparator: context.newLineCharacter });
        }
        else {
            const newVariableDeclaration = createVariableDeclaration(localNameText, variableType, initializer);

            // If the node is part of an initializer in a list of variable declarations, insert a new
            // variable declaration into the list (in case it depends on earlier ones).
            // CONSIDER: If the declaration list isn't const, we might want to split it into multiple
            // lists so that the newly extracted one can be const.
            const oldVariableDeclaration = getContainingVariableDeclarationIfInList(node, scope);
            if (oldVariableDeclaration) {
                // Declare
                // CONSIDER: could detect that each is on a separate line
                changeTracker.insertNodeAt(context.file, oldVariableDeclaration.getStart(), newVariableDeclaration, { suffix: ", " });

                // Consume
                const localReference = createIdentifier(localNameText);
                changeTracker.replaceRange(context.file, { pos: node.getStart(), end: node.end }, localReference);
            }
            else if (node.parent.kind === SyntaxKind.ExpressionStatement && scope === findAncestor(node, isScope)) {
                // If the parent is an expression statement and the target scope is the immediately enclosing one,
                // replace the statement with the declaration.
                const newVariableStatement = createVariableStatement(
                    /*modifiers*/ undefined,
                    createVariableDeclarationList([newVariableDeclaration], NodeFlags.Const));
                changeTracker.replaceRange(context.file, { pos: node.parent.getStart(), end: node.parent.end }, newVariableStatement);
            }
            else {
                const newVariableStatement = createVariableStatement(
                    /*modifiers*/ undefined,
                    createVariableDeclarationList([newVariableDeclaration], NodeFlags.Const));

                // Declare
                const nodeToInsertBefore = getNodeToInsertConstantBefore(node, scope);
                if (nodeToInsertBefore.pos === 0) {
                    // If we're at the beginning of the file, we need to take care not to insert before header comments
                    // (e.g. copyright, triple-slash references).  Fortunately, this problem has already been solved
                    // for imports.
                    const insertionPos = getSourceFileImportLocation(file);
                    changeTracker.insertNodeAt(context.file, insertionPos, newVariableStatement, {
                        prefix: insertionPos === 0 ? undefined : context.newLineCharacter,
                        suffix: isLineBreak(file.text.charCodeAt(insertionPos)) ? context.newLineCharacter : context.newLineCharacter + context.newLineCharacter
                    });
                }
                else {
                    changeTracker.insertNodeBefore(context.file, nodeToInsertBefore, newVariableStatement, { suffix: context.newLineCharacter + context.newLineCharacter });
                }

                // Consume
                if (node.parent.kind === SyntaxKind.ExpressionStatement) {
                    // If the parent is an expression statement, delete it.
                    changeTracker.deleteRange(context.file, { pos: node.parent.getStart(), end: node.parent.end });
                }
                else {
                    const localReference = createIdentifier(localNameText);
                    changeTracker.replaceRange(context.file, { pos: node.getStart(), end: node.end }, localReference);
                }
            }
        }

        const edits = changeTracker.getChanges();

        const renameFilename = node.getSourceFile().fileName;
        const renameLocation = getRenameLocation(edits, renameFilename, localNameText, /*isDeclaredBeforeUse*/ true);
        return { renameFilename, renameLocation, edits };
    }

    function getContainingVariableDeclarationIfInList(node: Node, scope: Scope) {
        let prevNode = undefined;
        while (node !== undefined && node !== scope) {
            if (isVariableDeclaration(node) &&
                node.initializer === prevNode &&
                isVariableDeclarationList(node.parent) &&
                node.parent.declarations.length > 1) {

                return node;
            }

            prevNode = node;
            node = node.parent;
        }
    }

    /**
     * @return The index of the (only) reference to the extracted symbol.  We want the cursor
     * to be on the reference, rather than the declaration, because it's closer to where the
     * user was before extracting it.
     */
    function getRenameLocation(edits: ReadonlyArray<FileTextChanges>, renameFilename: string, functionNameText: string, isDeclaredBeforeUse: boolean): number {
        let delta = 0;
        let lastPos = -1;
        for (const { fileName, textChanges } of edits) {
            Debug.assert(fileName === renameFilename);
            for (const change of textChanges) {
                const { span, newText } = change;
                const index = newText.indexOf(functionNameText);
                if (index !== -1) {
                    lastPos = span.start + delta + index;

                    // If the reference comes first, return immediately.
                    if (!isDeclaredBeforeUse) {
                        return lastPos;
                    }
                }
                delta += newText.length - span.length;
            }
        }

        // If the declaration comes first, return the position of the last occurrence.
        Debug.assert(isDeclaredBeforeUse);
        Debug.assert(lastPos >= 0);
        return lastPos;
    }

    function getFirstDeclaration(type: Type): Declaration | undefined {
        let firstDeclaration = undefined;

        const symbol = type.symbol;
        if (symbol && symbol.declarations) {
            for (const declaration of symbol.declarations) {
                if (firstDeclaration === undefined || declaration.pos < firstDeclaration.pos) {
                    firstDeclaration = declaration;
                }
            }
        }

        return firstDeclaration;
    }

    function compareTypesByDeclarationOrder(
        {type: type1, declaration: declaration1}: {type: Type, declaration?: Declaration},
        {type: type2, declaration: declaration2}: {type: Type, declaration?: Declaration}) {

        if (declaration1) {
            if (declaration2) {
                const positionDiff = declaration1.pos - declaration2.pos;
                if (positionDiff !== 0) {
                    return positionDiff;
                }
            }
            else {
                return 1; // Sort undeclared type parameters to the front.
            }
        }
        else if (declaration2) {
            return -1; // Sort undeclared type parameters to the front.
        }

        const name1 = type1.symbol ? type1.symbol.getName() : "";
        const name2 = type2.symbol ? type2.symbol.getName() : "";
        const nameDiff = compareStrings(name1, name2);
        if (nameDiff !== 0) {
            return nameDiff;
        }

        // IDs are guaranteed to be unique, so this ensures a total ordering.
        return type1.id - type2.id;
    }

    function getCalledExpression(scope: Node, range: TargetRange, functionNameText: string): Expression {
        const functionReference = createIdentifier(functionNameText);
        if (isClassLike(scope)) {
            const lhs = range.facts & RangeFacts.InStaticRegion ? createIdentifier(scope.name.text) : createThis();
            return createPropertyAccess(lhs, functionReference);
        }
        else {
            return functionReference;
        }
    }

    function transformFunctionBody(body: Node, writes: ReadonlyArray<UsageEntry>, substitutions: ReadonlyMap<() => Node>, hasReturn: boolean): { body: Block, returnValueProperty: string } {
        if (isBlock(body) && !writes && substitutions.size === 0) {
            // already block, no writes to propagate back, no substitutions - can use node as is
            return { body: createBlock(body.statements, /*multLine*/ true), returnValueProperty: undefined };
        }
        let returnValueProperty: string;
        let ignoreReturns = false;
        const statements = createNodeArray(isBlock(body) ? body.statements.slice(0) : [isStatement(body) ? body : createReturn(<Expression>body)]);
        // rewrite body if either there are writes that should be propagated back via return statements or there are substitutions
        if (writes || substitutions.size) {
            const rewrittenStatements = visitNodes(statements, visitor).slice();
            if (writes && !hasReturn && isStatement(body)) {
                // add return at the end to propagate writes back in case if control flow falls out of the function body
                // it is ok to know that range has at least one return since it we only allow unconditional returns
                const assignments = getPropertyAssignmentsForWrites(writes);
                if (assignments.length === 1) {
                    rewrittenStatements.push(createReturn(assignments[0].name));
                }
                else {
                    rewrittenStatements.push(createReturn(createObjectLiteral(assignments)));
                }
            }
            return { body: createBlock(rewrittenStatements, /*multiLine*/ true), returnValueProperty };
        }
        else {
            return { body: createBlock(statements, /*multiLine*/ true), returnValueProperty: undefined };
        }

        function visitor(node: Node): VisitResult<Node> {
            if (!ignoreReturns && node.kind === SyntaxKind.ReturnStatement && writes) {
                const assignments: ObjectLiteralElementLike[] = getPropertyAssignmentsForWrites(writes);
                if ((<ReturnStatement>node).expression) {
                    if (!returnValueProperty) {
                        returnValueProperty = "__return";
                    }
                    assignments.unshift(createPropertyAssignment(returnValueProperty, visitNode((<ReturnStatement>node).expression, visitor)));
                }
                if (assignments.length === 1) {
                    return createReturn(assignments[0].name as Expression);
                }
                else {
                    return createReturn(createObjectLiteral(assignments));
                }
            }
            else {
                const oldIgnoreReturns = ignoreReturns;
                ignoreReturns = ignoreReturns || isFunctionLikeDeclaration(node) || isClassLike(node);
                const substitution = substitutions.get(getNodeId(node).toString());
                const result = substitution ? substitution() : visitEachChild(node, visitor, nullTransformationContext);
                ignoreReturns = oldIgnoreReturns;
                return result;
            }
        }
    }

    function transformConstantInitializer(initializer: Expression, substitutions: ReadonlyMap<() => Node>): Expression {
        return substitutions.size
            ? visitor(initializer) as Expression
            : initializer;

        function visitor(node: Node): VisitResult<Node> {
            const substitution = substitutions.get(getNodeId(node).toString());
            return substitution ? substitution() : visitEachChild(node, visitor, nullTransformationContext);
        }
    }

    function getStatementsOrClassElements(scope: Scope): ReadonlyArray<Statement> | ReadonlyArray<ClassElement> {
        if (isFunctionLikeDeclaration(scope)) {
            const body = scope.body;
            if (isBlock(body)) {
                return body.statements;
            }
        }
        else if (isModuleBlock(scope) || isSourceFile(scope)) {
            return scope.statements;
        }
        else if (isClassLike(scope)) {
            return scope.members;
        }
        else {
            assertTypeIsNever(scope);
        }

        return emptyArray;
    }

    /**
     * If `scope` contains a function after `minPos`, then return the first such function.
     * Otherwise, return `undefined`.
     */
    function getNodeToInsertFunctionBefore(minPos: number, scope: Scope): Node | undefined {
        return find<Statement | ClassElement>(getStatementsOrClassElements(scope), child =>
            child.pos >= minPos && isFunctionLikeDeclaration(child) && !isConstructorDeclaration(child));
    }

    function getNodeToInsertPropertyBefore(maxPos: number, scope: ClassLikeDeclaration): Node {
        const members = scope.members;
        Debug.assert(members.length > 0); // There must be at least one child, since we extracted from one.

        let prevMember: ClassElement | undefined = undefined;
        let allProperties = true;
        for (const member of members) {
            if (member.pos > maxPos) {
                return prevMember || members[0];
            }
            if (allProperties && !isPropertyDeclaration(member)) {
                // If it is non-vacuously true that all preceding members are properties,
                // insert before the current member (i.e. at the end of the list of properties).
                if (prevMember !== undefined) {
                    return member;
                }

                allProperties = false;
            }
            prevMember = member;
        }

        Debug.assert(prevMember !== undefined); // If the loop didn't return, then it did set prevMember.
        return prevMember;
    }

    function getNodeToInsertConstantBefore(node: Node, scope: Scope): Node {
        Debug.assert(!isClassLike(scope));

        let prevScope: Scope | undefined = undefined;
        for (let curr = node; curr !== scope; curr = curr.parent) {
            if (isScope(curr)) {
                prevScope = curr;
            }
        }

        for (let curr = (prevScope || node).parent; ; curr = curr.parent) {
            if (isBlockLike(curr)) {
                let prevStatement = undefined;
                for (const statement of curr.statements) {
                    if (statement.pos > node.pos) {
                        break;
                    }
                    prevStatement = statement;
                }
                // There must be at least one statement since we started in one.
                Debug.assert(prevStatement !== undefined);
                return prevStatement;
            }

            if (curr === scope) {
                Debug.fail("Didn't encounter a block-like before encountering scope");
                break;
            }
        }
    }

    function getPropertyAssignmentsForWrites(writes: ReadonlyArray<UsageEntry>): ShorthandPropertyAssignment[] {
        return writes.map(w => createShorthandPropertyAssignment(w.symbol.name));
    }

    function isReadonlyArray(v: any): v is ReadonlyArray<any> {
        return isArray(v);
    }

    /**
     * Produces a range that spans the entirety of nodes, given a selection
     * that might start/end in the middle of nodes.
     *
     * For example, when the user makes a selection like this
     *                     v---v
     *   var someThing = foo + bar;
     *  this returns     ^-------^
     */
    function getEnclosingTextRange(targetRange: TargetRange, sourceFile: SourceFile): TextRange {
        return isReadonlyArray(targetRange.range)
            ? { pos: first(targetRange.range).getStart(sourceFile), end: last(targetRange.range).getEnd() }
            : targetRange.range;
    }

    const enum Usage {
        // value should be passed to extracted method
        Read = 1,
        // value should be passed to extracted method and propagated back
        Write = 2
    }

    interface UsageEntry {
        readonly usage: Usage;
        readonly symbol: Symbol;
        readonly node: Node;
    }

    interface ScopeUsages {
        readonly usages: Map<UsageEntry>;
        readonly typeParameterUsages: Map<TypeParameter>; // Key is type ID
        readonly substitutions: Map<() => Node>;
    }

    interface ReadsAndWrites {
        readonly target: Expression | Block;
        readonly usagesPerScope: ReadonlyArray<ScopeUsages>;
        readonly functionErrorsPerScope: ReadonlyArray<ReadonlyArray<Diagnostic>>;
        readonly constantErrorsPerScope: ReadonlyArray<ReadonlyArray<Diagnostic>>;
    }
    function collectReadsAndWrites(
        targetRange: TargetRange,
        scopes: Scope[],
        enclosingTextRange: TextRange,
        sourceFile: SourceFile,
        checker: TypeChecker,
        cancellationToken: CancellationToken): ReadsAndWrites {

        const allTypeParameterUsages = createMap<TypeParameter>(); // Key is type ID
        const usagesPerScope: ScopeUsages[] = [];
        const substitutionsPerScope: Map<() => Node>[] = [];
        const functionErrorsPerScope: Diagnostic[][] = [];
        const constantErrorsPerScope: Diagnostic[][] = [];
        const visibleDeclarationsInExtractedRange: Symbol[] = [];

        const expressionDiagnostic =
            isReadonlyArray(targetRange.range) && !(targetRange.range.length === 1 && isExpressionStatement(targetRange.range[0]))
                ? ((start, end) => createFileDiagnostic(sourceFile, start, end - start, Messages.ExpressionExpected))(first(targetRange.range).getStart(), last(targetRange.range).end)
                : undefined;

        // initialize results
        for (const scope of scopes) {
            usagesPerScope.push({ usages: createMap<UsageEntry>(), typeParameterUsages: createMap<TypeParameter>(), substitutions: createMap<() => Expression>() });
            substitutionsPerScope.push(createMap<() => Expression>());

            functionErrorsPerScope.push(
                isFunctionLikeDeclaration(scope) && scope.kind !== SyntaxKind.FunctionDeclaration
                    ? [createDiagnosticForNode(scope, Messages.CannotExtractToOtherFunctionLike)]
                    : []);

            const constantErrors = [];
            if (expressionDiagnostic) {
                constantErrors.push(expressionDiagnostic);
            }
            if (isClassLike(scope) && isInJavaScriptFile(scope)) {
                constantErrors.push(createDiagnosticForNode(scope, Messages.CannotExtractToJSClass));
            }
            if (isArrowFunction(scope) && !isBlock(scope.body)) {
                // TODO (https://github.com/Microsoft/TypeScript/issues/18924): allow this
                constantErrors.push(createDiagnosticForNode(scope, Messages.CannotExtractToExpressionArrowFunction));
            }
            constantErrorsPerScope.push(constantErrors);
        }

        const seenUsages = createMap<Usage>();
        const target = isReadonlyArray(targetRange.range) ? createBlock(<Statement[]>targetRange.range) : targetRange.range;
        const containingLexicalScopeOfExtraction = isBlockScope(scopes[0], scopes[0].parent) ? scopes[0] : getEnclosingBlockScopeContainer(scopes[0]);

        const unmodifiedNode = isReadonlyArray(targetRange.range) ? first(targetRange.range) : targetRange.range;
        const inGenericContext = isInGenericContext(unmodifiedNode);

        collectUsages(target);

        // Unfortunately, this code takes advantage of the knowledge that the generated method
        // will use the contextual type of an expression as the return type of the extracted
        // method (and will therefore "use" all the types involved).
        if (inGenericContext && !isReadonlyArray(targetRange.range)) {
            const contextualType = checker.getContextualType(targetRange.range);
            recordTypeParameterUsages(contextualType);
        }

        if (allTypeParameterUsages.size > 0) {
            const seenTypeParameterUsages = createMap<TypeParameter>(); // Key is type ID

            let i = 0;
            for (let curr: Node = unmodifiedNode; curr !== undefined && i < scopes.length; curr = curr.parent) {
                if (curr === scopes[i]) {
                    // Copy current contents of seenTypeParameterUsages into scope.
                    seenTypeParameterUsages.forEach((typeParameter, id) => {
                        usagesPerScope[i].typeParameterUsages.set(id, typeParameter);
                    });

                    i++;
                }

                // Note that we add the current node's type parameters *after* updating the corresponding scope.
                if (isDeclarationWithTypeParameters(curr) && curr.typeParameters) {
                    for (const typeParameterDecl of curr.typeParameters) {
                        const typeParameter = checker.getTypeAtLocation(typeParameterDecl) as TypeParameter;
                        if (allTypeParameterUsages.has(typeParameter.id.toString())) {
                            seenTypeParameterUsages.set(typeParameter.id.toString(), typeParameter);
                        }
                    }
                }
            }

            // If we didn't get through all the scopes, then there were some that weren't in our
            // parent chain (impossible at time of writing).  A conservative solution would be to
            // copy allTypeParameterUsages into all remaining scopes.
            Debug.assert(i === scopes.length);
        }

        for (let i = 0; i < scopes.length; i++) {
            const scopeUsages = usagesPerScope[i];
            // Special case: in the innermost scope, all usages are available.
            // (The computed value reflects the value at the top-level of the scope, but the
            // local will actually be declared at the same level as the extracted expression).
            if (i > 0 && (scopeUsages.usages.size > 0 || scopeUsages.typeParameterUsages.size > 0)) {
                const errorNode = isReadonlyArray(targetRange.range) ? targetRange.range[0] : targetRange.range;
                constantErrorsPerScope[i].push(createDiagnosticForNode(errorNode, Messages.CannotAccessVariablesFromNestedScopes));
            }

            let hasWrite = false;
            let readonlyClassPropertyWrite: Declaration | undefined = undefined;
            usagesPerScope[i].usages.forEach(value => {
                if (value.usage === Usage.Write) {
                    hasWrite = true;
                    if (value.symbol.flags & SymbolFlags.ClassMember &&
                        value.symbol.valueDeclaration &&
                        hasModifier(value.symbol.valueDeclaration, ModifierFlags.Readonly)) {
                        readonlyClassPropertyWrite = value.symbol.valueDeclaration;
                    }
                }
            });

            if (hasWrite && !isReadonlyArray(targetRange.range) && isExpression(targetRange.range)) {
                const diag = createDiagnosticForNode(targetRange.range, Messages.CannotCombineWritesAndReturns);
                functionErrorsPerScope[i].push(diag);
                constantErrorsPerScope[i].push(diag);
            }
            else if (readonlyClassPropertyWrite && i > 0) {
                const diag = createDiagnosticForNode(readonlyClassPropertyWrite, Messages.CannotExtractReadonlyPropertyInitializerOutsideConstructor);
                functionErrorsPerScope[i].push(diag);
                constantErrorsPerScope[i].push(diag);
            }
        }

        // If there are any declarations in the extracted block that are used in the same enclosing
        // lexical scope, we can't move the extraction "up" as those declarations will become unreachable
        if (visibleDeclarationsInExtractedRange.length) {
            forEachChild(containingLexicalScopeOfExtraction, checkForUsedDeclarations);
        }

        return { target, usagesPerScope, functionErrorsPerScope, constantErrorsPerScope };

        function hasTypeParameters(node: Node) {
            return isDeclarationWithTypeParameters(node) &&
                node.typeParameters !== undefined &&
                node.typeParameters.length > 0;
        }

        function isInGenericContext(node: Node) {
            for (; node; node = node.parent) {
                if (hasTypeParameters(node)) {
                    return true;
                }
            }

            return false;
        }

        function recordTypeParameterUsages(type: Type) {
            // PERF: This is potentially very expensive.  `type` could be a library type with
            // a lot of properties, each of which the walker will visit.  Unfortunately, the
            // solution isn't as trivial as filtering to user types because of (e.g.) Array.
            const symbolWalker = checker.getSymbolWalker(() => (cancellationToken.throwIfCancellationRequested(), true));
            const {visitedTypes} = symbolWalker.walkType(type);

            for (const visitedType of visitedTypes) {
                if (visitedType.flags & TypeFlags.TypeParameter) {
                    allTypeParameterUsages.set(visitedType.id.toString(), visitedType as TypeParameter);
                }
            }
        }

        function collectUsages(node: Node, valueUsage = Usage.Read) {
            if (inGenericContext) {
                const type = checker.getTypeAtLocation(node);
                recordTypeParameterUsages(type);
            }

            if (isDeclaration(node) && node.symbol) {
                visibleDeclarationsInExtractedRange.push(node.symbol);
            }

            if (isAssignmentExpression(node)) {
                // use 'write' as default usage for values
                collectUsages(node.left, Usage.Write);
                collectUsages(node.right);
            }
            else if (isUnaryExpressionWithWrite(node)) {
                collectUsages(node.operand, Usage.Write);
            }
            else if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
                // use 'write' as default usage for values
                forEachChild(node, collectUsages);
            }
            else if (isIdentifier(node)) {
                if (!node.parent) {
                    return;
                }
                if (isQualifiedName(node.parent) && node !== node.parent.left) {
                    return;
                }
                if (isPropertyAccessExpression(node.parent) && node !== node.parent.expression) {
                    return;
                }
                recordUsage(node, valueUsage, /*isTypeNode*/ isPartOfTypeNode(node));
            }
            else {
                forEachChild(node, collectUsages);
            }
        }

        function recordUsage(n: Identifier, usage: Usage, isTypeNode: boolean) {
            const symbolId = recordUsagebySymbol(n, usage, isTypeNode);
            if (symbolId) {
                for (let i = 0; i < scopes.length; i++) {
                    // push substitution from map<symbolId, subst> to map<nodeId, subst> to simplify rewriting
                    const substitution = substitutionsPerScope[i].get(symbolId);
                    if (substitution) {
                        usagesPerScope[i].substitutions.set(getNodeId(n).toString(), substitution);
                    }
                }
            }
        }

        function recordUsagebySymbol(identifier: Identifier, usage: Usage, isTypeName: boolean) {
            // If the identifier is both a property name and its value, we're only interested in its value
            // (since the name is a declaration and will be included in the extracted range).
            const symbol = identifier.parent && isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
                ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
                : checker.getSymbolAtLocation(identifier);
            if (!symbol) {
                // cannot find symbol - do nothing
                return undefined;
            }
            const symbolId = getSymbolId(symbol).toString();
            const lastUsage = seenUsages.get(symbolId);
            // there are two kinds of value usages
            // - reads - if range contains a read from the value located outside of the range then value should be passed as a parameter
            // - writes - if range contains a write to a value located outside the range the value should be passed as a parameter and
            //   returned as a return value
            // 'write' case is a superset of 'read' so if we already have processed 'write' of some symbol there is not need to handle 'read'
            // since all information is already recorded
            if (lastUsage && lastUsage >= usage) {
                return symbolId;
            }

            seenUsages.set(symbolId, usage);
            if (lastUsage) {
                // if we get here this means that we are trying to handle 'write' and 'read' was already processed
                // walk scopes and update existing records.
                for (const perScope of usagesPerScope) {
                    const prevEntry = perScope.usages.get(identifier.text as string);
                    if (prevEntry) {
                        perScope.usages.set(identifier.text as string, { usage, symbol, node: identifier });
                    }
                }
                return symbolId;
            }
            // find first declaration in this file
            const declInFile = find(symbol.getDeclarations(), d => d.getSourceFile() === sourceFile);
            if (!declInFile) {
                return undefined;
            }
            if (rangeContainsStartEnd(enclosingTextRange, declInFile.getStart(), declInFile.end)) {
                // declaration is located in range to be extracted - do nothing
                return undefined;
            }
            if (targetRange.facts & RangeFacts.IsGenerator && usage === Usage.Write) {
                // this is write to a reference located outside of the target scope and range is extracted into generator
                // currently this is unsupported scenario
                const diag = createDiagnosticForNode(identifier, Messages.CannotExtractRangeThatContainsWritesToReferencesLocatedOutsideOfTheTargetRangeInGenerators);
                for (const errors of functionErrorsPerScope) {
                    errors.push(diag);
                }
                for (const errors of constantErrorsPerScope) {
                    errors.push(diag);
                }
            }
            for (let i = 0; i < scopes.length; i++) {
                const scope = scopes[i];
                const resolvedSymbol = checker.resolveName(symbol.name, scope, symbol.flags);
                if (resolvedSymbol === symbol) {
                    continue;
                }
                if (!substitutionsPerScope[i].has(symbolId)) {
                    const substitution = tryReplaceWithQualifiedNameOrPropertyAccess(symbol.exportSymbol || symbol, scope, isTypeName);
                    if (substitution) {
                        substitutionsPerScope[i].set(symbolId, substitution);
                    }
                    else if (isTypeName) {
                        // If the symbol is a type parameter that won't be in scope, we'll pass it as a type argument
                        // so there's no problem.
                        if (!(symbol.flags & SymbolFlags.TypeParameter)) {
                            const diag = createDiagnosticForNode(identifier, Messages.TypeWillNotBeVisibleInTheNewScope);
                            functionErrorsPerScope[i].push(diag);
                            constantErrorsPerScope[i].push(diag);
                        }
                    }
                    else {
                        usagesPerScope[i].usages.set(identifier.text as string, { usage, symbol, node: identifier });
                    }
                }
            }
            return symbolId;
        }

        function checkForUsedDeclarations(node: Node) {
            // If this node is entirely within the original extraction range, we don't need to do anything.
            if (node === targetRange.range || (isReadonlyArray(targetRange.range) && targetRange.range.indexOf(node as Statement) >= 0)) {
                return;
            }

            // Otherwise check and recurse.
            const sym = checker.getSymbolAtLocation(node);
            if (sym && visibleDeclarationsInExtractedRange.some(d => d === sym)) {
                const diag = createDiagnosticForNode(node, Messages.CannotExtractExportedEntity);
                for (const errors of functionErrorsPerScope) {
                    errors.push(diag);
                }
                for (const errors of constantErrorsPerScope) {
                    errors.push(diag);
                }
                return true;
            }
            else {
                forEachChild(node, checkForUsedDeclarations);
            }
        }

        function tryReplaceWithQualifiedNameOrPropertyAccess(symbol: Symbol, scopeDecl: Node, isTypeNode: boolean): () => (PropertyAccessExpression | EntityName) {
            if (!symbol) {
                return undefined;
            }
            if (symbol.getDeclarations().some(d => d.parent === scopeDecl)) {
                return () => createIdentifier(symbol.name);
            }
            const prefix = tryReplaceWithQualifiedNameOrPropertyAccess(symbol.parent, scopeDecl, isTypeNode);
            if (prefix === undefined) {
                return undefined;
            }
            return isTypeNode
                ? () => createQualifiedName(<EntityName>prefix(), createIdentifier(symbol.name))
                : () => createPropertyAccess(<Expression>prefix(), symbol.name);
        }
    }

    function getParentNodeInSpan(node: Node, file: SourceFile, span: TextSpan): Node {
        if (!node) return undefined;

        while (node.parent) {
            if (isSourceFile(node.parent) || !spanContainsNode(span, node.parent, file)) {
                return node;
            }

            node = node.parent;
        }
    }

    function spanContainsNode(span: TextSpan, node: Node, file: SourceFile): boolean {
        return textSpanContainsPosition(span, node.getStart(file)) &&
            node.getEnd() <= textSpanEnd(span);
    }

    /**
     * Computes whether or not a node represents an expression in a position where it could
     * be extracted.
     * The isExpression() in utilities.ts returns some false positives we need to handle,
     * such as `import x from 'y'` -- the 'y' is a StringLiteral but is *not* an expression
     * in the sense of something that you could extract on
     */
    function isExtractableExpression(node: Node): boolean {
        switch (node.parent.kind) {
            case SyntaxKind.EnumMember:
                return false;
        }

        switch (node.kind) {
            case SyntaxKind.StringLiteral:
                return node.parent.kind !== SyntaxKind.ImportDeclaration &&
                    node.parent.kind !== SyntaxKind.ImportSpecifier;

            case SyntaxKind.SpreadElement:
            case SyntaxKind.ObjectBindingPattern:
            case SyntaxKind.BindingElement:
                return false;

            case SyntaxKind.Identifier:
                return node.parent.kind !== SyntaxKind.BindingElement &&
                    node.parent.kind !== SyntaxKind.ImportSpecifier &&
                    node.parent.kind !== SyntaxKind.ExportSpecifier;
        }
        return true;
    }

    function isBlockLike(node: Node): node is BlockLike {
        switch (node.kind) {
            case SyntaxKind.Block:
            case SyntaxKind.SourceFile:
            case SyntaxKind.ModuleBlock:
            case SyntaxKind.CaseClause:
                return true;
            default:
                return false;
        }
    }
}
