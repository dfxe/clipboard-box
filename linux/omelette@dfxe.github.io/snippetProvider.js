// Snippets: saved blocks of text, searchable by keyword or label, with a few
// placeholders expanded at the moment you use them.
//
// Expansion is asynchronous because {clipboard} has to go and read the
// clipboard, so the whole path is callback-shaped even though most snippets
// resolve instantly.

import St from 'gi://St';
import GLib from 'gi://GLib';

import { loadSnippets, bumpSnippet } from './configStore.js';
import { collapseText } from './vaultStore.js';
import { ingestText } from './clipboardUtil.js';
import { scoreAny, byScore, NO_MATCH } from './match.js';

// {cursor} is implemented as arrow-key presses after the paste, so a marker
// buried under a huge tail is not worth honouring.
const MAX_CURSOR_TAIL = 200;

// Sentinel standing in for {cursor} between expansion and the final split.
// NUL cannot occur in text the user typed, so it can never collide with the
// snippet body itself.
const CURSOR_MARK = '\u0000';

const PLACEHOLDER_RE = /\{(date|time|datetime|clipboard|uuid|cursor)(?::([^}]*))?\}/g;

export function describePlaceholders() {
    return '{date} {time} {clipboard} {uuid} {cursor} — {date:%d %b %Y} for a custom format';
}

// Expand everything except {clipboard}, which the caller supplies because it
// has to be fetched asynchronously.
function expandSync(body, clipboardText) {
    return body.replace(PLACEHOLDER_RE, (_match, name, arg) => {
        const now = GLib.DateTime.new_now_local();
        switch (name) {
        case 'date': return now.format(arg || '%Y-%m-%d');
        case 'time': return now.format(arg || '%H:%M');
        case 'datetime': return now.format(arg || '%Y-%m-%d %H:%M');
        case 'uuid': return GLib.uuid_string_random();
        case 'clipboard': return clipboardText ?? '';
        case 'cursor': return CURSOR_MARK; // placeholder marker, stripped below
        default: return '';
        }
    });
}

// Split the marker back out, returning how far the caret should walk back.
function splitCursor(text) {
    const at = text.indexOf(CURSOR_MARK);
    if (at < 0) return { text, cursorBack: 0 };
    const stripped = text.replaceAll(CURSOR_MARK, '');
    // Count in code points — a trailing emoji is one character but several
    // UTF-16 units, and arrow keys move by character.
    const tail = [...stripped.slice(at)].length;
    return { text: stripped, cursorBack: tail <= MAX_CURSOR_TAIL ? tail : 0 };
}

export function expand(body, onDone) {
    if (!body.includes('{clipboard}')) {
        onDone(splitCursor(expandSync(body, '')));
        return;
    }
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
        onDone(splitCursor(expandSync(body, text ?? '')));
    });
}

function snippetResult(snippet, matchScore, index) {
    const preview = collapseText(snippet.body) || '(empty)';
    const title = snippet.label || preview;
    const bits = [];
    if (snippet.keyword) bits.push(snippet.keyword);
    if (snippet.label) bits.push(preview);
    if (PLACEHOLDER_RE.test(snippet.body)) bits.push('has placeholders');
    PLACEHOLDER_RE.lastIndex = 0; // the regex is global; don't leak its cursor

    return {
        id: `snippet:${snippet.id}`,
        score: matchScore,
        tiebreak: snippet.uses,
        index,
        title,
        subtitle: bits.join(' · '),
        visual: { kind: 'icon', name: 'insert-text-symbolic', size: 32 },
        accel: 'Paste',
        accessibleText: snippet.body,
        run: ctx => {
            expand(snippet.body, ({ text, cursorBack }) => {
                // Snippets are not stored in history: a long signature would
                // crowd out the copies you actually wanted to find again.
                ingestText(text, {
                    ...ctx,
                    requestPaste: () => ctx.requestPaste?.({ leftPresses: cursorBack }),
                }, { store: false });
            });
            bumpSnippet(ctx.settings, snippet.id);
            return { message: 'Pasted snippet', close: true };
        },
    };
}

export const snippetProvider = {
    id: 'snippet',
    title: 'Snippets',
    cap: 6,

    search(query, ctx) {
        // ctx.snippets is the Indicator's cache, refreshed on changed::snippets.
        // Falling back to a direct read keeps the provider usable on its own.
        const snippets = ctx.snippets ?? loadSnippets(ctx.settings);

        // Opened by the snippet shortcut with nothing typed: list them all,
        // most-used first, so the shortcut is useful on its own.
        if (query === '') {
            if (ctx.scope !== 'snippet') return [];
            return snippets
                .map((s, i) => snippetResult(s, 0, i))
                .sort(byScore);
        }

        const results = [];
        snippets.forEach((snippet, i) => {
            const s = scoreAny(query, [
                snippet.keyword ?? '',
                snippet.label ?? '',
                collapseText(snippet.body),
            ]);
            if (s !== NO_MATCH) results.push(snippetResult(snippet, s, i));
        });
        return results.sort(byScore);
    },

    // Scoped popup only — see the note on emojiProvider.emptyMessage.
    emptyMessage(ctx) {
        return ctx.scope === 'snippet'
            ? 'No snippets yet. Write one in Preferences, or save any row here as one.'
            : null;
    },
};
