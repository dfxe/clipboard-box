import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ScreenshotStore, resolveScreenshotsDir } from './screenshotStore.js';
import { ClipboardMonitor } from './clipboardMonitor.js';
import { VaultStore, collapseText, fingerprintFor } from './vaultStore.js';
import * as Capture from './capture.js';

const KEYBINDINGS = ['toggle-menu', 'capture-area', 'capture-full'];

function formatBytes(n) {
    if (!n || n < 1024) return `${n ?? 0} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeAge(iso) {
    const then = GLib.DateTime.new_from_iso8601(iso, null);
    if (!then) return '';
    const secs = Math.max(0, Math.floor(GLib.DateTime.new_now_local().difference(then) / 1e6));
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
}

// Read a PNG off disk without blocking the compositor, then copy it to the
// clipboard. Large screenshots would otherwise stall the Shell if read
// synchronously on the main thread.
function copyPngFile(path) {
    const base = GLib.path_get_basename(path);
    Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
        try {
            const [ok, bytes] = file.load_contents_finish(res);
            if (!ok) {
                Main.notifyError('clipboard-box', `Could not read ${base}`);
                return;
            }
            St.Clipboard.get_default().set_content(
                St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
            Main.notify('clipboard-box', `Copied ${base}`);
        } catch (e) {
            Main.notifyError('clipboard-box', e.message ?? String(e));
        }
    });
}

// Terminal programs can't read image/png off the clipboard without a helper
// binary, but every one of them understands a path — Claude Code turns a pasted
// path matching /\.(png|jpe?g|gif|webp)$/ straight into an image attachment.
// Tell the monitor to ignore the write so our own path copies don't come back in
// as new text history (same trick _recopy uses).
function copyPathText(path, monitor) {
    monitor?.ignore(fingerprintFor('text', new TextEncoder().encode(path)));
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, path);
    Main.notify('clipboard-box', `Copied path to ${GLib.path_get_basename(path)}`);
}

function revealInFiles(path) {
    try {
        const dir = GLib.path_get_dirname(path);
        Gio.AppInfo.launch_default_for_uri(`file://${dir}`, null);
    } catch (e) {
        Main.notifyError('clipboard-box', e.message ?? String(e));
    }
}

// GNOME 46 dropped St.ScrollView.add_actor in favour of a single child slot;
// 45 still only has add_actor. Cover both so the extension works across 45–47.
function setScrollChild(scrollView, child) {
    if (typeof scrollView.set_child === 'function') scrollView.set_child(child);
    else scrollView.add_actor(child);
}

