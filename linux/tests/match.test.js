// Pins the ranking contract. These tests exist chiefly so the normalization
// rework in match.js cannot silently reorder results: every assertion here
// describes behaviour the command bar depends on, not implementation detail.

import {
    score, scoreAny, scorePre, scoreAnyPre, normalize, byScore, NO_MATCH,
} from '../clipboard-box@dfxe.github.io/match.js';
import { suite, it, eq, ok, descending } from './harness.js';

suite('match');

it('tiers rank exact ▸ prefix ▸ word ▸ substring ▸ subsequence', () => {
    descending([
        ['exact', score('color', 'color')],
        ['prefix', score('color', 'colorful')],
        ['word-start', score('color', 'background-color')],
        ['substring', score('color', 'multicolored')],
        ['subsequence', score('clr', 'cellar')],
    ]);
});

it('a weaker tier never overtakes a stronger one, however long the text', () => {
    const longPrefix = score('a', 'a'.padEnd(400, 'x'));
    const shortSubstring = score('a', 'ba');
    ok(longPrefix > shortSubstring,
        `prefix on a 400-char string (${longPrefix}) must still beat a short substring (${shortSubstring})`);
});

it('shorter text wins within a tier — this is why typing "g" finds the g quicklink', () => {
    ok(score('g', 'g') > score('g', 'github'), 'exact beats prefix');
    ok(score('g', 'git') > score('g', 'gitlab-repository'), 'shorter prefix wins');
});

it('empty query matches everything at a flat score', () => {
    eq(score('', 'anything'), 0);
    eq(score('', ''), 0);
});

it('empty text never matches a real query', () => {
    eq(score('x', ''), NO_MATCH);
    eq(score('x', null), NO_MATCH);
    eq(score('x', undefined), NO_MATCH);
});

it('is case-insensitive and collapses whitespace', () => {
    eq(score('HELLO', 'hello'), score('hello', 'hello'));
    eq(score('a b', 'a   b'), score('a b', 'a b'));
    eq(score('  padded  ', 'padded'), score('padded', 'padded'));
});

it('word starts are recognised after separators, not mid-word', () => {
    ok(score('col', 'background-color') > score('col', 'protocol'),
        'hyphen starts a word; mid-word does not');
    ok(score('shell', 'gnome shell') > score('shell', 'nutshell'));
});

it('subsequence matches ordered gaps and is capped at 12 characters', () => {
    ok(score('bgcol', 'background-color') > NO_MATCH, 'bgcol finds background-color');
    eq(score('zzz', 'background-color'), NO_MATCH, 'out-of-order/absent chars do not match');
    // A 13-character query skips the subsequence branch entirely.
    eq(score('abcdefghijklm', 'a-b-c-d-e-f-g-h-i-j-k-l-m'), NO_MATCH);
});

it('tighter subsequences outrank sparser ones', () => {
    ok(score('abc', 'abcxxxxxxxx') > score('abc', 'axxxbxxxcxx'));
});

it('scoreAny takes the best field', () => {
    eq(scoreAny('gh', ['gh', 'github', 'unrelated']), score('gh', 'gh'));
    eq(scoreAny('nope', ['a', 'b']), NO_MATCH);
    eq(scoreAny('x', []), NO_MATCH);
});

it('byScore sorts by score, then tiebreak, then original index', () => {
    const rows = [
        { id: 'c', score: 10, tiebreak: 0, index: 2 },
        { id: 'a', score: 50, tiebreak: 0, index: 0 },
        { id: 'd', score: 10, tiebreak: 5, index: 3 },
        { id: 'b', score: 50, tiebreak: 9, index: 1 },
    ];
    eq(rows.slice().sort(byScore).map(r => r.id), ['b', 'a', 'd', 'c']);
});

it('byScore is stable for fully equal rows, so the list does not shuffle', () => {
    const rows = [
        { id: 'x', score: 1, index: 0 },
        { id: 'y', score: 1, index: 1 },
        { id: 'z', score: 1, index: 2 },
    ];
    eq(rows.slice().sort(byScore).map(r => r.id), ['x', 'y', 'z']);
});

it('missing tiebreak/index default to zero rather than producing NaN', () => {
    const sorted = [{ id: 'p', score: 1 }, { id: 'q', score: 2 }].sort(byScore);
    eq(sorted.map(r => r.id), ['q', 'p']);
});

// --- The pre-normalized fast path ----------------------------------------
//
// scorePre is what the emoji and history providers actually call. It must agree
// with score() exactly, or the optimization silently reorders the result list.

it('scorePre agrees with score for every tier', () => {
    const cases = [
        ['color', 'color'], ['color', 'colorful'], ['color', 'background-color'],
        ['color', 'multicolored'], ['clr', 'cellar'], ['zzz', 'nothing'],
        ['', 'anything'], ['x', ''], ['bgcol', 'background-color'],
    ];
    for (const [q, t] of cases)
        eq(scorePre(normalize(q), normalize(t)), score(q, t), `${q} vs ${t}`);
});

it('scoreAnyPre agrees with scoreAny', () => {
    const fields = ['gh', 'github', 'a longer description'];
    for (const q of ['gh', 'git', 'desc', 'zzz', ''])
        eq(scoreAnyPre(normalize(q), fields.map(normalize)), scoreAny(q, fields), q);
});

it('scoreAnyPre takes the max, matching the Math.max it replaced', () => {
    const title = normalize('short title');
    const body = normalize('a body that contains short title and much more besides');
    const q = normalize('short title');
    eq(scoreAnyPre(q, [title, body]), Math.max(scorePre(q, title), scorePre(q, body)));
});

it('normalize is idempotent — safe to apply at build time and again later', () => {
    for (const s of ['  MiXeD   Case  ', 'already normal', '', '\tTabs\nand\nnewlines'])
        eq(normalize(normalize(s)), normalize(s), s);
});
