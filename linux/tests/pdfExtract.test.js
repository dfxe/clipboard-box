import {
    parsePageRange, parsePageCount, parseEncrypted, explainPopplerError,
    outputPaths, uniquePath, separateArgv, uniteArgv, partPaths, partPattern,
    MAX_SPAN,
} from '../omelette@dfxe.github.io/pdfExtract.js';
import { suite, it, eq, ok } from './harness.js';

suite('pdfExtract');

// --- parsePageRange ---

it('reads a single page', () => {
    eq(parsePageRange('7', 42), { first: 7, last: 7 });
});

it('reads a range', () => {
    eq(parsePageRange('3-7', 42), { first: 3, last: 7 });
});

it('tolerates whitespace around and inside the range', () => {
    eq(parsePageRange('  3 - 7  ', 42), { first: 3, last: 7 });
});

it('accepts an en dash, which is what pasting from a document gives you', () => {
    eq(parsePageRange('3–7', 42), { first: 3, last: 7 });
});

it('accepts an em dash and a minus sign too', () => {
    eq(parsePageRange('3—7', 42), { first: 3, last: 7 });
    eq(parsePageRange('3−7', 42), { first: 3, last: 7 });
});

it('treats a whole-document range as valid', () => {
    eq(parsePageRange('1-42', 42), { first: 1, last: 42 });
});

it('rejects an empty box', () => {
    ok(parsePageRange('', 42).error);
    ok(parsePageRange('   ', 42).error);
});

it('rejects text that is not a page number', () => {
    ok(parsePageRange('abc', 42).error);
    ok(parsePageRange('3-', 42).error);
    ok(parsePageRange('-7', 42).error);
    ok(parsePageRange('3-7-9', 42).error);
    ok(parsePageRange('3.5', 42).error);
});

it('rejects page zero, since PDFs are 1-indexed', () => {
    eq(parsePageRange('0', 42).error, 'Pages start at 1.');
    eq(parsePageRange('0-3', 42).error, 'Pages start at 1.');
});

it('rejects a reversed range', () => {
    eq(parsePageRange('7-3', 42).error, 'The first page comes after the last one.');
});

it('rejects a range past the end of the document', () => {
    eq(parsePageRange('40-99', 42).error, 'This PDF has 42 pages.');
    eq(parsePageRange('99', 42).error, 'This PDF has 42 pages.');
});

it('says "one page" rather than "1 pages"', () => {
    eq(parsePageRange('2', 1).error, 'This PDF has only one page.');
});

it('skips the bounds check when the page count is not known yet', () => {
    eq(parsePageRange('99', 0), { first: 99, last: 99 });
});

// Measured, not guessed: pdfunite opens every part at once, and under a 1024
// soft fd limit it dies on the 1022nd with "Too many open files" and writes a
// damaged file. The cap has to stay comfortably below that.
it('refuses a span that would exhaust pdfunite file descriptors', () => {
    ok(parsePageRange(`1-${MAX_SPAN + 1}`, 0).error);
    eq(parsePageRange(`1-${MAX_SPAN}`, 0), { first: 1, last: MAX_SPAN });
    ok(MAX_SPAN < 1000, 'must stay clear of a 1024 descriptor limit');
});

// --- parsePageCount ---

it('pulls the page count out of pdfinfo output', () => {
    const stdout = [
        'Title:          Some report',
        'Producer:       LibreOffice',
        'Pages:          42',
        'Encrypted:      no',
    ].join('\n');
    eq(parsePageCount(stdout), 42);
});

it('is not fooled by another line ending in Pages', () => {
    eq(parsePageCount('Subject:        Pages: 9\nPages:          3\n'), 3);
});

it('returns null when there is no page count, as for an encrypted file', () => {
    eq(parsePageCount('Command Line Error: Incorrect password'), null);
    eq(parsePageCount(''), null);
    eq(parsePageCount(null), null);
});

// --- parseEncrypted ---

it('spots an encrypted PDF, which pdfseparate refuses to split', () => {
    ok(parseEncrypted('Pages:          12\nEncrypted:      yes (print:yes copy:no)\n'));
});

it('does not flag an ordinary PDF as encrypted', () => {
    ok(!parseEncrypted('Pages:          12\nEncrypted:      no\n'));
    ok(!parseEncrypted(''));
    ok(!parseEncrypted(null));
});

// --- explainPopplerError ---