// A single-line title that ellipsizes instead of forcing the popup wider (the
// scroll region is width-capped, so long text would otherwise clip on the right).
function nameLabel(text) {
    const label = new St.Label({ text, style_class: 'cb-name', x_expand: true });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

// A compact icon button for the per-row Pin / Delete actions. St.Button consumes
// the click, so it never also triggers the row's recopy activation.
function iconButton(iconName, styleClass, onClick) {
    const btn = new St.Button({
        style_class: `cb-row-btn ${styleClass}`,
        can_focus: true,
        child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
    });
    btn.connect('clicked', () => { onClick(); return Clutter.EVENT_STOP; });
    return btn;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'clipboard-box');

        this._vault = null;
        this._screenshots = null;
        this._monitor = null;
        this._settings = null;

        this._scrollView = null;
        this._listSection = null;
        this._searchEntry = null;
        this._pauseToggle = null;
        this._clearItem = null;
        this._revealItem = null;
        this._filter = '';
        this._pausedChangedId = 0;

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        // Cap the list height against the current monitor whenever the popup
        // opens, so a long history scrolls instead of overflowing the screen.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._syncScrollHeight();
                // Focus the search box so you can filter by just typing.
                if (this._searchEntry) this._searchEntry.grab_key_focus();
            } else if (this._searchEntry) {
                this._searchEntry.set_text('');
            }
        });
    }

    setContext({ vault, screenshots, monitor, settings }) {
        this._vault = vault;
        this._screenshots = screenshots;
        this._monitor = monitor;
        this._settings = settings;
        this._buildMenu();
    }

    // Build the persistent popup chrome once. Only the middle list is rebuilt on
    // every content change (see refresh) so the search entry keeps its focus and
    // text across rebuilds.
    _buildMenu() {
        this.menu.removeAll();

        this.menu.addMenuItem(this._makeCaptureRow());
        this.menu.addMenuItem(this._makeSearchRow());

        this._pauseToggle = new PopupMenu.PopupSwitchMenuItem('Pause monitoring',
            this._settings ? this._settings.get_boolean('paused') : false);
        this._pauseToggle.connect('toggled', (_i, state) =>
            this._settings?.set_boolean('paused', state));
        if (this._settings) {
            this._pausedChangedId = this._settings.connect('changed::paused', () =>
                this._pauseToggle.setToggleState(this._settings.get_boolean('paused')));
        }
        this.menu.addMenuItem(this._pauseToggle);

        // The two variable-length lists live inside a single scroll view whose
        // height is capped on open (see _syncScrollHeight). Without this the
        // popup grows past the bottom of the screen and clips.
        this._listSection = new PopupMenu.PopupMenuSection();
        const scrollView = new St.ScrollView({
            style_class: 'cb-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            hscrollbar_policy: St.PolicyType.NEVER,
        });
        setScrollChild(scrollView, this._listSection.actor);
        const scrollWrapper = new PopupMenu.PopupMenuSection();
        scrollWrapper.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollWrapper);
        this._scrollView = scrollView;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._clearItem = new PopupMenu.PopupMenuItem('Clear history');
        this._clearItem.connect('activate', () => this._vault?.clear());
        this.menu.addMenuItem(this._clearItem);

        this._revealItem = new PopupMenu.PopupMenuItem('Reveal newest in Files');
        this._revealItem.connect('activate', () => {
            const shots = this._screenshots ? this._screenshots.entries : [];
            if (shots.length > 0) revealInFiles(shots[0]);
        });
        this.menu.addMenuItem(this._revealItem);

        this.refresh();
    }

    // Rebuild only the middle list from the current stores + search filter.
    refresh() {
        if (!this._listSection) return;
        this._listSection.removeAll();

        const q = this._filter;
        const allItems = this._vault ? this._vault.items : [];
        const items = q
            ? allItems.filter(it => `${it.title ?? ''} ${it.text ?? ''}`.toLowerCase().includes(q))
            : allItems;

        this._listSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Clipboard history'));
        if (allItems.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(
                'Nothing copied yet — copy some text or an image', { reactive: false }));
        } else if (items.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(
                'No matches', { reactive: false }));
        } else {
            for (const it of items) this._listSection.addMenuItem(this._makeVaultItem(it));
        }

        const allShots = this._screenshots ? this._screenshots.entries : [];
        const shots = q
            ? allShots.filter(p => GLib.path_get_basename(p).toLowerCase().includes(q))
            : allShots;
        this._listSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Screenshots'));
        if (allShots.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(
                'No screenshots yet — press PrtScn', { reactive: false }));
        } else if (shots.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(
                'No matches', { reactive: false }));
        } else {
            for (const path of shots) this._listSection.addMenuItem(this._makeScreenshotItem(path));
        }

        this._clearItem?.setSensitive(allItems.length > 0);
        this._revealItem?.setSensitive(allShots.length > 0);

        // Content can change while the popup is open (a fresh copy triggers a
        // rebuild); re-apply the cap so the new scroll view is bounded too.
        if (this.menu.isOpen) this._syncScrollHeight();
    }

    _syncScrollHeight() {
        if (!this._scrollView) return;
        let index = Main.layoutManager.findIndexForActor(this);
        if (index < 0) index = Main.layoutManager.primaryIndex;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(index);
        if (!workArea) return;
        // Reserve space for the panel plus the fixed capture/search/pause rows
        // and bottom actions that sit outside the scroll region, then let the
        // list take whatever vertical space is left on this monitor.
        const reserved = Main.panel.height + 260;
        const maxHeight = Math.max(160, workArea.height - reserved);
        this._scrollView.style = `max-height: ${maxHeight}px;`;
    }

    _makeSearchRow() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const entry = new St.Entry({
            style_class: 'cb-search',
            hint_text: 'Search history…',
            can_focus: true,
            x_expand: true,
        });
        entry.clutter_text.connect('text-changed', () => {
            this._filter = entry.get_text().toLowerCase();
            this.refresh();
        });
        this._searchEntry = entry;
        item.add_child(entry);
        return item;
    }

    _makeCaptureRow() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ x_expand: true, style_class: 'cb-btn-row' });

        const area = new St.Button({
            label: 'Area', x_expand: true, can_focus: true,
            style_class: 'cb-capture-btn button',
        });
        area.connect('clicked', () => { this.menu.close(); this._capture('area'); });

        const screen = new St.Button({
            label: 'Screen', x_expand: true, can_focus: true,
            style_class: 'cb-capture-btn button',
        });
        screen.connect('clicked', () => { this.menu.close(); this._capture('full'); });

        box.add_child(area);
        box.add_child(screen);
        item.add_child(box);
        return item;
    }

    _captureDir() {
        return resolveScreenshotsDir(this._settings);
    }

    _capture(mode) {
        const dir = this._captureDir();
        GLib.mkdir_with_parents(dir, 0o755);
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
        const destPath = GLib.build_filenamev([dir, `Screenshot from ${stamp}.png`]);

        const onDone = (pathUsed, err) => {
            if (err || !pathUsed) {
                if (err && err.message?.includes('cancel')) return; // user aborted SelectArea
                Main.notifyError('clipboard-box', err?.message ?? 'Screenshot failed');
                return;
            }
            this._ingestCaptured(pathUsed);
        };

        if (mode === 'area') Capture.captureArea(destPath, onDone);
        else Capture.captureFull(destPath, onDone);
    }

    _ingestCaptured(path) {
        const base = GLib.path_get_basename(path);
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            let ok, bytes;
            try { [ok, bytes] = file.load_contents_finish(res); }
            catch (_) { return; }
            if (!ok) return;
            const item = this._vault?.add({
                kind: 'image', bytes, contentType: 'image/png', title: base,
            });
            if (item) this._monitor?.ignore(item.fingerprint);
            St.Clipboard.get_default().set_content(
                St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
            Main.notify('clipboard-box', `Captured ${base}`);
        });
    }

    _makeVaultItem(it) {
        const item = new PopupMenu.PopupBaseMenuItem({ activate: true });
        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        let thumb;
        if (it.kind === 'image' && it.imagePath) {
            thumb = new St.Icon({
                gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(it.imagePath) }),
                icon_size: 64, style_class: 'cb-thumb',
            });
        } else {
            thumb = new St.Icon({
                icon_name: it.kind === 'text' ? 'text-x-generic-symbolic' : 'image-x-generic-symbolic',
                icon_size: 32, style_class: 'cb-thumb',
            });
        }

        const labelBox = new St.BoxLayout({
            vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'cb-meta',
        });
        const name = it.kind === 'text' ? (collapseText(it.title || it.text) || 'Text') : (it.title || 'Image');
        labelBox.add_child(nameLabel(name));
        labelBox.add_child(new St.Label({
            text: `${it.kind === 'text' ? 'Text' : 'Image'} · ${formatBytes(it.byteCount)} · ${relativeAge(it.createdAt)}`,
            style_class: 'cb-hint',
        }));

        // Light-touch preview: the full (single-line) text is reachable via the
        // accessible name even though the visible label is ellipsized.
        if (it.kind === 'text' && it.text) item.accessible_name = it.text;

        const actions = new St.BoxLayout({ style_class: 'cb-row-actions' });
        actions.add_child(iconButton(
            it.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            it.pinned ? 'cb-pinned' : '',
            () => this._vault?.togglePin(it.id)));
        if (it.kind === 'image' && it.imagePath) {
            actions.add_child(iconButton('insert-link-symbolic', '',
                () => copyPathText(it.imagePath, this._monitor)));
        }
        actions.add_child(iconButton('user-trash-symbolic', '',
            () => this._vault?.remove(it.id)));

        row.add_child(thumb);
        row.add_child(labelBox);
        row.add_child(actions);
        item.add_child(row);

        item.connect('activate', () => this._recopy(it));
        return item;
    }

    _recopy(it) {
        this._monitor?.ignore(it.fingerprint);
        const clipboard = St.Clipboard.get_default();
        if (it.kind === 'text') {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, it.text ?? '');
            Main.notify('clipboard-box', 'Copied text to clipboard');
        } else if (it.imagePath) {
            Gio.File.new_for_path(it.imagePath).load_contents_async(null, (file, res) => {
                let ok, bytes;
                try { [ok, bytes] = file.load_contents_finish(res); }
                catch (_) { ok = false; }
                if (!ok) {
                    Main.notifyError('clipboard-box', 'Image is no longer available');
                    return;
                }
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
                Main.notify('clipboard-box', 'Copied image to clipboard');
            });
        }
    }

    _makeScreenshotItem(path) {
        const item = new PopupMenu.PopupBaseMenuItem({ activate: true });
        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        const thumb = new St.Icon({
            gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(path) }),
            icon_size: 64, style_class: 'cb-thumb',
        });

        const labelBox = new St.BoxLayout({
            vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'cb-meta',
        });
        labelBox.add_child(nameLabel(GLib.path_get_basename(path)));
        labelBox.add_child(new St.Label({ text: 'Click to copy', style_class: 'cb-hint' }));

        const actions = new St.BoxLayout({ style_class: 'cb-row-actions' });
        actions.add_child(iconButton('insert-link-symbolic', '',
            () => copyPathText(path, this._monitor)));

        row.add_child(thumb);
        row.add_child(labelBox);
        row.add_child(actions);
        item.add_child(row);

        item.connect('activate', () => copyPngFile(path));
        return item;
    }

    destroy() {
        if (this._settings && this._pausedChangedId) {
            this._settings.disconnect(this._pausedChangedId);
            this._pausedChangedId = 0;
        }
        super.destroy();
    }
});

