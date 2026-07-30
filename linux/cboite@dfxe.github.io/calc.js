// The command bar's Answer section: arithmetic, unit conversion, percentages
// and date maths, evaluated as you type.
//
// There is no eval() and no new Function() here, and there must never be. This
// module runs inside the compositor process with the full privileges of the
// session, on a string the user can paste anything into. A tokenizer and a
// recursive-descent parser cost about 150 lines and close that door completely.
//
// evaluate() returns null for anything it does not confidently understand. That
// matters more than it sounds: the Answer row is only drawn when this returns
// something, so a loose parser would grow a spurious answer under every
// one-letter query.

import GLib from 'gi://GLib';

import { convertUnits, lookupUnit } from './units.js';

const CONSTANTS = {
    pi: Math.PI,
    π: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
    inf: Infinity,
};

const FUNCTIONS = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    round: Math.round, floor: Math.floor, ceil: Math.ceil,
    ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sign: Math.sign, trunc: Math.trunc,
    min: Math.min, max: Math.max,
};

const VARIADIC = new Set(['min', 'max']);

// --- Tokenizer -----------------------------------------------------------

// Order matters — first alternative wins. Comma grouping is only accepted in
// real 3-digit groups, or `max(3,9,2)` would tokenize as the single number 392.
const NUM_RE = new RegExp('^(?:' + [
    '0[xX][0-9a-fA-F]+',                    // hex
    '0[bB][01]+',                           // binary
    '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?',     // 1,234,567.89
    '(?:\\d[\\d_]*)?\\.\\d+(?:[eE][+-]?\\d+)?', // 1.5, .5, 1.5e3
    '\\d[\\d_]*(?:[eE][+-]?\\d+)?',         // 42, 1_000, 2e8
].join('|') + ')');
const NAME_RE = /^[a-zA-Zπ_][a-zA-Z0-9_]*/;

function tokenize(input) {
    const tokens = [];
    let s = input;
    while (s.length > 0) {
        const ch = s[0];
        if (/\s/.test(ch)) { s = s.slice(1); continue; }

        const num = NUM_RE.exec(s);
        if (num) {
            const raw = num[0];
            // Reject "1,2,3" style noise but accept "1,234,567" and "1_000".
            const cleaned = raw.replace(/[_,]/g, '');
            const value = /^0[xX]/.test(cleaned) || /^0[bB]/.test(cleaned)
                ? Number(cleaned)
                : parseFloat(cleaned);
            if (!Number.isFinite(value)) return null;
            tokens.push({ type: 'num', value });
            s = s.slice(raw.length);
            continue;
        }

        const name = NAME_RE.exec(s);
        if (name) {
            tokens.push({ type: 'name', value: name[0] });
            s = s.slice(name[0].length);
            continue;
        }

        if ('+-*/%^(),'.includes(ch)) {
            tokens.push({ type: ch });
            s = s.slice(1);
            continue;
        }
        // Accept the typographic operators people paste in from documents.
        if (ch === '×') { tokens.push({ type: '*' }); s = s.slice(1); continue; }
        if (ch === '÷') { tokens.push({ type: '/' }); s = s.slice(1); continue; }
        if (ch === '−') { tokens.push({ type: '-' }); s = s.slice(1); continue; }

        return null; // an unknown character means this isn't arithmetic
    }
    return tokens;
}

