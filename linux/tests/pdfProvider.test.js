import { pdfProvider } from '../omelette@dfxe.github.io/pdfProvider.js';
import { suite, it, eq, ok } from './harness.js';

suite('pdfProvider');

// The provider only reads two things off ctx, so a stand-in is two lines —
// the same hand-rolled-fake approach configStore.test.js takes for Gio.Settings.
const ctx = ({ missing = [], scope = null } = {}) => ({
    scope,
    pdfMissing: () => missing,
});

it('offers the tool for its own name', () => {
    const results = pdfProvider.search('pdf', ctx());
    eq(results.length, 1);
    eq(results[0].id, 'pdf:open');
});

it('answers to a prefix of each keyword', () => {
    for (const query of ['pdf', 'ext', 'extract', 'spl', 'split'])
        eq(pdfProvider.search(query, ctx()).length, 1, query);
});

it('ignores queries too short to be meant', () => {
    eq(pdfProvider.search('p', ctx()).length, 0);
    eq(pdfProvider.search('pd', ctx()).length, 0);
    eq(pdfProvider.search('', ctx()).length, 0);
});

// The whole point of prefix-only scoring: the loose subsequence tier that makes
// `bgcol` find `background-color` would drag this section into unrelated
// searches, because p-d-f runs in order through plenty of ordinary words.
it('stays out of searches that merely contain its letters', () => {
    for (const query of ['prepared for', 'spilt milk', 'exact', 'padfoot', 'update file'])
        eq(pdfProvider.search(query, ctx()).length, 0, query);
});

it('does not answer to "pages", too ordinary a word to claim', () => {
    eq(pdfProvider.search('pages', ctx()).length, 0);
});

it('offers nothing when poppler is not installed', () => {
    eq(pdfProvider.search('pdf', ctx({ missing: ['pdfunite'] })).length, 0);
});

it('opens the tool rather than copying anything', () => {
    const [result] = pdfProvider.search('pdf', ctx());
    let opened = null;
    const outcome = result.run({ openTool: scope => { opened = scope; } });
    eq(opened, 'pdf');
    // No flash and no close: the popup stays up and becomes the panel.
    eq(outcome, null);
});

it('survives a context with no openTool, the way every other run() does', () => {
    const [result] = pdfProvider.search('pdf', ctx());
    eq(result.run({}), null);
});

it('scores an exact keyword above a partial one', () => {
    const exact = pdfProvider.search('pdf', ctx())[0].score;
    const partial = pdfProvider.search('pd', { ...ctx(), scope: null });
    // 'pd' is below MIN_QUERY, so compare against the shortest query that runs.
    const looser = pdfProvider.search('ext', ctx())[0].score;
    ok(exact > 0);
    ok(exact >= looser, 'an exact keyword should not rank below a prefix');
    eq(partial.length, 0);
});

// --- emptyMessage ---

it('says nothing in the ordinary bar, even with poppler missing', () => {
    eq(pdfProvider.emptyMessage(ctx({ missing: ['pdfinfo'] })), null);
});

it('explains itself only when opened by its own shortcut', () => {
    const message = pdfProvider.emptyMessage(ctx({ missing: ['pdfinfo'], scope: 'pdf' }));
    ok(message.includes('poppler-utils'), message);
    ok(message.includes('pdfinfo'), message);
});

it('has nothing to say when scoped and poppler is present', () => {
    eq(pdfProvider.emptyMessage(ctx({ scope: 'pdf' })), null);
});

it('declares the shape the registry and the panel table expect', () => {
    eq(pdfProvider.id, 'pdf');
    ok(typeof pdfProvider.title === 'string' && pdfProvider.title !== '');
    ok(pdfProvider.cap >= 1);
    ok(typeof pdfProvider.search === 'function');
});
