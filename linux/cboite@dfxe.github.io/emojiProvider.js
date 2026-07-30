// Emoji and symbol picker.
//
// The dataset is GNOME Shell's own — the on-screen keyboard already ships 2623
// emoji at a stable resource path, so this extension bundles nothing. That
// means no download weight, no Unicode-version maintenance, and whatever the
// running Shell knows about is exactly what we offer. Wrapped in a try/catch
// with a small fallback list in case a future Shell moves it.
//
// Loading is lazy and happens at most once per gnome-shell process (ESM modules
// survive disable/enable), not once per enable. Measured cost is a few
// milliseconds, paid the first time someone actually searches for an emoji.

import Gio from 'gi://Gio';

import { ingestText } from './clipboardUtil.js';
import { scorePre, normalize, byScore, NO_MATCH } from './match.js';

const RESOURCE = '/org/gnome/shell/osk-layouts/emoji.json';
const MAX_RECENTS = 32;

// Unicode names are poor search keys — nobody types "face with tears of joy".
// These nicknames are the single biggest quality difference in this file.
const ALIASES = {
    '😂': ['lol', 'joy'], '🤣': ['rofl', 'lmao'], '😊': ['blush', 'smile'],
    '😉': ['wink'], '😍': ['heart eyes', 'love'], '🥰': ['love', 'adore'],
    '😎': ['cool', 'sunglasses'], '🤔': ['think', 'hmm'], '😅': ['sweat', 'phew'],
    '🙃': ['upside down', 'irony'], '😴': ['sleep', 'zzz'], '🤷': ['shrug'],
    '🤦': ['facepalm'], '😢': ['sad', 'cry'], '😭': ['sob', 'crying'],
    '😡': ['angry', 'mad'], '🥳': ['party', 'celebrate'], '😱': ['scream', 'shock'],
    '👍': ['+1', 'thumbsup', 'yes', 'lgtm'], '👎': ['-1', 'thumbsdown', 'no'],
    '👌': ['ok'], '🙏': ['pray', 'thanks', 'please'], '👏': ['clap', 'applause'],
    '🤝': ['handshake', 'deal'], '💪': ['strong', 'muscle'], '👀': ['eyes', 'look'],
    '🔥': ['fire', 'lit', 'hot'], '💯': ['100', 'perfect'], '✨': ['sparkles', 'shiny'],
    '🎉': ['tada', 'party', 'celebrate'], '🚀': ['rocket', 'ship', 'launch'],
    '💡': ['idea', 'lightbulb'], '⚡': ['zap', 'fast'], '🐛': ['bug'],
    '✅': ['check', 'done', 'tick'], '❌': ['x', 'no', 'fail'], '⚠️': ['warning', 'warn'],
    '❤️': ['heart', 'love'], '💔': ['broken heart'], '🎯': ['target', 'bullseye'],
    '📌': ['pin'], '🔗': ['link'], '🔒': ['lock', 'secure'], '🔑': ['key'],
    '⏰': ['alarm', 'clock'], '📝': ['note', 'memo', 'write'], '📦': ['package', 'box'],
    '🍕': ['pizza'], '☕': ['coffee'], '🍺': ['beer'], '🎂': ['cake', 'birthday'],
};

// Things people hunt for that are not emoji at all.
const SYMBOLS = [
    { char: '→', name: 'right arrow' }, { char: '←', name: 'left arrow' },
    { char: '↑', name: 'up arrow' }, { char: '↓', name: 'down arrow' },
    { char: '↔', name: 'left right arrow' }, { char: '⇒', name: 'double right arrow' },
    { char: '⇔', name: 'double left right arrow' }, { char: '↵', name: 'return arrow' },
    { char: '…', name: 'ellipsis' }, { char: '–', name: 'en dash' },
    { char: '—', name: 'em dash' }, { char: '·', name: 'middle dot bullet' },
    { char: '•', name: 'bullet' }, { char: '§', name: 'section sign' },
    { char: '¶', name: 'pilcrow paragraph' }, { char: '†', name: 'dagger' },
    { char: '‰', name: 'per mille' }, { char: '№', name: 'numero' },
    { char: '©', name: 'copyright' }, { char: '®', name: 'registered' },
    { char: '™', name: 'trademark' }, { char: '°', name: 'degree' },
    { char: '±', name: 'plus minus' }, { char: '×', name: 'multiplication times' },
    { char: '÷', name: 'division' }, { char: '≠', name: 'not equal' },
    { char: '≈', name: 'approximately equal' }, { char: '≤', name: 'less than or equal' },
    { char: '≥', name: 'greater than or equal' }, { char: '∞', name: 'infinity' },
    { char: '√', name: 'square root' }, { char: '∑', name: 'sum sigma' },
    { char: '∏', name: 'product pi' }, { char: '∫', name: 'integral' },
    { char: '∂', name: 'partial derivative' }, { char: '∆', name: 'delta increment' },
    { char: '∈', name: 'element of' }, { char: '∅', name: 'empty set' },
    { char: 'µ', name: 'micro' }, { char: 'Ω', name: 'ohm omega' },
    { char: 'π', name: 'pi' }, { char: 'α', name: 'alpha' }, { char: 'β', name: 'beta' },
    { char: 'λ', name: 'lambda' }, { char: 'Δ', name: 'capital delta' },
    { char: '“', name: 'left double quote' }, { char: '”', name: 'right double quote' },
    { char: '‘', name: 'left single quote' }, { char: '’', name: 'right single quote apostrophe' },
    { char: '«', name: 'left guillemet' }, { char: '»', name: 'right guillemet' },
    { char: '✓', name: 'check mark tick' }, { char: '✔', name: 'heavy check mark' },
    { char: '✗', name: 'ballot x cross' }, { char: '★', name: 'star filled' },
    { char: '☆', name: 'star outline' }, { char: '♥', name: 'heart suit' },
    { char: '⌘', name: 'command key' }, { char: '⌥', name: 'option alt key' },
    { char: '⇧', name: 'shift key' }, { char: '⏎', name: 'enter return key' },
    { char: '⌫', name: 'backspace delete key' }, { char: '⎋', name: 'escape key' },
    { char: '€', name: 'euro' }, { char: '£', name: 'pound sterling' },
    { char: '¥', name: 'yen' }, { char: '¢', name: 'cent' }, { char: '₹', name: 'rupee' },
    // Invisible characters are genuinely hard to obtain any other way.
    { char: ' ', name: 'non breaking space' },
    { char: '​', name: 'zero width space' },
    { char: ' ', name: 'em space' },
];

