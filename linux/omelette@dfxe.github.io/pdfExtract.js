// The PDF tool's pure half: parsing what the user typed, deciding where the
// output goes, and building the argv arrays poppler gets called with.
//
// Everything here is a plain function over strings and numbers, which is what
// lets it be unit-tested — it imports GLib for path building and nothing from
// resource:///, so it loads in plain gjs with no Shell. The subprocess work
// lives in pdfRunner.js and the widgets in pdfPanel.js.

import GLib from 'gi://GLib';

// pdfunite opens every part at once rather than streaming them, so the ceiling
// is the process's file-descriptor limit, not argv length. Measured: with the
// common 1024 soft RLIMIT_NOFILE it dies on the 1022nd part with "Too many open
// files" and leaves a damaged output. 500 sits clear of that on any machine,
// and is far more pages than "a page or a range" ever means in practice.
export const MAX_SPAN = 500;

// The folder that appears next to the source PDF, and the marker in the file
// name. Deliberately not configurable: a setting for either is a knob nobody
// turns, and predictable names are what make the output findable later.
const FOLDER_SUFFIX = '-extracted';

// Both dashes people actually type. A range copied out of a document is as
// likely to hold an en dash as a hyphen, and rejecting it would look like the
// tool simply didn't work.
// (U+2010 hyphen through U+2015 horizontal bar, plus U+2212 minus.)
const DASHES = /[‐-―−]/g;

// Returns { first, last } or { error }. `error` is shown to the user verbatim,
// so each one names the actual problem rather than restating the format.
// pageCount of 0 means "not known yet" and skips the bounds check.
export function parsePageRange(text, pageCount = 0) {
    const cleaned = String(text ?? '').replace(DASHES, '-').trim();
    if (cleaned === '') return { error: 'Type a page, like 7, or a range, like 3-7.' };

    const range = cleaned.match(/^(\d+)\s*-\s*(\d+)$/);
    const single = cleaned.match(/^(\d+)$/);
    if (!range && !single)
        return { error: 'Type a page, like 7, or a range, like 3-7.' };

    const first = Number(range ? range[1] : single[1]);
    const last = Number(range ? range[2] : single[1]);

    if (first < 1) return { error: 'Pages start at 1.' };
    if (first > last) return { error: 'The first page comes after the last one.' };

    if (pageCount > 0 && last > pageCount) {
        return {
            error: pageCount === 1
                ? 'This PDF has only one page.'
                : `This PDF has ${pageCount} pages.`,
        };
    }

    if (last - first + 1 > MAX_SPAN)
        return { error: `That's more than ${MAX_SPAN} pages at once.` };

    return { first, last };
}

// pdfinfo prints a `Pages:` line among a dozen others. Null when it isn't there,
// which is what an encrypted or unparseable file looks like from here.
export function parsePageCount(stdout) {
    const match = String(stdout ?? '').match(/^Pages:\s+(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
}

// pdfseparate's manual is explicit that the source "should not be encrypted",
// and a surprising share of real documents are — bank statements, anything
// exported with printing restricted. Many open fine in a viewer because the
// user password is empty, so the user has no reason to expect a refusal. Worth
// saying when the file is chosen rather than after a range has been typed.
export function parseEncrypted(stdout) {
    return /^Encrypted:\s+yes/im.test(String(stdout ?? ''));
}

// poppler's diagnostics are aimed at someone running it in a terminal. Map the
// handful that users will actually hit onto a sentence, and fall back to its
// own first line rather than inventing a vaguer one.
export function explainPopplerError(stderr, stage = '') {
    const line = String(stderr ?? '').split('\n').find(l => l.trim() !== '')?.trim() ?? '';

    // Most specific first. poppler wraps most of these in the same "Couldn't
    // open file" prefix, so a generic test placed above them would swallow the
    // ones that have something useful to say.
    if (/Incorrect password|Command Line Error: Incorrect/i.test(line))
        return 'That PDF is password-protected.';
    if (/May not be a PDF file|Couldn't read xref|not a PDF/i.test(line))
        return "That doesn't look like a PDF.";
    if (/Too many open files/i.test(line))
        return 'That range is too many pages at once.';
    if (/Permission denied/i.test(line))
        return "You don't have permission to read that file.";
    if (/No such file|Couldn't open file/i.test(line))
        return 'That file is no longer there.';

    if (line !== '') return line;
    return stage ? `${stage} failed.` : 'That did not work.';
}

// The stem is what the output is named after: `report.pdf` -> `report`. Matched
// case-insensitively because a file off a Windows share is as likely to be
// `REPORT.PDF`, and a name with no extension at all keeps its whole self.
function stemOf(basename) {
    return basename.replace(/\.pdf$/i, '');
}

// -> { folder, file }. The folder is created next to the source; the file lands
// inside it. A single page drops the second number, so page 7 of report.pdf is
// report-extracted/report-p7.pdf rather than report-p7-7.pdf.
export function outputPaths(source, first, last) {
    const dir = GLib.path_get_dirname(source);
    const stem = stemOf(GLib.path_get_basename(source));
    const folder = GLib.build_filenamev([dir, `${stem}${FOLDER_SUFFIX}`]);
    const name = first === last
        ? `${stem}-p${first}.pdf`
        : `${stem}-p${first}-${last}.pdf`;
    return { folder, file: GLib.build_filenamev([folder, name]) };
}

// Never overwrite: extracting the same range twice is far more likely to be a
// second attempt worth keeping than a request to destroy the first one.
// `exists` is injected so the tests can run without touching disk.
export function uniquePath(path, exists) {
    if (!exists(path)) return path;

    const dir = GLib.path_get_dirname(path);
    const base = GLib.path_get_basename(path);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';

    // Bounded so a pathological directory can't spin the compositor. Anyone who
    // has 999 copies of one range has a different problem.
    for (let n = 2; n < 1000; n++) {
        const candidate = GLib.build_filenamev([dir, `${stem} (${n})${ext}`]);
        if (!exists(candidate)) return candidate;
    }
    return null;
}

// argv arrays, never a shell string: this is what makes a path with spaces,
// quotes or non-ASCII safe by construction rather than by escaping.
export function separateArgv(source, first, last, pattern) {
    return ['pdfseparate', '-f', String(first), '-l', String(last), source, pattern];
}

export function uniteArgv(parts, dest) {
    return ['pdfunite', ...parts, dest];
}

export function infoArgv(source) {
    return ['pdfinfo', source];
}

// pdfseparate substitutes the page number for %d, so the names it will write
// are predictable — which is how we hand pdfunite the parts in page order
// instead of trusting a directory listing to come back sorted.
export function partPattern(dir) {
    return GLib.build_filenamev([dir, 'part-%d.pdf']);
}

export function partPaths(dir, first, last) {
    const paths = [];
    for (let page = first; page <= last; page++)
        paths.push(GLib.build_filenamev([dir, `part-${page}.pdf`]));
    return paths;
}