// --- Parser --------------------------------------------------------------
//
//   expr  := term (('+'|'-') term)*
//   term  := power (('*'|'/'|'%') power)*
//   power := unary ('^' power)?          -- right associative
//   unary := ('-'|'+') unary | atom
//   atom  := num | const | func '(' expr (',' expr)* ')' | '(' expr ')'

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
        // Set when a bare name resolves to nothing — the difference between
        // "this is broken arithmetic" and "this was never arithmetic".
        this.sawUnknownName = false;
    }

    peek() { return this.tokens[this.pos]; }
    next() { return this.tokens[this.pos++]; }
    accept(type) {
        if (this.peek()?.type === type) { this.pos++; return true; }
        return false;
    }

    parse() {
        const value = this.expr();
        if (value === null || this.pos !== this.tokens.length) return null;
        return value;
    }

    expr() {
        let left = this.term();
        if (left === null) return null;
        for (;;) {
            if (this.accept('+')) {
                const right = this.term();
                if (right === null) return null;
                left += right;
            } else if (this.accept('-')) {
                const right = this.term();
                if (right === null) return null;
                left -= right;
            } else return left;
        }
    }

    term() {
        let left = this.power();
        if (left === null) return null;
        for (;;) {
            if (this.accept('*')) {
                const right = this.power();
                if (right === null) return null;
                left *= right;
            } else if (this.accept('/')) {
                const right = this.power();
                if (right === null) return null;
                left /= right;
            } else if (this.accept('%')) {
                const right = this.power();
                if (right === null) return null;
                left %= right;
            } else return left;
        }
    }

    power() {
        const base = this.unary();
        if (base === null) return null;
        if (this.accept('^')) {
            const exp = this.power();
            if (exp === null) return null;
            return base ** exp;
        }
        return base;
    }

    unary() {
        if (this.accept('-')) {
            const v = this.unary();
            return v === null ? null : -v;
        }
        if (this.accept('+')) return this.unary();
        return this.atom();
    }

    atom() {
        const token = this.next();
        if (!token) return null;

        if (token.type === 'num') return token.value;

        if (token.type === '(') {
            const v = this.expr();
            if (v === null || !this.accept(')')) return null;
            return v;
        }

        if (token.type === 'name') {
            const lower = token.value.toLowerCase();

            if (this.peek()?.type === '(') {
                const fn = FUNCTIONS[lower];
                if (!fn) { this.sawUnknownName = true; return null; }
                this.pos++; // consume '('
                const args = [];
                if (!this.accept(')')) {
                    for (;;) {
                        const arg = this.expr();
                        if (arg === null) return null;
                        args.push(arg);
                        if (this.accept(',')) continue;
                        if (this.accept(')')) break;
                        return null;
                    }
                }
                if (!VARIADIC.has(lower) && args.length !== 1) return null;
                return fn(...args);
            }

            if (lower in CONSTANTS) return CONSTANTS[lower];
            this.sawUnknownName = true;
            return null;
        }

        return null;
    }
}

// Evaluate a pure arithmetic string. Returns null if it isn't arithmetic.
function arithmetic(text) {
    const tokens = tokenize(text);
    if (!tokens || tokens.length === 0) return null;

    // A lone name or number is not a calculation worth showing an answer for —
    // "e" is a search for the letter e, not a request for 2.718.
    if (tokens.length === 1) return null;

    const parser = new Parser(tokens);
    const value = parser.parse();
    if (value === null || !Number.isFinite(value)) return null;
    return value;
}

// --- Formatting ----------------------------------------------------------

export function formatNumber(n) {
    if (!Number.isFinite(n)) return String(n);
    if (Number.isInteger(n) && Math.abs(n) < 1e15)
        return n.toLocaleString('en-US');

    const abs = Math.abs(n);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return n.toExponential(6);

    // Round away binary floating-point noise (0.1 + 0.2), then drop the
    // trailing zeros that rounding leaves behind.
    const rounded = Number(n.toPrecision(12));
    const [int, frac] = String(rounded).split('.');
    const grouped = Number(int).toLocaleString('en-US');
    return frac ? `${grouped}.${frac}` : grouped;
}

// --- Layer 1: percentages ------------------------------------------------

