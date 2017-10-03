/// <reference path="extractTestHelpers.ts" />

namespace ts {
    describe("extractConstants", () => {
        testExtractConstant("extractConstant_TopLevel",
            `let x = [#|1|];`);

        testExtractConstant("extractConstant_Namespace",
            `namespace N {
    let x = [#|1|];
}`);

        testExtractConstant("extractConstant_Class",
            `class C {
    x = [#|1|];
}`);

        testExtractConstant("extractConstant_Method",
            `class C {
    M() {
        let x = [#|1|];
    }
}`);

        testExtractConstant("extractConstant_Function",
            `function F() {
    let x = [#|1|];
}`);

        testExtractConstant("extractConstant_ExpressionStatement",
            `[#|"hello";|]`);

        testExtractConstant("extractConstant_ExpressionStatementExpression",
            `[#|"hello"|];`);

        testExtractConstant("extractConstant_ExpressionStatementInNestedScope", `
let i = 0;
function F() {
    [#|i++|];
}
        `);

        testExtractConstant("extractConstant_ExpressionStatementConsumesLocal", `
function F() {
    let i = 0;
    [#|i++|];
}
        `);

        testExtractConstant("extractConstant_BlockScopes_NoDependencies",
            `for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
        let x = [#|1|];
    }
}`);

        testExtractConstant("extractConstant_ClassInsertionPosition1",
            `class C {
    a = 1;
    b = 2;
    M1() { }
    M2() { }
    M3() {
        let x = [#|1|];
    }
}`);

        testExtractConstant("extractConstant_ClassInsertionPosition2",
            `class C {
    a = 1;
    M1() { }
    b = 2;
    M2() { }
    M3() {
        let x = [#|1|];
    }
}`);

        testExtractConstant("extractConstant_ClassInsertionPosition3",
            `class C {
    M1() { }
    a = 1;
    b = 2;
    M2() { }
    M3() {
        let x = [#|1|];
    }
}`);

        testExtractConstant("extractConstant_Parameters",
            `function F() {
    let w = 1;
    let x = [#|w + 1|];
}`);

        testExtractConstant("extractConstant_TypeParameters",
            `function F<T>(t: T) {
    let x = [#|t + 1|];
}`);

        testExtractConstant("extractConstant_RepeatedSubstitution",
            `namespace X {
    export const j = 10;
    export const y = [#|j * j|];
}`);

        testExtractConstant("extractConstant_VariableList_const",
            `const a = 1, b = [#|a + 1|];`);

        // NOTE: this test isn't normative - it just documents our sub-optimal behavior.
        testExtractConstant("extractConstant_VariableList_let",
            `let a = 1, b = [#|a + 1|];`);

        // NOTE: this test isn't normative - it just documents our sub-optimal behavior.
        testExtractConstant("extractConstant_VariableList_MultipleLines",
            `const /*About A*/a = 1,
    /*About B*/b = [#|a + 1|];`);

        testExtractConstant("extractConstant_BlockScopeMismatch", `
for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
        const x = [#|i + 1|];
    }
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition1", `
const i = 0;
for (let j = 0; j < 10; j++) {
    const x = [#|i + 1|];
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition2", `
const i = 0;
function F() {
    for (let j = 0; j < 10; j++) {
        const x = [#|i + 1|];
    }
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition3", `
for (let j = 0; j < 10; j++) {
    const x = [#|2 + 1|];
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition4", `
function F() {
    for (let j = 0; j < 10; j++) {
        const x = [#|2 + 1|];
    }
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition5", `
function F0() {
    function F1() {
        function F2(x = [#|2 + 1|]) {
        }
    }
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition6", `
class C {
    x = [#|2 + 1|];
}
        `);

        testExtractConstant("extractConstant_StatementInsertionPosition7", `
const i = 0;
class C {
    M() {
        for (let j = 0; j < 10; j++) {
            x = [#|i + 1|];
        }
    }
}
        `);

        testExtractConstant("extractConstant_TripleSlash", `
/// <reference path="path.js"/>

const x = [#|2 + 1|];
        `);

        testExtractConstant("extractConstant_PinnedComment", `
/*! Copyright */

const x = [#|2 + 1|];
        `);

        testExtractConstant("extractConstant_Directive", `
"strict";

const x = [#|2 + 1|];
        `);

        testExtractConstant("extractConstant_MultipleHeaders", `
/*! Copyright */

/// <reference path="path.js"/>

"strict";

const x = [#|2 + 1|];
        `);

        testExtractConstant("extractConstant_PinnedCommentAndDocComment", `
/*! Copyright */

/* About x */
const x = [#|2 + 1|];
        `);

        testExtractConstant("extractConstant_ArrowFunction_Block", `
const f = () => {
    return [#|2 + 1|];
};`);

        testExtractConstant("extractConstant_ArrowFunction_Expression",
            `const f = () => [#|2 + 1|];`);
    });

    function testExtractConstant(caption: string, text: string) {
        testExtractSymbol(caption, text, "extractConstant", Diagnostics.Extract_constant);
    }
}
