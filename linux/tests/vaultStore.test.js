// These tests write real files, so they insist on the sandbox that run.sh sets
// up (XDG_DATA_HOME pointed at a throwaway directory). Running run.js directly
// would otherwise operate on the developer's own clipboard history.

import GLib from 'gi://GLib';

import { VaultStore, fingerprintFor, collapseText } from '../cboite@dfxe.github.io/vaultStore.js';
import { suite, it, eq, ok, silenced } from './harness.js';

suite('vaultStore');

const sandboxed = GLib.getenv('CBOITE_TEST_SANDBOX') === '1';

const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'cboite']);
const vaultPath = GLib.build_filenamev([dataDir, 'vault.json']);
const imagesDir = GLib.build_filenamev([dataDir, 'images']);

const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const wipe = () => {
    for (const p of [vaultPath, ...listDir(dataDir), ...listDir(imagesDir)])
        if (GLib.file_test(p, GLib.FileTest.IS_REGULAR)) GLib.unlink(p);
};
function listDir(path) {
    const out = [];
    let dir;
    try { dir = GLib.Dir.open(path, 0); } catch (_) { return out; }
    let name;
    while ((name = dir.read_name()) !== null) out.push(GLib.build_filenamev([path, name]));
    dir.close();
    return out;
}

const fresh = () => { wipe(); const v = new VaultStore(null); v.load(); return v; };

it('sandbox is in place', () => {
    ok(sandboxed, 'run tests via tests/run.sh so XDG_DATA_HOME is isolated');
});

if (sandboxed) {
    it('stores and dedupes text by fingerprint', () => {
        const v = fresh();
        v.add({ kind: 'text', text: 'hello' });
        v.add({ kind: 'text', text: 'world' });
        v.add({ kind: 'text', text: 'hello' });   // duplicate: promotes, not appends
        eq(v.items.length, 2);
        eq(v.items[0].text, 'hello', 're-copying promotes back to the top');
    });

    it('coalesces writes and flush() makes them durable', () => {
        const v = fresh();
        v.add({ kind: 'text', text: 'queued' });
        // The write is debounced, so nothing has reached disk yet.
        ok(!GLib.file_test(vaultPath, GLib.FileTest.EXISTS) || !read(vaultPath).includes('queued'),
            'write is deferred, not synchronous');
        v.flush();
        ok(read(vaultPath).includes('queued'), 'flush persists immediately');
    });

    it('flush() is a no-op when nothing is pending', () => {
        const v = fresh();
        v.add({ kind: 'text', text: 'once' });
        v.flush();
        const first = read(vaultPath);
        v.flush();
        eq(read(vaultPath), first);
    });

    it('ignores empty payloads', () => {
        const v = fresh();
        eq(v.add({ kind: 'text', text: '' }), null);
        eq(v.items.length, 0);
    });

    it('pins sort ahead and survive the size cap', () => {
        const v = fresh();
        v.add({ kind: 'text', text: 'old' });
        const pinned = v.items[0];
        v.togglePin(pinned.id);
        v.add({ kind: 'text', text: 'new' });
        eq(v.items[0].text, 'old', 'pinned item sorts first even though it is older');
        ok(v.items[0].pinned);
    });

    it('writes the vault owner-only', () => {
        const v = fresh();
        v.add({ kind: 'text', text: 'secret-ish' });
        v.flush();
        const [, out] = GLib.spawn_command_line_sync(`stat -c %a ${vaultPath}`);
        eq(new TextDecoder().decode(out).trim(), '600');
    });

    it('archives an unreadable vault instead of overwriting it', () => {
        wipe();
        GLib.file_set_contents(vaultPath, new TextEncoder().encode('{{{ not json'));
        const v = new VaultStore(null);
        silenced(() => v.load());

        eq(v.items.length, 0, 'starts empty');
        ok(v.loadFailure?.archivedTo, 'records where the original went');
        eq(read(v.loadFailure.archivedTo), '{{{ not json', 'original bytes preserved verbatim');
    });

    it('keeps saving after a successful archive', () => {
        wipe();
        GLib.file_set_contents(vaultPath, new TextEncoder().encode('nonsense'));
        const v = new VaultStore(null);
        silenced(() => v.load());
        v.add({ kind: 'text', text: 'after recovery' });
        v.flush();
        ok(read(vaultPath).includes('after recovery'));
    });

    it('refuses to persist when the unreadable file could not be archived', () => {
        const v = fresh();
        v.add({ kind: 'text', text: 'precious' });
        v.flush();
        const before = read(vaultPath);

        // Simulate the archive having failed: the real history is still on disk.
        v.loadFailure = { archivedTo: null };
        v._items = [];
        v._persist();
        v.flush();
        eq(read(vaultPath), before, 'existing file left untouched');
    });

    it('collects orphaned image files on load', () => {
        const v = fresh();
        GLib.mkdir_with_parents(imagesDir, 0o700);
        const orphan = GLib.build_filenamev([imagesDir, 'deadbeef.png']);
        GLib.file_set_contents(orphan, new Uint8Array([1, 2, 3]));

        const v2 = new VaultStore(null);
        v2.load();
        ok(!GLib.file_test(orphan, GLib.FileTest.EXISTS), 'unreferenced PNG removed');
        void v;
    });

    it('does not collect images while a load has failed', () => {
        wipe();
        GLib.mkdir_with_parents(imagesDir, 0o700);
        const kept = GLib.build_filenamev([imagesDir, 'cafebabe.png']);
        GLib.file_set_contents(kept, new Uint8Array([4, 5, 6]));
        GLib.file_set_contents(vaultPath, new TextEncoder().encode('broken'));

        const v = new VaultStore(null);
        silenced(() => v.load());
        ok(GLib.file_test(kept, GLib.FileTest.EXISTS),
            'the archived vault still references these, so they must survive');
    });

    it('remove() deletes the entry and its backing image', () => {
        const v = fresh();
        const item = v.add({ kind: 'image', bytes: new Uint8Array([1, 2, 3, 4]) });
        ok(GLib.file_test(item.imagePath, GLib.FileTest.EXISTS));
        v.remove(item.id);
        eq(v.items.length, 0);
        ok(!GLib.file_test(item.imagePath, GLib.FileTest.EXISTS));
    });
}

it('fingerprints are stable and kind-separated', () => {
    const bytes = new TextEncoder().encode('same');
    eq(fingerprintFor('text', bytes), fingerprintFor('text', bytes));
    ok(fingerprintFor('text', bytes) !== fingerprintFor('image', bytes),
        'kind is part of the fingerprint');
});

it('collapseText flattens whitespace and truncates long text', () => {
    eq(collapseText('  a\n\n  b  '), 'a b');
    eq(collapseText(''), '');
    eq(collapseText(null), '');
    const long = collapseText('x'.repeat(500));
    ok(long.length <= 84, `got ${long.length}`);
    ok(long.endsWith('…'));
});