function percentages(text) {
    let m = /^([\d.,_\s+\-*/^()]+)\s*%\s+(?:of)\s+(.+)$/i.exec(text);
    if (m) {
        const pct = arithmeticOrNumber(m[1]);
        const of = arithmeticOrNumber(m[2]);
        if (pct !== null && of !== null)
            return { value: pct / 100 * of, note: `${formatNumber(pct)}% of ${formatNumber(of)}` };
    }

    m = /^(.+?)\s*([+-])\s*([\d.,_]+)\s*%$/.exec(text);
    if (m) {
        const base = arithmeticOrNumber(m[1]);
        const pct = arithmeticOrNumber(m[3]);
        if (base !== null && pct !== null) {
            const delta = base * pct / 100;
            return {
                value: m[2] === '+' ? base + delta : base - delta,
                note: `${formatNumber(base)} ${m[2]} ${formatNumber(pct)}%`,
            };
        }
    }

    m = /^([\d.,_]+)\s*%\s+off\s+(.+)$/i.exec(text);
    if (m) {
        const pct = arithmeticOrNumber(m[1]);
        const base = arithmeticOrNumber(m[2]);
        if (pct !== null && base !== null)
            return { value: base - base * pct / 100, note: `${formatNumber(pct)}% off ${formatNumber(base)}` };
    }

    m = /^(.+?)\s+as\s+(?:a\s+)?%\s+of\s+(.+)$/i.exec(text);
    if (m) {
        const part = arithmeticOrNumber(m[1]);
        const whole = arithmeticOrNumber(m[2]);
        if (part !== null && whole !== null && whole !== 0)
            return { value: part / whole * 100, suffix: '%', note: `${formatNumber(part)} of ${formatNumber(whole)}` };
    }

    return null;
}

// Percent operands are often a bare number, which arithmetic() deliberately
// rejects; accept either here.
function arithmeticOrNumber(text) {
    const trimmed = (text ?? '').trim();
    if (trimmed === '') return null;
    const bare = NUM_RE.exec(trimmed);
    if (bare && bare[0].length === trimmed.length) {
        const cleaned = trimmed.replace(/[_,]/g, '');
        const v = /^0[xXbB]/.test(cleaned) ? Number(cleaned) : parseFloat(cleaned);
        return Number.isFinite(v) ? v : null;
    }
    return arithmetic(trimmed);
}

// --- Layer 2: unit conversion --------------------------------------------

const CONVERT_RE = /^(.+?)\s*(?:\s(?:in|to|as)\s)\s*([^\s]+)$/i;