const FALLBACK = Object.keys(ALIASES).map(char => ({ char, name: ALIASES[char][0] }));

let _index = null;
let _tried = false;

function buildIndex() {
    if (_tried) return _index;
    _tried = true;

    let entries;
    try {
        const bytes = Gio.resources_lookup_data(RESOURCE, Gio.ResourceLookupFlags.NONE);
        const parsed = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        entries = parsed
            // Skin-tone and gender variants trip over each other in a result
            // list; the base emoji is what people mean.
            .filter(e => e?.char && e?.name && !e.name.includes(' skin tone'))
            .map(e => ({ char: e.char, name: e.name }));
    } catch (e) {
        log(`cboite: Shell emoji data unavailable (${e.message}); using fallback list`);
        entries = FALLBACK;
    }

    _index = entries.concat(SYMBOLS).map(e => ({
        char: e.char,
        name: e.name,
        // Pre-normalized and pre-joined so scoring never allocates per
        // keystroke. This must use the same normalize() the scorer would have
        // applied, or scorePre below silently mis-scores: lowercase alone is
        // not enough, whitespace has to be collapsed too.
        haystack: normalize(`${e.name} ${(ALIASES[e.char] ?? []).join(' ')}`),
    }));
    return _index;
}

function recents(settings) {
    return settings ? settings.get_strv('emoji-recents') : [];
}

function bumpRecent(settings, char) {
    if (!settings) return;
    const list = recents(settings).filter(c => c !== char);
    list.unshift(char);
    settings.set_strv('emoji-recents', list.slice(0, MAX_RECENTS));
}

function emojiResult(entry, matchScore, tiebreak, index) {
    const cp = entry.char.codePointAt(0);
    return {
        id: `emoji:${entry.char}`,
        score: matchScore,
        tiebreak,
        index,
        title: `${entry.char}  ${entry.name}`,
        subtitle: cp ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : '',
        visual: { kind: 'glyph', text: entry.char },
        accel: 'Paste',
        run: ctx => {
            // Not stored in history — a single character would push out the
            // copies you were actually keeping.
            ingestText(entry.char, ctx, { store: false });
            bumpRecent(ctx.settings, entry.char);
            return { message: `Copied ${entry.char}`, close: true };
        },
    };
}

export const emojiProvider = {
    id: 'emoji',
    title: 'Emoji & symbols',
    cap: 8,

    search(query, ctx) {
        const scoped = ctx.scope === 'emoji';

        // One character matches almost everything, which is noise rather than a
        // result — and it would build the index on a stray keystroke. The
        // exception is the emoji shortcut, which opens straight into this list.
        if (query.length < 2 && !scoped) return [];

        const index = buildIndex();
        if (!index) return [];

        const recent = recents(ctx.settings);

        // Opened by the shortcut with nothing typed: show what was used lately.
        if (query === '' && scoped) {
            const byChar = new Map(index.map(e => [e.char, e]));
            return recent
                .map((char, i) => {
                    const entry = byChar.get(char);
                    return entry ? emojiResult(entry, 0, MAX_RECENTS - i, i) : null;
                })
                .filter(Boolean);
        }

        const results = [];

        // Normalized once for the whole sweep rather than once per entry —
        // there are ~2,700 of them and the query is the same for all.
        const q = normalize(query);

        index.forEach((entry, i) => {
            const s = scorePre(q, entry.haystack);
            if (s === NO_MATCH) return;
            // Recently used wins ties, most recent first.
            const recentAt = recent.indexOf(entry.char);
            results.push(emojiResult(entry, s, recentAt < 0 ? 0 : MAX_RECENTS - recentAt, i));
        });

        return results.sort(byScore);
    },

    // Only in the tool-scoped popup. In the full command bar the tools stay
    // silent while browsing rather than each printing a placeholder — but a
    // scoped popup filters every other provider out, so with nothing to say
    // here the user gets an entirely blank popup body.
    emptyMessage(ctx) {
        return ctx.scope === 'emoji'
            ? 'Nothing used yet — type to search emoji and symbols'
            : null;
    },
};
