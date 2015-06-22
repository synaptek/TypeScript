//// [classAbstractSuperCalls.ts]

class A {
    foo() { return 1; }
}

abstract class B extends A {
    abstract foo();
    bar() { super.foo(); }
    baz() { return this.foo; }
}

class C extends B {
    foo() { return 2; }
    qux() { return super.foo(); } // error, super is abstract
    norf() { return super.bar(); }
}

class AA {
    foo() { return 1; }
    bar() { return this.foo(); }
}

abstract class BB extends AA {
    abstract foo();
    // inherits bar. But BB is abstract, so this is OK.
}


//// [classAbstractSuperCalls.js]
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var A = (function () {
    function A() {
    }
    A.prototype.foo = function () { return 1; };
    return A;
})();
var B = (function (_super) {
    __extends(B, _super);
    function B() {
        _super.apply(this, arguments);
    }
    B.prototype.bar = function () { _super.prototype.foo.call(this); };
    B.prototype.baz = function () { return this.foo; };
    return B;
})(A);
var C = (function (_super) {
    __extends(C, _super);
    function C() {
        _super.apply(this, arguments);
    }
    C.prototype.foo = function () { return 2; };
    C.prototype.qux = function () { return _super.prototype.foo.call(this); }; // error, super is abstract
    C.prototype.norf = function () { return _super.prototype.bar.call(this); };
    return C;
})(B);
var AA = (function () {
    function AA() {
    }
    AA.prototype.foo = function () { return 1; };
    AA.prototype.bar = function () { return this.foo(); };
    return AA;
})();
var BB = (function (_super) {
    __extends(BB, _super);
    function BB() {
        _super.apply(this, arguments);
    }
    return BB;
})(AA);