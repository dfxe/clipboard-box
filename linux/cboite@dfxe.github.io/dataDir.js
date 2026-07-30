// Where cBoite keeps its files, and the only place the clipboard-box → cBoite
// rename is still visible at runtime.
//
// The rename moved the data directory, and rather than ask anyone to move it by
// hand, the first call that needs the directory renames the old one into place.
// A rename rather than a copy, so vault.json, images/ and rates.json arrive
// together or not at all — a half-copied vault is the one outcome worth ruling
// out.
//
// The check is guarded so it runs once per process, and only does anything when
// the new directory is absent *and* the old one is present. A fresh install and
// an already-migrated one both cost a single file_test.
//
// This can be deleted once nobody is running a build from before the rename.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DIR_NAME = 'cboite';
const LEGACY_DIR_NAME = 'clipboard-box';

// Split out from dataDir() so it can be tested against a temporary base rather
// than the real XDG data dir, which GLib caches for the life of the process.
export function resolveDir(base) {
    const dir = GLib.build_filenamev([base, DIR_NAME]);

    // Already migrated, or a fresh install that has written something. Bailing
    // here is also what stops a stale legacy directory from clobbering a real
    // one if both somehow exist.
    if (GLib.file_test(dir, GLib.FileTest.EXISTS)) return dir;

    const legacy = GLib.build_filenamev([base, LEGACY_DIR_NAME]);
    if (!GLib.file_test(legacy, GLib.FileTest.IS_DIR)) return dir;

    try {
        Gio.File.new_for_path(legacy).move(
            Gio.File.new_for_path(dir), Gio.FileCopyFlags.NONE, null, null);
        log(`cboite: migrated ${legacy} to ${dir}`);
    } catch (e) {
        // Deliberately not fatal. The caller goes on to create the new directory
        // and start empty, which loses nothing — the old history is still
        // sitting safely under its old name, and the log says where.
        logError(e, `cboite: could not migrate ${legacy}, leaving it alone`);
    }

    return dir;
}

let cached = null;

export function dataDir() {
    if (cached === null) cached = resolveDir(GLib.get_user_data_dir());
    return cached;
}
