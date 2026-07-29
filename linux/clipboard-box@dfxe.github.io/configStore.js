// Storage for the two user-editable lists: snippets and quicklinks.
//
// Both live in GSettings as an `as` of JSON strings, one object per entry.
//
// GSettings rather than a JSON file specifically because prefs.js runs in a
// *separate process* from extension.js. GSettings gives cross-process change
// notification for free — the prefs window writes, `changed::snippets` fires in
// the Shell, the popup rebuilds — where a file would need a Gio.FileMonitor on
// both sides to get the same result. These lists are small and edited by hand;
// dconf handles that size without complaint.
//
// This module is imported by prefs.js as well as by the Shell, so it may only
// import GLib/Gio — never St, Clutter, or anything under resource:///.

import GLib from 'gi://GLib';

function parseAll(settings, key) {
    if (!settings) return [];
    const out = [];
    for (const raw of settings.get_strv(key)) {
        try {
            const item = JSON.parse(raw);
            if (item && typeof item === 'object') out.push(item);
        } catch (_) {
            // A single corrupt row shouldn't take the whole list with it.
        }
    }
    return out;
}

function writeAll(settings, key, items) {
    if (!settings) return;
    settings.set_strv(key, items.map(it => JSON.stringify(it)));
}

export function newId() {
    return GLib.uuid_string_random();
}

// --- Snippets ------------------------------------------------------------
// { id, keyword, label, body, uses }

export function loadSnippets(settings) {
    return parseAll(settings, 'snippets')
        .filter(s => typeof s.body === 'string')
        .map(s => ({
            id: s.id ?? newId(),
            keyword: s.keyword ?? '',
            label: s.label ?? '',
            body: s.body,
            uses: Number(s.uses) || 0,
        }));
}

export function saveSnippets(settings, items) {
    writeAll(settings, 'snippets', items);
}

export function bumpSnippet(settings, id) {
    const items = loadSnippets(settings);
    const hit = items.find(s => s.id === id);
    if (!hit) return;
    hit.uses += 1;
    saveSnippets(settings, items);
}

// --- Quicklinks ----------------------------------------------------------
// { id, keyword, name, url, uses } — `url` may contain {query}

export const QUICKLINK_SEEDS = [
    { keyword: 'g', name: 'Google', url: 'https://www.google.com/search?q={query}' },
    { keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
    { keyword: 'gh', name: 'GitHub', url: 'https://github.com/search?q={query}' },
    { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query={query}' },
    { keyword: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search={query}' },
    { keyword: 'so', name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q={query}' },
    { keyword: 'npm', name: 'npm', url: 'https://www.npmjs.com/search?q={query}' },
    { keyword: 'mdn', name: 'MDN', url: 'https://developer.mozilla.org/en-US/search?q={query}' },
    { keyword: 'tr', name: 'Google Translate', url: 'https://translate.google.com/?text={query}' },
];

export function loadQuicklinks(settings) {
    return parseAll(settings, 'quicklinks')
        .filter(q => typeof q.url === 'string' && q.url !== '')
        .map(q => ({
            id: q.id ?? newId(),
            keyword: q.keyword ?? '',
            name: q.name ?? q.keyword ?? 'Link',
            url: q.url,
            uses: Number(q.uses) || 0,
        }));
}

export function saveQuicklinks(settings, items) {
    writeAll(settings, 'quicklinks', items);
}

export function bumpQuicklink(settings, id) {
    const items = loadQuicklinks(settings);
    const hit = items.find(q => q.id === id);
    if (!hit) return;
    hit.uses += 1;
    saveQuicklinks(settings, items);
}

// Seed the defaults exactly once. Guarded by its own flag rather than by "is
// the list empty", so deleting every quicklink stays deleted.
export function seedQuicklinksOnce(settings) {
    if (!settings || settings.get_boolean('quicklinks-seeded')) return;
    settings.set_boolean('quicklinks-seeded', true);
    if (settings.get_strv('quicklinks').length > 0) return;
    saveQuicklinks(settings,
        QUICKLINK_SEEDS.map(q => ({ ...q, id: newId(), uses: 0 })));
}

// Substitute the argument into a quicklink URL. Percent-encoded, because the
// argument is arbitrary user text going into a URL.
export function buildUrl(url, args) {
    if (!url.includes('{query}')) return url;
    return url.replaceAll('{query}', encodeURIComponent(args ?? ''));
}