export default class ClipboardBoxExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._vault = new VaultStore(this._settings);
        this._vault.load();
        this._screenshots = new ScreenshotStore(this._settings);
        this._monitor = new ClipboardMonitor(this._settings);

        this._indicator = new Indicator();
        this._indicator.setContext({
            vault: this._vault,
            screenshots: this._screenshots,
            monitor: this._monitor,
            settings: this._settings,
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._vaultId = this._vault.connect('changed', () => this._indicator?.refresh());
        this._shotsId = this._screenshots.connect('changed', () => this._indicator?.refresh());
        this._monitorId = this._monitor.connect('captured', (_m, payload) => {
            this._vault.add(payload);
        });

        // React to settings that affect stored data live.
        this._settingsIds = [
            this._settings.connect('changed::max-items', () => this._vault.applyLimits()),
            this._settings.connect('changed::entry-ttl-days', () => this._vault.applyLimits()),
            this._settings.connect('changed::screenshots-dir', () => this._screenshots.restart()),
        ];

        this._addKeybindings();
        this._warnIfNoClipboardHelper();

        this._screenshots.start();
        this._monitor.start();
        this._indicator.refresh();
    }

    // Terminal apps (Claude Code, editors) shell out to xclip on X11 or wl-paste
    // on Wayland to read the clipboard. Without one, clicking an image row looks
    // like it worked but Ctrl+V in a terminal pastes nothing — so say it once.
    // Deferred a few seconds because at login we'd otherwise notify before the
    // session's notification handling is up.
    _warnIfNoClipboardHelper() {
        if (this._settings.get_boolean('clipboard-helper-warned')) return;
        const wayland = Meta.is_wayland_compositor();
        if (GLib.find_program_in_path(wayland ? 'wl-paste' : 'xclip')) return;
        this._warnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._warnId = 0;
            Main.notify('clipboard-box',
                `Install ${wayland ? 'wl-clipboard' : 'xclip'} so terminal apps can ` +
                'paste clipboard images with Ctrl+V.');
            this._settings?.set_boolean('clipboard-helper-warned', true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _addKeybindings() {
        const flags = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        const handlers = {
            'toggle-menu': () => this._indicator?.menu.toggle(),
            'capture-area': () => { this._indicator?.menu.close(); this._indicator?._capture('area'); },
            'capture-full': () => { this._indicator?.menu.close(); this._indicator?._capture('full'); },
        };
        for (const name of KEYBINDINGS) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.NONE, flags, handlers[name]);
        }
    }

    _removeKeybindings() {
        for (const name of KEYBINDINGS) Main.wm.removeKeybinding(name);
    }

    disable() {
        this._removeKeybindings();

        if (this._warnId) {
            GLib.source_remove(this._warnId);
            this._warnId = 0;
        }

        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds) this._settings.disconnect(id);
            this._settingsIds = null;
        }

        if (this._monitor) {
            if (this._monitorId) this._monitor.disconnect(this._monitorId);
            this._monitor.stop();
            this._monitor = null;
            this._monitorId = 0;
        }
        if (this._screenshots) {
            if (this._shotsId) this._screenshots.disconnect(this._shotsId);
            this._screenshots.stop();
            this._screenshots = null;
            this._shotsId = 0;
        }
        if (this._vault) {
            if (this._vaultId) this._vault.disconnect(this._vaultId);
            this._vault = null;
            this._vaultId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
