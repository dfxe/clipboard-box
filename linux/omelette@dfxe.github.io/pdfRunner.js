// Driving poppler-utils. The only place in this extension that spawns a
// subprocess, so it sets the pattern: argv arrays rather than shell strings,
// every call asynchronous, and stderr surfaced verbatim instead of paraphrased.
//
// Asynchronous is not a preference here. This code runs inside gnome-shell's
// main loop, so a synchronous pdfseparate over a 400-page document would freeze
// the whole desktop for as long as it took — the same reason capture.js builds
// its D-Bus proxy async.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    infoArgv, separateArgv, uniteArgv, partPattern, partPaths,
    parsePageCount, parseEncrypted, explainPopplerError, outputPaths, uniquePath,
} from './pdfExtract.js';

// All three ship in poppler-utils, so this is one dependency however it reads.
const TOOLS = ['pdfinfo', 'pdfseparate', 'pdfunite'];

// Walking PATH three times is cheap, but this is asked on every keystroke that
// reaches the provider, so answer it once per session. Cleared by reset(), so
// installing poppler and restarting the shell is enough to pick it up.
let _missing = null;

export function missingTools() {
    _missing ??= TOOLS.filter(tool => !GLib.find_program_in_path(tool));
    return _missing;
}

// Called from both enable() and disable(): module state outlives the Indicator,
// and a stale answer here would survive an extension reload.
export function reset() {
    _missing = null;
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

// cb(stdout, error). A non-zero exit is an error even when the tool printed
// nothing, because a silent failure is the one thing worse than a loud one.
function run(argv, cb) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        cb(null, e);
        return;
    }

    proc.communicate_utf8_async(null, null, (p, res) => {
        try {
            const [, stdout, stderr] = p.communicate_utf8_finish(res);
            if (!p.get_successful()) {
                cb(null, new Error(explainPopplerError(stderr, argv[0])));
                return;
            }
            cb(stdout ?? '', null);
        } catch (e) {
            cb(null, e);
        }
    });
}

// cb({ pageCount, encrypted } | null, error). Doubles as the "is this really a
// readable PDF" check: an encrypted or truncated file fails here, before the
// user has typed a range, which is the earliest we can say so.
export function readInfo(path, cb) {
    run(infoArgv(path), (stdout, err) => {
        if (err) {
            cb(null, err);
            return;
        }
        const pageCount = parsePageCount(stdout);
        if (pageCount === null) {
            cb(null, new Error('Could not read how many pages this PDF has.'));
            return;
        }
        cb({ pageCount, encrypted: parseEncrypted(stdout) }, null);
    });
}

// Best-effort: the extraction has already succeeded or failed by the time this
// runs, and a leftover file in the cache directory is not worth reporting.
function cleanUp(dir, parts) {
    for (const part of parts) GLib.unlink(part);
    GLib.rmdir(dir);
}

// cb(destPath, error).
//
// Parts land in a temporary directory rather than beside the source, so a
// pdfunite that dies halfway never leaves debris in the user's document folder
// — the output folder is only created once there is something to put in it.
export function extractRange({ source, first, last }, cb) {
    let workDir;
    try {
        workDir = GLib.dir_make_tmp('omelette-pdf-XXXXXX');
    } catch (e) {
        cb(null, e);
        return;
    }

    const parts = partPaths(workDir, first, last);
    const done = (dest, err) => {
        cleanUp(workDir, parts);
        cb(dest, err);
    };

    run(separateArgv(source, first, last, partPattern(workDir)), (_out, err) => {
        if (err) {
            done(null, err);
            return;
        }

        // pdfseparate can exit 0 having written nothing at all — a page range
        // it silently declined, say. Check rather than hand pdfunite a list of
        // paths that aren't there.
        if (!parts.every(exists)) {
            done(null, new Error('No pages came out of that range.'));
            return;
        }

        const { folder, file } = outputPaths(source, first, last);
        if (GLib.mkdir_with_parents(folder, 0o755) !== 0) {
            done(null, new Error(`Could not create ${folder}.`));
            return;
        }

        const dest = uniquePath(file, exists);
        if (!dest) {
            done(null, new Error('Too many files with that name already.'));
            return;
        }

        // One page needs no merge — moving the single part is both quicker and
        // one less chance for poppler to rewrite something it didn't have to.
        if (parts.length === 1) {
            try {
                // Four arguments, not five: gjs folds g_file_move's
                // progress_callback_data into the callback itself.
                //
                // NONE rather than NO_FALLBACK_FOR_MOVE on purpose — the parts
                // are in the cache directory, which is often a different
                // filesystem from the user's documents, and the copy-and-delete
                // fallback is what makes the rename work across that boundary.
                Gio.File.new_for_path(parts[0]).move(
                    Gio.File.new_for_path(dest), Gio.FileCopyFlags.NONE, null, null);
            } catch (e) {
                done(null, e);
                return;
            }
            done(dest, null);
            return;
        }

        run(uniteArgv(parts, dest), (_o, uniteErr) => done(uniteErr ? null : dest, uniteErr));
    });
}
