// Ranking for the command bar. Every provider scores its candidates with the
// same function so results from different sources can be compared against each
// other inside one list.
//
// The tiers are deliberately far apart (200 points) and the penalties inside a
// tier are small, so a weaker match never overtakes a stronger kind of match —
// a prefix hit always beats a substring hit no matter how long the strings are.
// Within a tier, shorter text wins, which is what makes typing `g` surface the
// `g` quicklink rather than a history entry that merely contains a g.

const EXACT = 1000;
const PREFIX = 800;
const WORD = 600;
const SUBSTRING = 400;
const SUBSEQUENCE = 200;

export const NO_MATCH = -1;

// Cap the penalties well below the 200-point tier gap.
const MAX_LENGTH_PENALTY = 100;
const MAX_GAP_PENALTY = 100;

// Longer haystacks are worse matches for the same query. Asymptotic so a very
// long text can never fall a whole tier.
function lengthPenalty(queryLen, textLen) {
    const extra = Math.max(0, textLen - queryLen);
    return Math.round(MAX_LENGTH_PENALTY * (extra / (extra + 24)));
}

// True when `index` starts a word — beginning of string, or preceded by a
// separator. Lets "col" hit "background-color" and "shell" hit "gnome shell".
function isWordStart(text, index) {
    if (index === 0) return true;
    return /[\s\-_/.,:;([{'"]/.test(text[index - 1]);
}

function wordStartIndex(text, query) {
    let from = 0;
    for (;;) {
        const idx = text.indexOf(query, from);
        if (idx < 0) return -1;
        if (isWordStart(text, idx)) return idx;
        from = idx + 1;
    }
}

// Ordered-but-not-contiguous match: "bgcol" matches "background-color". Counts
// the characters skipped between hits so a tightly packed match ranks higher.
function subsequenceGaps(text, query) {
    let ti = 0;
    let gaps = 0;
    let started = false;
    for (const ch of query) {
        const idx = text.indexOf(ch, ti);
        if (idx < 0) return -1;
        if (started) gaps += idx - ti;
        started = true;
        ti = idx + 1;
    }
    return gaps;
}

export function normalize(s) {
    return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Score `text` against `query`. Higher is better; NO_MATCH means no match at
// all. An empty query matches everything at a flat score, so callers can use
// one code path for the browse case and the search case.
export function score(query, text) {
    return scorePre(normalize(query), normalize(text));
}

// The same scorer, for callers that hold already-normalized strings.
//
// This exists because normalizing inside score() is the single most expensive
// thing the command bar does per keystroke: providers with a fixed corpus
// (emoji: ~2,700 entries) were re-lowercasing and re-regexing every candidate,
// and re-normalizing the identical query once per candidate on top. Normalize
// the query once per search, keep haystacks normalized at build time, and call
// this instead.
//
// Both arguments MUST already be normalize()d — passing raw text here silently
// scores it wrong rather than failing.
export function scorePre(q, t) {
    if (q === '') return 0;
    if (t === '') return NO_MATCH;

    if (t === q) return EXACT;
    if (t.startsWith(q)) return PREFIX - lengthPenalty(q.length, t.length);

    const wordIdx = wordStartIndex(t, q);
    if (wordIdx > 0) return WORD - lengthPenalty(q.length, t.length);

    if (t.includes(q)) return SUBSTRING - lengthPenalty(q.length, t.length);

    // Only worth attempting for short queries; a long one degenerates into
    // matching almost anything, which is noise rather than a result.
    if (q.length <= 12) {
        const gaps = subsequenceGaps(t, q);
        if (gaps >= 0) {
            const penalty = Math.round(MAX_GAP_PENALTY * (gaps / (gaps + 12)));
            return SUBSEQUENCE - penalty;
        }
    }

    return NO_MATCH;
}

// Best score across several fields — a snippet matches on its keyword, its
// label, or its body, and should be ranked by whichever fits best.
export function scoreAny(query, texts) {
    const q = normalize(query);
    let best = NO_MATCH;
    for (const t of texts) {
        const s = scorePre(q, normalize(t));
        if (s > best) best = s;
    }
    return best;
}

// scoreAny for pre-normalized inputs. Same contract as scorePre.
export function scoreAnyPre(q, texts) {
    let best = NO_MATCH;
    for (const t of texts) {
        const s = scorePre(q, t);
        if (s > best) best = s;
    }
    return best;
}

// Stable ordering helper: score descending, then a caller-supplied tiebreak
// (usage count, recency), then the original index so equal items don't shuffle
// between keystrokes.
export function byScore(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.tiebreak ?? 0;
    const bt = b.tiebreak ?? 0;
    if (bt !== at) return bt - at;
    return (a.index ?? 0) - (b.index ?? 0);
}