it('turns poppler diagnostics into sentences', () => {
    eq(explainPopplerError('Command Line Error: Incorrect password'),
        'That PDF is password-protected.');
    eq(explainPopplerError('Syntax Error: May not be a PDF file (continuing anyway)'),
        "That doesn't look like a PDF.");
    eq(explainPopplerError("I/O Error: Couldn't open file '/tmp/x.pdf': No such file or directory."),
        'That file is no longer there.');
    eq(explainPopplerError("I/O Error: Couldn't open file 'part-1022.pdf': Too many open files."),
        'That range is too many pages at once.');
});

it('keeps poppler\'s own first line when it has nothing better to say', () => {
    eq(explainPopplerError('Internal Error: Illegal pageNo: 90(12)'),
        'Internal Error: Illegal pageNo: 90(12)');
});

it('names the stage when the tool failed silently', () => {
    eq(explainPopplerError('', 'pdfseparate'), 'pdfseparate failed.');
    eq(explainPopplerError('   \n  \n'), 'That did not work.');
});

// --- outputPaths ---

it('puts a range in a folder beside the source', () => {
    eq(outputPaths('/home/me/Documents/report.pdf', 3, 7), {
        folder: '/home/me/Documents/report-extracted',
        file: '/home/me/Documents/report-extracted/report-p3-7.pdf',
    });
});

it('drops the second number for a single page', () => {
    eq(outputPaths('/home/me/Documents/report.pdf', 7, 7).file,
        '/home/me/Documents/report-extracted/report-p7.pdf');
});

it('strips the extension case-insensitively', () => {
    eq(outputPaths('/tmp/REPORT.PDF', 1, 2).file,
        '/tmp/REPORT-extracted/REPORT-p1-2.pdf');
});

it('handles a name with no extension', () => {
    eq(outputPaths('/tmp/scan', 1, 2).file,
        '/tmp/scan-extracted/scan-p1-2.pdf');
});

it('keeps spaces and non-ASCII in the name intact', () => {
    eq(outputPaths('/tmp/Rapport final été.pdf', 2, 4).file,
        '/tmp/Rapport final été-extracted/Rapport final été-p2-4.pdf');
});

it('only strips .pdf from the end, not from the middle', () => {
    eq(outputPaths('/tmp/a.pdf.backup.pdf', 1, 1).file,
        '/tmp/a.pdf.backup-extracted/a.pdf.backup-p1.pdf');
});

// --- uniquePath ---

it('leaves a free path alone', () => {
    eq(uniquePath('/tmp/out/report-p3-7.pdf', () => false),
        '/tmp/out/report-p3-7.pdf');
});

it('numbers around a collision rather than overwriting', () => {
    const taken = new Set(['/tmp/out/report-p3-7.pdf']);
    eq(uniquePath('/tmp/out/report-p3-7.pdf', p => taken.has(p)),
        '/tmp/out/report-p3-7 (2).pdf');
});

it('keeps counting past several collisions', () => {
    const taken = new Set([
        '/tmp/out/report-p3-7.pdf',
        '/tmp/out/report-p3-7 (2).pdf',
        '/tmp/out/report-p3-7 (3).pdf',
    ]);
    eq(uniquePath('/tmp/out/report-p3-7.pdf', p => taken.has(p)),
        '/tmp/out/report-p3-7 (4).pdf');
});

it('gives up rather than spinning when everything is taken', () => {
    eq(uniquePath('/tmp/out/x.pdf', () => true), null);
});

// --- argv builders ---
//
// These are arrays, never shell strings, which is the whole reason a path with
// a space or a quote in it needs no escaping anywhere in this feature.

it('builds the pdfseparate argv', () => {
    eq(separateArgv('/tmp/my report.pdf', 3, 7, '/tmp/parts/part-%d.pdf'),
        ['pdfseparate', '-f', '3', '-l', '7', '/tmp/my report.pdf', '/tmp/parts/part-%d.pdf']);
});

it('builds the pdfunite argv with the parts in page order', () => {
    eq(uniteArgv(['/t/part-3.pdf', '/t/part-4.pdf'], '/out/r.pdf'),
        ['pdfunite', '/t/part-3.pdf', '/t/part-4.pdf', '/out/r.pdf']);
});

it('names the parts the way pdfseparate will write them', () => {
    eq(partPattern('/tmp/parts'), '/tmp/parts/part-%d.pdf');
    eq(partPaths('/tmp/parts', 3, 5),
        ['/tmp/parts/part-3.pdf', '/tmp/parts/part-4.pdf', '/tmp/parts/part-5.pdf']);
});

it('lists one part for a single page', () => {
    eq(partPaths('/tmp/parts', 7, 7), ['/tmp/parts/part-7.pdf']);
});
