// calc.js is a hand-written expression parser — there is no eval() anywhere,
// because this code runs inside the compositor process. That makes it exactly
// the kind of module where a regression is silent, so it gets the most tests.

import { evaluate, parseCurrency } from '../omelette@dfxe.github.io/calc.js';
import { suite, it, eq, ok } from './harness.js';

suite('calc');

const title = (q, opts) => evaluate(q, opts ?? {})?.title ?? null;

it('evaluates arithmetic with correct precedence', () => {
    eq(title('2+2*8'), '18');
    eq(title('(2+2)*8'), '32');
    eq(title('10-2-3'), '5');
    eq(title('7/2'), '3.5');
});

it('handles powers and functions', () => {
    eq(title('2^10'), '1,024');
    eq(title('sqrt(16)'), '4');
    eq(title('max(3,9,2)'), '9');
    eq(title('min(3,9,2)'), '2');
});

it('rejects nonsense instead of guessing', () => {
    eq(title('hello world'), null);
    eq(title('2 +'), null);
    eq(title(''), null);
    eq(title('a'), null, 'single characters are below the minimum length');
});

it('is bounded — a very long query is refused outright', () => {
    eq(title('1+'.repeat(200) + '1'), null);
});

it('does not divide by zero into Infinity', () => {
    const r = title('1/0');
    ok(r === null || !String(r).includes('Infinity'), `got ${r}`);
});

it('computes percentages', () => {
    eq(title('20% of 300'), '60');
    eq(title('300 + 20%'), '360');
    eq(title('300 - 20%'), '240');
    eq(title('45 as % of 60'), '75%');
});

it('does date arithmetic', () => {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(title('today + 30 days') ?? ''), 'today + 30 days is a date');
    ok(title('days until 2099-12-25') !== null, 'days until a future date resolves');
});

it('converts units without touching the network', () => {
    eq(title('100 km in mi'), '62.1371192237 mi');
    eq(title('2.5 GiB in MB'), '2,684.35456 MB');
    ok((title('72f to c') ?? '').startsWith('22.2'), `got ${title('72f to c')}`);
});

// --- Currency -----------------------------------------------------------
//
// The rates table is injectable, so none of this reaches the network.

const TABLE = { base: 'USD', rates: { EUR: 0.92, GBP: 0.79 }, fetchedAt: null };

it('converts currency when a table is supplied', () => {
    eq(title('100 usd in eur', { rates: TABLE }), '92 EUR');
    eq(title('$50 in gbp', { rates: TABLE }), '39.5 GBP');
});

it('produces no answer at all when currency is off', () => {
    eq(title('100 usd in eur', { rates: null }), null);
});

it('crosses via the base currency', () => {
    // 100 EUR -> USD -> GBP  =  100 / 0.92 * 0.79
    const expected = (100 / 0.92) * 0.79;
    const got = Number((title('100 eur in gbp', { rates: TABLE }) ?? '').replace(/[^\d.]/g, ''));
    ok(Math.abs(got - expected) < 0.01, `expected ~${expected}, got ${got}`);
});

it('parseCurrency splits a conversion without needing rates', () => {
    eq(parseCurrency('100 usd in eur'), { from: 'USD', to: 'EUR', amount: 100 });
    eq(parseCurrency('$50 in gbp'), { from: 'USD', to: 'GBP', amount: 50 });
});

it('parseCurrency rejects anything that is not code-to-code', () => {
    eq(parseCurrency('100 km in mi'), null, 'two-letter unit is not a currency code');
    eq(parseCurrency('2+2'), null);
    eq(parseCurrency('hello'), null);
});

// This is what keeps the opt-in network fetch out of every other keystroke:
// the thunk must be consulted only once the text reads as a conversion.
it('resolves the rates thunk only for currency-shaped queries', () => {
    const asked = [];
    const thunk = codes => { asked.push(codes); return TABLE; };

    for (const q of ['2+2*8', '100 km in mi', '2.5 GiB in MB', 'today + 30 days',
                     '20% of 300', 'hello world'])
        evaluate(q, { rates: thunk });
    eq(asked.length, 0, 'non-currency queries must not resolve rates');

    evaluate('100 usd in eur', { rates: thunk });
    eq(asked.length, 1, 'a real conversion resolves rates exactly once');
    eq(asked[0], { from: 'USD', to: 'EUR', amount: 100 });
});

it('still accepts a plain table, not just a thunk', () => {
    eq(title('100 usd in eur', { rates: TABLE }), '92 EUR');
});