function conversion(text) {
    const m = CONVERT_RE.exec(text);
    if (!m) return null;

    const target = m[2].trim();
    if (!lookupUnit(target)) return null;

    // Split the left side into a quantity and its unit: the unit is the
    // trailing run of non-space, non-digit characters.
    const left = m[1].trim();
    const lm = /^(.*?)\s*([a-zA-Zµ°"'\/²³]+[0-9]?)$/.exec(left);
    if (!lm) return null;

    const fromUnit = lm[2];
    if (!lookupUnit(fromUnit)) return null;

    const amount = arithmeticOrNumber(lm[1]);
    if (amount === null) return null;

    const value = convertUnits(amount, fromUnit, target);
    if (value === null || !Number.isFinite(value)) return null;

    return {
        value,
        suffix: ` ${target}`,
        note: `${formatNumber(amount)} ${fromUnit}`,
    };
}

// --- Layer 3: dates ------------------------------------------------------
//
// GLib.DateTime throughout rather than JS Date, to match relativeAge() and to
// get the session's timezone handling for free.

const DATE_UNITS = {
    day: 'days', days: 'days', d: 'days',
    week: 'weeks', weeks: 'weeks', wk: 'weeks',
    month: 'months', months: 'months', mo: 'months',
    year: 'years', years: 'years', yr: 'years',
    hour: 'hours', hours: 'hours', h: 'hours',
    minute: 'minutes', minutes: 'minutes', min: 'minutes',
};

function parseDateWord(word) {
    const w = word.trim().toLowerCase();
    const today = GLib.DateTime.new_now_local();
    if (w === 'today') return today;
    if (w === 'now') return today;
    if (w === 'tomorrow') return today.add_days(1);
    if (w === 'yesterday') return today.add_days(-1);

    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
    if (iso) {
        return GLib.DateTime.new_local(
            Number(iso[1]), Number(iso[2]), Number(iso[3]), 0, 0, 0);
    }
    return null;
}

function shiftBy(date, amount, unit) {
    switch (unit) {
    case 'days': return date.add_days(amount);
    case 'weeks': return date.add_weeks(amount);
    case 'months': return date.add_months(amount);
    case 'years': return date.add_years(amount);
    case 'hours': return date.add_hours(amount);
    case 'minutes': return date.add_minutes(amount);
    default: return null;
    }
}

function dates(text) {
    const t = text.trim();
    const lower = t.toLowerCase();

    if (lower === 'now') {
        const now = GLib.DateTime.new_now_local();
        return { text: now.format('%Y-%m-%d %H:%M:%S'), note: 'Now' };
    }
    if (lower === 'today' || lower === 'tomorrow' || lower === 'yesterday') {
        const d = parseDateWord(lower);
        return { text: d.format('%Y-%m-%d'), note: lower[0].toUpperCase() + lower.slice(1) };
    }

    // today + 30 days
    let m = /^(.+?)\s*([+-])\s*([\d.]+)\s+(\w+)$/.exec(t);
    if (m) {
        const base = parseDateWord(m[1]);
        const unit = DATE_UNITS[m[4].toLowerCase()];
        const amount = parseFloat(m[3]);
        if (base && unit && Number.isFinite(amount)) {
            const signed = m[2] === '-' ? -amount : amount;
            const result = shiftBy(base, Math.round(signed), unit);
            if (result) {
                const showTime = unit === 'hours' || unit === 'minutes';
                return {
                    text: result.format(showTime ? '%Y-%m-%d %H:%M' : '%Y-%m-%d'),
                    note: `${m[1].trim()} ${m[2]} ${m[3]} ${m[4]}`,
                };
            }
        }
    }

    // days until 2026-12-25   /   2026-12-25 - today
    m = /^days?\s+(?:until|to|since)\s+(.+)$/i.exec(t);
    if (m) {
        const target = parseDateWord(m[1]);
        if (target) {
            const days = Math.round(
                target.difference(GLib.DateTime.new_now_local()) / 1e6 / 86400);
            return { text: `${formatNumber(days)} days`, note: `until ${m[1].trim()}` };
        }
    }

    m = /^(.+?)\s+-\s+(.+)$/.exec(t);
    if (m) {
        const a = parseDateWord(m[1]);
        const b = parseDateWord(m[2]);
        if (a && b) {
            const days = Math.round(a.difference(b) / 1e6 / 86400);
            return { text: `${formatNumber(days)} days`, note: `${m[1].trim()} − ${m[2].trim()}` };
        }
    }

    // Unix timestamp, either explicit or a bare 10-digit number.
    m = /^(?:unix\s+)?(\d{10}|\d{13})$/i.exec(t);
    if (m && /^unix\s/i.test(t)) {
        const secs = m[1].length === 13 ? Number(m[1]) / 1000 : Number(m[1]);
        const d = GLib.DateTime.new_from_unix_local(Math.floor(secs));
        if (d) return { text: d.format('%Y-%m-%d %H:%M:%S'), note: `unix ${m[1]}` };
    }

    return null;
}

// --- Entry point ---------------------------------------------------------

// Returns { title, subtitle, copyText } or null.
//
// `rates` is an optional { base, rates: {CODE: factor}, fetchedAt } table; when
// absent, currency queries simply don't resolve and no Answer row appears.
//
// It may instead be a function `({from, to}) => table`. That form is called only
// after the text has parsed as a currency conversion, which is what lets the
// caller put a network fetch behind it without every other query triggering one.
export function evaluate(query, { rates = null } = {}) {
    const text = (query ?? '').trim();
    if (text.length < 2 || text.length > 200) return null;

    // Dates before arithmetic: "today + 30 days" would otherwise be seen as a
    // failed sum rather than a date shift.
    const date = dates(text);
    if (date) return { title: date.text, subtitle: date.note, copyText: date.text };

    const pct = percentages(text);
    if (pct) {
        const display = `${formatNumber(pct.value)}${pct.suffix ?? ''}`;
        return { title: display, subtitle: pct.note, copyText: display };
    }

    const money = currency(text, rates);
    if (money) return money;

    const converted = conversion(text);
    if (converted) {
        const display = `${formatNumber(converted.value)}${converted.suffix}`;
        return { title: display, subtitle: converted.note, copyText: formatNumber(converted.value) };
    }

    const value = arithmetic(text);
    if (value !== null) {
        const display = formatNumber(value);
        return { title: display, subtitle: text, copyText: display };
    }

    return null;
}

// --- Currency ------------------------------------------------------------

const CODE_RE = /^[A-Za-z]{3}$/;
const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB' };

// Split "<amount> <CODE> in <CODE>" into its parts. Pure text work — no rate
// table involved — so it can gate whether a table is worth resolving at all.
export function parseCurrency(text) {
    const m = CONVERT_RE.exec(text);
    if (!m) return null;

    const to = normalizeCode(m[2]);
    if (!to) return null;

    // The currency can trail the amount ("50 USD", "50€") or lead it ("$50").
    const left = m[1].trim();
    let from = null;
    let amountText = null;

    let lm = /^(.*?)\s*([A-Za-z]{3}|[$€£¥₹₽])$/.exec(left);
    if (lm) {
        from = normalizeCode(lm[2]);
        amountText = lm[1];
    }
    if (!from) {
        lm = /^([$€£¥₹₽])\s*(.+)$/.exec(left);
        if (lm) {
            from = normalizeCode(lm[1]);
            amountText = lm[2];
        }
    }
    if (!from) return null;

    const amount = arithmeticOrNumber(amountText);
    if (amount === null) return null;

    return { from, to, amount };
}

function currency(text, rates) {
    // Parse before resolving the table. `rates` may be a thunk that reaches for
    // the network, and nothing should trigger that until the text genuinely
    // reads as a currency conversion.
    const parsed = parseCurrency(text);
    if (!parsed) return null;

    const table = typeof rates === 'function' ? rates(parsed) : rates;
    if (!table?.rates) return null;

    const { from, to, amount } = parsed;
    const value = convertCurrency(amount, from, to, table);
    if (value === null) return null;

    const display = `${formatNumber(value)} ${to}`;
    const age = table.fetchedAt
        ? ` · rates ${rateAge(table.fetchedAt)}`
        : '';
    return {
        title: display,
        subtitle: `${formatNumber(amount)} ${from}${age}`,
        copyText: formatNumber(value),
    };
}

function normalizeCode(raw) {
    const token = (raw ?? '').trim();
    if (SYMBOLS[token]) return SYMBOLS[token];
    return CODE_RE.test(token) ? token.toUpperCase() : null;
}

// Rates are quoted against a single base, so cross rates go via that base.
function convertCurrency(amount, from, to, table) {
    const rates = { ...table.rates, [table.base]: 1 };
    const fromRate = rates[from];
    const toRate = rates[to];
    if (!fromRate || !toRate) return null;
    return amount / fromRate * toRate;
}

function rateAge(iso) {
    const then = GLib.DateTime.new_from_iso8601(iso, null);
    if (!then) return 'cached';
    const days = Math.floor(
        GLib.DateTime.new_now_local().difference(then) / 1e6 / 86400);
    if (days <= 0) return 'today';
    if (days === 1) return 'from yesterday';
    return `from ${days}d ago`;
}
