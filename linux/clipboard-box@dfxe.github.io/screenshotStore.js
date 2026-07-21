import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_ENTRIES = 10;
const DEBOUNCE_MS = 200;

function screenshotsDir() {
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES)
        ?? GLib.get_home_dir();
    return GLib.build_filenamev([pictures, 'Screenshots']);
}

export const ScreenshotStore = GObject.registerClass({
    Signals: { 'changed': {} },
}, class ScreenshotStore extends GObject.Object {
    _init() {
        super._init();
        this._entries = [];
        this._monitor = null;
        this._refreshSourceId = 0;
        this._dir = null;
    }

    get entries() {
        return this._entries.slice();
    }

    start() {
        const dirPath = screenshotsDir();
        this._dir = Gio.File.new_for_path(dirPath);

        if (!this._dir.query_exists(null)) {
            try { this._dir.make_directory_with_parents(null); }
            catch (_) { /* best effort */ }
        }

        this._reload();

        try {
            this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._scheduleReload());
        } catch (_) {
            // monitor unavailable — entries only refresh on extension restart
        }
    }

    stop() {
        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        this._dir = null;
        this._entries = [];
    }

    _scheduleReload() {
        if (this._refreshSourceId) {
            GLib.source_remove(this._refreshSourceId);
        }
        this._refreshSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._refreshSourceId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        if (!this._dir) return;

        let enumerator;
        try {
            enumerator = this._dir.enumerate_children(
                'standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
        } catch (_) {
            this._entries = [];
            this.emit('changed');
            return;
        }

        const items = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.toLowerCase().endsWith('.png')) continue;
            items.push({
                path: GLib.build_filenamev([this._dir.get_path(), name]),
                mtime: Number(info.get_attribute_uint64('time::modified')),
            });
        }
        enumerator.close(null);

        items.sort((a, b) => b.mtime - a.mtime);
        this._entries = items.slice(0, MAX_ENTRIES).map(i => i.path);
        this.emit('changed');
    }
});
