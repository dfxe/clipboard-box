// configStore is imported by prefs.js *and* by the Shell, so it may only import
// GLib/Gio. That constraint is what makes it testable here — a fake settings
// object with get_strv/set_strv is enough to exercise the whole module.

import {
    loadSnippets, saveSnippets, bumpSnippet,
    loadQuicklinks, saveQuicklinks, bumpQuicklink,
    seedQuicklinksOnce, buildUrl, newId, QUICKLINK_SEEDS,
} from '../cboite@dfxe.github.io/configStore.js';
import { suite, it, eq, ok } from './harness.js';

suite('configStore');

// Stands in for Gio.Settings: the module only ever uses these four methods.
function fakeSettings(initial = {}) {
    const strv = { snippets: [], quicklinks: [], ...initial.strv };
    const bools = { 'quicklinks-seeded': false, ...initial.bools };
    return {
        get_strv: k => strv[k] ?? [],
        set_strv: (k, v) => { strv[k] = v; },
        get_boolean: k => bools[k] ?? false,
        set_boolean: (k, v) => { bools[k] = v; },
        _strv: strv,
        _bools: bools,
    };
}

it('round-trips snippets through the JSON-in-strv encoding', () => {
    const s = fakeSettings();
    saveSnippets(s, [{ id: 'a', keyword: 'sig', label: 'Signature', body: 'Best,\nD', uses: 3 }]);
    const back = loadSnippets(s);
    eq(back.length, 1);
    eq(back[0].keyword, 'sig');
    eq(back[0].body, 'Best,\nD', 'newlines survive the round trip');
    eq(back[0].uses, 3);
});

it('fills in defaults for missing snippet fields', () => {
    const s = fakeSettings({ strv: { snippets: [JSON.stringify({ body: 'bare' })] } });
    const [only] = loadSnippets(s);
    eq(only.keyword, '');
    eq(only.label, '');
    eq(only.uses, 0);
    ok(only.id, 'a missing id is generated rather than left undefined');
});

it('drops a snippet with no body but keeps the rest of the list', () => {
    const s = fakeSettings({
        strv: {
            snippets: [
                JSON.stringify({ body: 'keep me' }),
                JSON.stringify({ label: 'no body here' }),
            ],
        },
    });
    eq(loadSnippets(s).map(x => x.body), ['keep me']);
});

it('survives a corrupt row without losing the whole list', () => {
    const s = fakeSettings({
        strv: {
            snippets: ['{not json at all', JSON.stringify({ body: 'survivor' })],
        },
    });
    eq(loadSnippets(s).map(x => x.body), ['survivor']);
});

it('bumpSnippet increments only the addressed entry', () => {
    const s = fakeSettings();
    saveSnippets(s, [
        { id: 'a', body: 'A', uses: 0 },
        { id: 'b', body: 'B', uses: 7 },
    ]);
    bumpSnippet(s, 'b');
    const byId = Object.fromEntries(loadSnippets(s).map(x => [x.id, x.uses]));
    eq(byId, { a: 0, b: 8 });
});

it('bumpSnippet on an unknown id is a no-op, not a throw', () => {
    const s = fakeSettings();
    saveSnippets(s, [{ id: 'a', body: 'A', uses: 1 }]);
    bumpSnippet(s, 'nope');
    eq(loadSnippets(s)[0].uses, 1);
});

it('quicklinks round-trip and bump the same way', () => {
    const s = fakeSettings();
    saveQuicklinks(s, [{ id: 'q', keyword: 'gh', name: 'GitHub', url: 'https://x/{query}', uses: 0 }]);
    bumpQuicklink(s, 'q');
    eq(loadQuicklinks(s)[0].uses, 1);
});

it('seeds quicklinks exactly once, and deleting them keeps them deleted', () => {
    const s = fakeSettings();
    seedQuicklinksOnce(s);
    eq(loadQuicklinks(s).length, QUICKLINK_SEEDS.length);

    saveQuicklinks(s, []);          // user deletes every one
    seedQuicklinksOnce(s);          // must not bring them back
    eq(loadQuicklinks(s).length, 0);
});

it('does not seed over a list that already has entries', () => {
    const s = fakeSettings({
        strv: { quicklinks: [JSON.stringify({ id: 'mine', keyword: 'k', name: 'n', url: 'u' })] },
    });
    seedQuicklinksOnce(s);
    eq(loadQuicklinks(s).map(q => q.id), ['mine']);
});

it('buildUrl percent-encodes the argument', () => {
    eq(buildUrl('https://s/?q={query}', 'a b&c'), 'https://s/?q=a%20b%26c');
    eq(buildUrl('https://s/?q={query}', ''), 'https://s/?q=');
    eq(buildUrl('https://s/?q={query}', null), 'https://s/?q=');
});

it('buildUrl leaves a URL with no placeholder untouched', () => {
    eq(buildUrl('https://example.com', 'ignored'), 'https://example.com');
});

it('buildUrl replaces every occurrence of the placeholder', () => {
    eq(buildUrl('https://s/{query}/x/{query}', 'a'), 'https://s/a/x/a');
});

it('newId produces distinct ids', () => {
    ok(newId() !== newId());
});

it('a null settings object is tolerated rather than throwing', () => {
    eq(loadSnippets(null), []);
    eq(loadQuicklinks(null), []);
    saveSnippets(null, [{ body: 'x' }]);   // must not throw
});
