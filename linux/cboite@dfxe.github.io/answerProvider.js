// The Answer section: at most one row, shown only when the query actually
// resolves to something. calc.js is deliberately strict about returning null,
// which is what keeps this section from appearing under ordinary searches.

import { evaluate } from './calc.js';
import { ingestText } from './clipboardUtil.js';

export const answerProvider = {
    id: 'answer',
    title: 'Answer',
    cap: 1,

    search(query, ctx) {
        if (query === '') return [];

        const answer = evaluate(query, { rates: ctx.rates ?? null });
        if (!answer) return [];

        return [{
            id: 'answer',
            score: 0,
            title: answer.title,
            subtitle: answer.subtitle,
            visual: { kind: 'icon', name: 'accessories-calculator-symbolic', size: 32 },
            accel: 'Enter',
            titleClass: 'cb-answer',
            run: ctx2 => {
                // Worth keeping: a number you just worked out is something you
                // often want again a minute later.
                ingestText(answer.copyText, ctx2, { store: true, title: answer.copyText });
                return { message: 'Copied answer', close: true };
            },
        }];
    },
};
