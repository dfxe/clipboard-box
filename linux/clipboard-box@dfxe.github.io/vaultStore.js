import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

// Keep parity with the macOS VaultStore: bounded ring buffer of copied items,
// deduplicated by a content fingerprint, persisted as plaintext JSON. Image
// payloads live as PNG files alongside the JSON (macOS inlines base64; in GJS a
// file reference is lighter and lets St.Icon thumbnail straight off disk).
//
// Limits (history size, entry lifetime) come from GSettings so they can be tuned
// in prefs; a null settings object falls back to these defaults.
const DEFAULT_MAX_ITEMS = 200;
const TITLE_MAX = 84;

// SHA-256 over "<kind>\0<bytes>", matching macOS makeFingerprint(kind:data:).
// `bytes` must be a Uint8Array.
export function fingerprintFor(kind, bytes) {
    const prefix = new TextEncoder().encode(`${kind}\0`);
    const buf = new Uint8Array(prefix.length + bytes.length);
    buf.set(prefix, 0);
    buf.set(bytes, prefix.length);
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, buf);
}

function nowIso() {
    return GLib.DateTime.new_now_local().format_iso8601();
}

export function collapseText(text) {
    const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
    if (oneLine.length <= TITLE_MAX) return oneLine;
    return `${oneLine.slice(0, TITLE_MAX - 1)}…`;
}

