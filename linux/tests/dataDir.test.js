// The clipboard-box → cBoite migration. Worth real tests rather than a manual
// check: it moves the only copy of someone's history, and the failure modes are
// silent — a no-op leaves them looking at an empty vault, and an over-eager move
// would overwrite a directory that was already there.
//
// resolveDir() takes its base as a parameter precisely so these can run against
// a temp directory; dataDir() caches the real one for the life of the process.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { resolveDir } from '../cboite@dfxe.github.io/dataDir.js';
import { suite, it, eq, ok, silenced } from './harness.js';

suite('dataDir');

function tempBase() {
    const base = GLib.Dir.make_tmp('cboite-datadir-XXXXXX');
    return base;
}

function mkdirp(path) {
    GLib.mkdir_with_parents(path, 0o700);
}

function write(path, text) {
    GLib.file_set_contents(path, new TextEncoder().encode(text));
}

function read(path) {
    return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
}

const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const rmrf = p => { try { Gio.File.new_for_path(p).trash(null); } catch (_) { /* temp dir */ } };

it('moves a legacy directory into place, contents intact', () => {
    const base = tempBase();
    const legacy = GLib.build_filenamev([base, 'clipboard-box']);
    mkdirp(GLib.build_filenamev([legacy, 'images']));
    write(GLib.build_filenamev([legacy, 'vault.json']), '{"items":[1]}');
    write(GLib.build_filenamev([legacy, 'images', 'a.png']), 'png');

    const dir = silenced(() => resolveDir(base));

    eq(dir, GLib.build_filenamev([base, 'cboite']));
    ok(!exists(legacy), 'legacy directory should be gone after the move');
    eq(read(GLib.build_filenamev([dir, 'vault.json'])), '{"items":[1]}');
    ok(exists(GLib.build_filenamev([dir, 'images', 'a.png'])), 'images should come across');
    rmrf(base);
});

it('does nothing when there is no legacy directory', () => {
    const base = tempBase();

    const dir = resolveDir(base);

    eq(dir, GLib.build_filenamev([base, 'cboite']));
    // Creating the directory is the caller's job, so a fresh install resolves a
    // path that does not exist yet.
    ok(!exists(dir), 'resolveDir should not create anything on a fresh install');
    rmrf(base);
});

it('never clobbers an existing directory', () => {
    const base = tempBase();
    const legacy = GLib.build_filenamev([base, 'clipboard-box']);
    const current = GLib.build_filenamev([base, 'cboite']);
    mkdirp(legacy);
    mkdirp(current);
    write(GLib.build_filenamev([legacy, 'vault.json']), 'old');
    write(GLib.build_filenamev([current, 'vault.json']), 'current');

    const dir = resolveDir(base);

    eq(dir, current);
    eq(read(GLib.build_filenamev([current, 'vault.json'])), 'current');
    ok(exists(legacy), 'the legacy directory should be left where it is');
    rmrf(base);
});

it('is idempotent', () => {
    const base = tempBase();
    mkdirp(GLib.build_filenamev([base, 'clipboard-box']));
    write(GLib.build_filenamev([base, 'clipboard-box', 'vault.json']), 'x');

    const first = silenced(() => resolveDir(base));
    const second = silenced(() => resolveDir(base));

    eq(first, second);
    eq(read(GLib.build_filenamev([first, 'vault.json'])), 'x');
    rmrf(base);
});
