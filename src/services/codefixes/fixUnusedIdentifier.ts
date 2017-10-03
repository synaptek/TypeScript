/* @internal */
namespace ts.codefix {
    registerCodeFix({
        errorCodes: [
            Diagnostics._0_is_declared_but_its_value_is_never_read.code,
            Diagnostics.Property_0_is_declared_but_its_value_is_never_read.code
        ],
        getCodeActions: (context: CodeFixContext) => {
            const sourceFile = context.sourceFile;
            const start = context.span.start;

            let token = getTokenAtPosition(sourceFile, start, /*includeJsDocComment*/ false);

            // this handles var ["computed"] = 12;
            if (token.kind === SyntaxKind.OpenBracketToken) {
                token = getTokenAtPosition(sourceFile, start + 1, /*includeJsDocComment*/ false);
            }

            switch (token.kind) {
                case ts.SyntaxKind.Identifier:
                    return deleteIdentifierOrPrefixWithUnderscore(<Identifier>token);

                case SyntaxKind.PropertyDeclaration:
                case SyntaxKind.NamespaceImport:
                    return [deleteNode(token.parent)];

                default:
                    return deleteDefault();
            }

            function deleteDefault(): CodeAction[] | undefined {
                if (isDeclarationName(token)) {
                    return [deleteNode(token.parent)];
                }
                else if (isLiteralComputedPropertyDeclarationName(token)) {
                    return [deleteNode(token.parent.parent)];
                }
                else {
                    return undefined;
                }
            }

            function prefixIdentifierWithUnderscore(identifier: Identifier): CodeAction {
                const startPosition = identifier.getStart(sourceFile, /*includeJsDocComment*/ false);
                return {
                    description: formatStringFromArgs(getLocaleSpecificMessage(Diagnostics.Prefix_0_with_an_underscore), { 0: token.getText() }),
                    changes: [{
                        fileName: sourceFile.path,
                        textChanges: [{
                            span: { start: startPosition, length: 0 },
                            newText: "_"
                        }]
                    }]
                };
            }

            function deleteIdentifierOrPrefixWithUnderscore(identifier: Identifier): CodeAction[] | undefined {
                const parent = identifier.parent;
                switch (parent.kind) {
                    case ts.SyntaxKind.VariableDeclaration:
                        return deleteVariableDeclarationOrPrefixWithUnderscore(identifier, <ts.VariableDeclaration>parent);

                    case SyntaxKind.TypeParameter:
                        const typeParameters = (<DeclarationWithTypeParameters>parent.parent).typeParameters;
                        if (typeParameters.length === 1) {
                            const previousToken = getTokenAtPosition(sourceFile, typeParameters.pos - 1, /*includeJsDocComment*/ false);
                            const nextToken = getTokenAtPosition(sourceFile, typeParameters.end, /*includeJsDocComment*/ false);
                            Debug.assert(previousToken.kind === SyntaxKind.LessThanToken);
                            Debug.assert(nextToken.kind === SyntaxKind.GreaterThanToken);

                            return [deleteNodeRange(previousToken, nextToken)];
                        }
                        else {
                            return [deleteNodeInList(parent)];
                        }

                    case ts.SyntaxKind.Parameter:
                        const functionDeclaration = <FunctionDeclaration>parent.parent;
                        return [functionDeclaration.parameters.length === 1 ? deleteNode(parent) : deleteNodeInList(parent),
                            prefixIdentifierWithUnderscore(identifier)];

                    // handle case where 'import a = A;'
                    case SyntaxKind.ImportEqualsDeclaration:
                        const importEquals = getAncestor(identifier, SyntaxKind.ImportEqualsDeclaration);
                        return [deleteNode(importEquals)];

                    case SyntaxKind.ImportSpecifier:
                        const namedImports = <NamedImports>parent.parent;
                        if (namedImports.elements.length === 1) {
                            return deleteNamedImportBinding(namedImports);
                        }
                        else {
                            // delete import specifier
                            return [deleteNodeInList(parent)];
                        }

                    case SyntaxKind.ImportClause: // this covers both 'import |d|' and 'import |d,| *'
                        const importClause = <ImportClause>parent;
                        if (!importClause.namedBindings) { // |import d from './file'|
                            const importDecl = getAncestor(importClause, SyntaxKind.ImportDeclaration);
                            return [deleteNode(importDecl)];
                        }
                        else {
                            // import |d,| * as ns from './file'
                            const start = importClause.name.getStart(sourceFile);
                            const nextToken = getTokenAtPosition(sourceFile, importClause.name.end, /*includeJsDocComment*/ false);
                            if (nextToken && nextToken.kind === SyntaxKind.CommaToken) {
                                // shift first non-whitespace position after comma to the start position of the node
                                return [deleteRange({ pos: start, end: skipTrivia(sourceFile.text, nextToken.end, /*stopAfterLineBreaks*/ false, /*stopAtComments*/ true) })];
                            }
                            else {
                                return [deleteNode(importClause.name)];
                            }
                        }

                    case SyntaxKind.NamespaceImport:
                        return deleteNamedImportBinding(<NamespaceImport>parent);

                    default:
                        return deleteDefault();
                }
            }

            function deleteNamedImportBinding(namedBindings: NamedImportBindings): CodeAction[] | undefined {
                if ((<ImportClause>namedBindings.parent).name) {
                    // Delete named imports while preserving the default import
                    // import d|, * as ns| from './file'
                    // import d|, { a }| from './file'
                    const previousToken = getTokenAtPosition(sourceFile, namedBindings.pos - 1, /*includeJsDocComment*/ false);
                    if (previousToken && previousToken.kind === SyntaxKind.CommaToken) {
                        return [deleteRange({ pos: previousToken.getStart(), end: namedBindings.end })];
                    }
                    return undefined;
                }
                else {
                    // Delete the entire import declaration
                    // |import * as ns from './file'|
                    // |import { a } from './file'|
                    const importDecl = getAncestor(namedBindings, SyntaxKind.ImportDeclaration);
                    return [deleteNode(importDecl)];
                }
            }

            // token.parent is a variableDeclaration
            function deleteVariableDeclarationOrPrefixWithUnderscore(identifier: Identifier, varDecl: ts.VariableDeclaration): CodeAction[] | undefined {
                switch (varDecl.parent.parent.kind) {
                    case SyntaxKind.ForStatement:
                        const forStatement = <ForStatement>varDecl.parent.parent;
                        const forInitializer = <VariableDeclarationList>forStatement.initializer;
                        return [forInitializer.declarations.length === 1 ? deleteNode(forInitializer) : deleteNodeInList(varDecl)];

                    case SyntaxKind.ForOfStatement:
                        const forOfStatement = <ForOfStatement>varDecl.parent.parent;
                        Debug.assert(forOfStatement.initializer.kind === SyntaxKind.VariableDeclarationList);
                        const forOfInitializer = <VariableDeclarationList>forOfStatement.initializer;
                        return [
                            replaceNode(forOfInitializer.declarations[0], createObjectLiteral()),
                            prefixIdentifierWithUnderscore(identifier)
                        ];

                    case SyntaxKind.ForInStatement:
                        // There is no valid fix in the case of:
                        //  for .. in
                        return [prefixIdentifierWithUnderscore(identifier)];

                    default:
                        const variableStatement = <VariableStatement>varDecl.parent.parent;
                        if (variableStatement.declarationList.declarations.length === 1) {
                            return [deleteNode(variableStatement)];
                        }
                        else {
                            return [deleteNodeInList(varDecl)];
                        }
                }
            }

            function deleteNode(n: Node) {
                return makeChange(textChanges.ChangeTracker.fromContext(context).deleteNode(sourceFile, n));
            }

            function deleteRange(range: TextRange) {
                return makeChange(textChanges.ChangeTracker.fromContext(context).deleteRange(sourceFile, range));
            }

            function deleteNodeInList(n: Node) {
                return makeChange(textChanges.ChangeTracker.fromContext(context).deleteNodeInList(sourceFile, n));
            }

            function deleteNodeRange(start: Node, end: Node) {
                return makeChange(textChanges.ChangeTracker.fromContext(context).deleteNodeRange(sourceFile, start, end));
            }

            function replaceNode(n: Node, newNode: Node) {
                return makeChange(textChanges.ChangeTracker.fromContext(context).replaceNode(sourceFile, n, newNode));
            }

            function makeChange(changeTracker: textChanges.ChangeTracker): CodeAction {
                return {
                    description: formatStringFromArgs(getLocaleSpecificMessage(Diagnostics.Remove_declaration_for_Colon_0), { 0: token.getText() }),
                    changes: changeTracker.getChanges()
                };
            }
        }
    });
}