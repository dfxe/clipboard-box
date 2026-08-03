// One row that opens the PDF tool. The work itself happens in the panel, so
// there is nothing to rank and nothing to copy — this exists so the tool is
// reachable by typing rather than only by a shortcut nobody has bound yet.
//
// Prefix-scored against its own keywords, like aboutProvider: the loose
// subsequence tier that makes `bgcol` find `background-color` would have this
// section turn up in searches that have nothing to do with PDFs.

import { scoreAnyPre, normalize } from './match.js';

// Long enough that a stray keypress can't summon the section, short enough that
// `pdf` — the obvious thing to type — still works on the first try.
const MIN_QUERY = 3;

// No `pages`: too ordinary a word to hand a whole section to, and anyone who
// types it is more likely searching something they copied.
const KEYWORDS = ['pdf', 'pdfs', 'extract', 'split'];

export const pdfProvider = {
    id: 'pdf',
    title: 'PDF',
    cap: 1,

    search(query, ctx) {
        if (query.length < MIN_QUERY) return [];

        const q = normalize(query);
        const hits = KEYWORDS.filter(k => k.startsWith(q));
        if (hits.length === 0) return [];

        // Nothing here can work without poppler. Say so in emptyMessage instead
        // of offering a row that opens a panel with one sentence in it.
        if (ctx.pdfMissing?.().length > 0) return [];

        return [{
            id: 'pdf:open',
            score: scoreAnyPre(q, hits),
            index: 0,
            title: 'Extract pages from a PDF',
            subtitle: 'Pick a PDF, then a page or a range',
            visual: { kind: 'icon', name: 'x-office-document-symbolic', size: 32 },
            accel: 'Enter',
            run: c => {
                c.openTool?.('pdf');
                // No flash and no close: the popup stays up and becomes the
                // tool, so the row it replaces has nothing to confirm.
                return null;
            },
        }];
    },

    // Only speaks when the popup was opened by the tool's own shortcut, like
    // every other tool — silent in the ordinary bar.
    emptyMessage(ctx) {
        if (ctx.scope !== 'pdf') return null;
        const missing = ctx.pdfMissing?.() ?? [];
        if (missing.length === 0) return null;
        return `This needs poppler-utils (missing ${missing.join(', ')}).`;
    },
};
