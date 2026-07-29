// A ~50-line test harness, run by `gjs -m tests/run.js`.
//
// Deliberately dependency-free: the extension has no build step and no
// node_modules, and adding a test framework would be the only thing in the
// project that needed one. The modules under test import nothing from
// resource:///, so they load in plain gjs with no Shell and no display.

let suiteName = '';
const failures = [];
let passCount = 0;

export function suite(name) {
    suiteName = name;
}

export function it(name, fn) {
    try {
        fn();
        passCount++;
    } catch (e) {
        failures.push({ suite: suiteName, name, message: e.message ?? String(e) });
    }
}

function show(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    if (v === undefined) return 'undefined';
    try { return JSON.stringify(v); } catch (_) { return String(v); }
}

export function eq(actual, expected, label = '') {
    const a = show(actual);
    const b = show(expected);
    if (a !== b)
        throw new Error(`${label ? label + ': ' : ''}expected ${b}, got ${a}`);
}

export function ok(cond, label = 'expected truthy') {
    if (!cond) throw new Error(label);
}

// Assert a strict ordering of scores, e.g. ordered([['exact', 1000], ...]).
// Reports which neighbouring pair broke rather than just "false".
export function descending(pairs, label = '') {
    for (let i = 1; i < pairs.length; i++) {
        const [prevName, prev] = pairs[i - 1];
        const [name, cur] = pairs[i];
        if (!(prev > cur))
            throw new Error(`${label ? label + ': ' : ''}${prevName} (${prev}) should rank above ${name} (${cur})`);
    }
}

// Run `fn` with the Shell's logError silenced. Several tests deliberately feed
// bad input to code whose contract is "log it and carry on"; without this the
// expected stack traces bury the actual result in CI output.
export function silenced(fn) {
    const real = globalThis.logError;
    globalThis.logError = () => {};
    try {
        return fn();
    } finally {
        globalThis.logError = real;
    }
}

export function report() {
    if (failures.length === 0) {
        print(`\n  ${passCount} passed`);
        return 0;
    }
    print(`\n  ${passCount} passed, ${failures.length} FAILED\n`);
    for (const f of failures)
        print(`  ✗ ${f.suite} › ${f.name}\n      ${f.message}`);
    return 1;
}