export const VaultStore = GObject.registerClass({
    Signals: { 'changed': {} },
}, class VaultStore extends GObject.Object {
    _init(settings) {
        super._init();
        // We call super._init() with no props, so `settings` is our own param and
        // is never interpreted as a GObject property dictionary.
        this._settings = settings ?? null;
        this._items = [];
        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipboard-box']);
        this._imagesDir = GLib.build_filenamev([this._dataDir, 'images']);
        this._vaultPath = GLib.build_filenamev([this._dataDir, 'vault.json']);
    }

    // Pinned items sort ahead of the rest (each group keeps its newest-first
    // order). The UI iterates this directly.
    get items() {
        const pinned = this._items.filter(it => it.pinned);
        const rest = this._items.filter(it => !it.pinned);
        return [...pinned, ...rest];
    }

    get _maxItems() {
        const n = this._settings ? this._settings.get_int('max-items') : DEFAULT_MAX_ITEMS;
        return n > 0 ? n : DEFAULT_MAX_ITEMS;
    }

    _ensureDirs() {
        GLib.mkdir_with_parents(this._imagesDir, 0o700);
    }

    load() {
        this._ensureDirs();
        if (!GLib.file_test(this._vaultPath, GLib.FileTest.EXISTS)) {
            this._items = [];
            this.emit('changed');
            return;
        }
        try {
            const [ok, contents] = GLib.file_get_contents(this._vaultPath);
            if (!ok) {
                this._items = [];
            } else {
                const parsed = JSON.parse(new TextDecoder().decode(contents));
                // Drop image items whose backing file has vanished.
                this._items = (Array.isArray(parsed) ? parsed : []).filter(it =>
                    it && (it.kind !== 'image' ||
                        (it.imagePath && GLib.file_test(it.imagePath, GLib.FileTest.EXISTS))));
            }
        } catch (e) {
            logError(e, 'clipboard-box: failed to load vault.json');
            this._items = [];
        }
        // Apply time- and size-based limits that may have changed while we were
        // not running, then write the cleaned list back.
        this._expire();
        this._trim();
        this._persist();
        this.emit('changed');
    }

    // payload: { kind: 'text'|'image', text?, bytes?(Uint8Array), contentType?, title?, fingerprint? }
    add(payload) {
        const dataBytes = payload.kind === 'text'
            ? new TextEncoder().encode(payload.text ?? '')
            : payload.bytes;
        if (!dataBytes || dataBytes.length === 0) return null;

        const fp = payload.fingerprint ?? fingerprintFor(payload.kind, dataBytes);
        const existingIdx = this._items.findIndex(it => it.fingerprint === fp);

        if (existingIdx >= 0) {
            // Already present — promote to the top instead of duplicating. Keep
            // its pinned flag so re-copying a pin doesn't unpin it.
            const [existing] = this._items.splice(existingIdx, 1);
            existing.createdAt = nowIso();
            this._items.unshift(existing);
            this._persist();
            this.emit('changed');
            return existing;
        }

        let imagePath;
        if (payload.kind === 'image') {
            this._ensureDirs();
            imagePath = GLib.build_filenamev([this._imagesDir, `${fp}.png`]);
            if (!GLib.file_test(imagePath, GLib.FileTest.EXISTS)) {
                try {
                    GLib.file_set_contents(imagePath, dataBytes);
                    GLib.chmod(imagePath, 0o600);
                } catch (e) {
                    logError(e, 'clipboard-box: failed to write image payload');
                    return null;
                }
            }
        }

        const item = {
            id: GLib.uuid_string_random(),
            kind: payload.kind,
            title: payload.title ?? (payload.kind === 'text' ? collapseText(payload.text) : 'Image'),
            createdAt: nowIso(),
            contentType: payload.contentType ?? (payload.kind === 'text' ? 'text/plain' : 'image/png'),
            byteCount: dataBytes.length,
            fingerprint: fp,
            pinned: false,
        };
        if (payload.kind === 'text') item.text = payload.text ?? '';
        else item.imagePath = imagePath;

        this._items.unshift(item);
        this._expire();
        this._trim();
        this._persist();
        this.emit('changed');
        return item;
    }

    togglePin(id) {
        const it = this._items.find(x => x.id === id);
        if (!it) return;
        it.pinned = !it.pinned;
        this._persist();
        this.emit('changed');
    }

    remove(id) {
        const idx = this._items.findIndex(it => it.id === id);
        if (idx < 0) return;
        const [removed] = this._items.splice(idx, 1);
        this._forgetImage(removed);
        this._persist();
        this.emit('changed');
    }

    clear() {
        // Detach the list first, then delete backing files unconditionally —
        // there's nothing left to reference them.
        const doomed = this._items;
        this._items = [];
        for (const it of doomed) {
            if (it.kind === 'image' && it.imagePath &&
                GLib.file_test(it.imagePath, GLib.FileTest.EXISTS))
                GLib.unlink(it.imagePath);
        }
        this._persist();
        this.emit('changed');
    }

    // Re-apply expiry + size limits after a settings change (max-items lowered,
    // entry-ttl-days set). Only emits/persists when something actually changed.
    applyLimits() {
        const expired = this._expire();
        const trimmed = this._trim();
        if (expired || trimmed) {
            this._persist();
            this.emit('changed');
        }
    }

    // Drop unpinned items older than entry-ttl-days. Returns true if any went.
    _expire() {
        const days = this._settings ? this._settings.get_int('entry-ttl-days') : 0;
        if (!days || days <= 0) return false;
        const cutoff = GLib.DateTime.new_now_local().add_days(-days);
        let changed = false;
        for (let i = this._items.length - 1; i >= 0; i--) {
            const it = this._items[i];
            if (it.pinned) continue;
            const created = GLib.DateTime.new_from_iso8601(it.createdAt, null);
            if (created && cutoff.compare(created) > 0) {
                const [dropped] = this._items.splice(i, 1);
                this._forgetImage(dropped);
                changed = true;
            }
        }
        return changed;
    }

    // Enforce the max-items cap, dropping the oldest *unpinned* entries first so
    // pins survive even a shrunk history. Returns true if any went.
    _trim() {
        const max = this._maxItems;
        let changed = false;
        for (let i = this._items.length - 1; i >= 0 && this._items.length > max; i--) {
            if (!this._items[i].pinned) {
                const [dropped] = this._items.splice(i, 1);
                this._forgetImage(dropped);
                changed = true;
            }
        }
        return changed;
    }

    // Delete an item's backing PNG when no surviving item references it.
    _forgetImage(item) {
        if (!item || item.kind !== 'image' || !item.imagePath) return;
        const stillUsed = this._items.some(it => it.imagePath === item.imagePath);
        if (!stillUsed && GLib.file_test(item.imagePath, GLib.FileTest.EXISTS))
            GLib.unlink(item.imagePath);
    }

    _persist() {
        try {
            this._ensureDirs();
            const json = JSON.stringify(this._items, null, 2);
            GLib.file_set_contents(this._vaultPath, new TextEncoder().encode(json));
            // History can contain anything the user copied — keep it owner-only.
            GLib.chmod(this._vaultPath, 0o600);
        } catch (e) {
            logError(e, 'clipboard-box: failed to persist vault.json');
        }
    }
});
