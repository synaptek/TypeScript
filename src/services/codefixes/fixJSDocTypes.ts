/* @internal */
namespace ts.codefix {
    registerCodeFix({
        errorCodes: [Diagnostics.JSDoc_types_can_only_be_used_inside_documentation_comments.code],
        getCodeActions: getActionsForJSDocTypes
    });

    function getActionsForJSDocTypes(context: CodeFixContext): CodeAction[] | undefined {
        const sourceFile = context.sourceFile;
        const node = getTokenAtPosition(sourceFile, context.span.start, /*includeJsDocComment*/ false);

        // NOTE: Some locations are not handled yet:
        // MappedTypeNode.typeParameters and SignatureDeclaration.typeParameters, as well as CallExpression.typeArguments
        const decl = ts.findAncestor(node,
                                     n =>
                                     n.kind === SyntaxKind.AsExpression ||
                                     n.kind === SyntaxKind.CallSignature ||
                                     n.kind === SyntaxKind.ConstructSignature ||
                                     n.kind === SyntaxKind.FunctionDeclaration ||
                                     n.kind === SyntaxKind.GetAccessor ||
                                     n.kind === SyntaxKind.IndexSignature ||
                                     n.kind === SyntaxKind.MappedType ||
                                     n.kind === SyntaxKind.MethodDeclaration ||
                                     n.kind === SyntaxKind.MethodSignature ||
                                     n.kind === SyntaxKind.Parameter ||
                                     n.kind === SyntaxKind.PropertyDeclaration ||
                                     n.kind === SyntaxKind.PropertySignature ||
                                     n.kind === SyntaxKind.SetAccessor ||
                                     n.kind === SyntaxKind.TypeAliasDeclaration ||
                                     n.kind === SyntaxKind.TypeAssertionExpression ||
                                     n.kind === SyntaxKind.VariableDeclaration);
        if (!decl) return;
        const checker = context.program.getTypeChecker();

        const jsdocType = (decl as VariableDeclaration).type;
        if (!jsdocType) return;
        const original = getTextOfNode(jsdocType);
        const type = checker.getTypeFromTypeNode(jsdocType);
        const actions = [createAction(jsdocType, sourceFile.fileName, original, checker.typeToString(type, /*enclosingDeclaration*/ undefined, TypeFormatFlags.NoTruncation))];
        if (jsdocType.kind === SyntaxKind.JSDocNullableType) {
            // for nullable types, suggest the flow-compatible `T | null | undefined`
            // in addition to the jsdoc/closure-compatible `T | null`
            const replacementWithUndefined = checker.typeToString(checker.getNullableType(type, TypeFlags.Undefined), /*enclosingDeclaration*/ undefined, TypeFormatFlags.NoTruncation);
            actions.push(createAction(jsdocType, sourceFile.fileName, original, replacementWithUndefined));
        }
        return actions;
    }

    function createAction(declaration: TypeNode, fileName: string, original: string, replacement: string): CodeAction {
        return {
            description: formatStringFromArgs(getLocaleSpecificMessage(Diagnostics.Change_0_to_1), [original, replacement]),
            changes: [{
                fileName,
                textChanges: [{
                    span: { start: declaration.getStart(), length: declaration.getWidth() },
                    newText: replacement
                }]
            }],
        };
    }
}
