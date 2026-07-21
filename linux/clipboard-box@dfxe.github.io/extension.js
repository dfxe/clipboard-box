import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ScreenshotStore } from './screenshotStore.js';

function copyToClipboard(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) {
            Main.notifyError('clipboard-box', `Could not read ${GLib.path_get_basename(path)}`);
            return;
        }
        St.Clipboard.get_default().set_content(
            St.ClipboardType.CLIPBOARD,
            'image/png',
            new GLib.Bytes(bytes),
        );
        Main.notify('clipboard-box', `Copied ${GLib.path_get_basename(path)}`);
    } catch (e) {
        Main.notifyError('clipboard-box', e.message ?? String(e));
    }
}

function revealInFiles(path) {
    try {
        const dir = GLib.path_get_dirname(path);
        Gio.AppInfo.launch_default_for_uri(`file://${dir}`, null);
    } catch (e) {
        Main.notifyError('clipboard-box', e.message ?? String(e));
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'clipboard-box');

        this.add_child(new St.Icon({
            icon_name: 'camera-photo-symbolic',
            style_class: 'system-status-icon',
        }));
    }

    setEntries(paths) {
        this.menu.removeAll();

        if (paths.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                'No screenshots yet — press PrtScn',
                { reactive: false },
            );
            this.menu.addMenuItem(empty);
        } else {
            for (const path of paths) {
                this.menu.addMenuItem(this._makeItem(path));
            }
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const reveal = new PopupMenu.PopupMenuItem('Reveal newest in Files');
        reveal.connect('activate', () => {
            if (paths.length > 0) revealInFiles(paths[0]);
        });
        reveal.setSensitive(paths.length > 0);
        this.menu.addMenuItem(reveal);
    }

    _makeItem(path) {
        const item = new PopupMenu.PopupBaseMenuItem({ activate: true });

        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        const thumb = new St.Icon({
            gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(path) }),
            icon_size: 64,
            style_class: 'cb-thumb',
        });

        const labelBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cb-meta',
        });
        labelBox.add_child(new St.Label({
            text: GLib.path_get_basename(path),
            style_class: 'cb-name',
        }));
        labelBox.add_child(new St.Label({
            text: 'Click to copy',
            style_class: 'cb-hint',
        }));

        row.add_child(thumb);
        row.add_child(labelBox);
        item.add_child(row);

        item.connect('activate', () => copyToClipboard(path));
        return item;
    }
});

export default class ClipboardBoxExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._store = new ScreenshotStore();
        this._storeId = this._store.connect('changed', (store) => {
            this._indicator?.setEntries(store.entries);
        });
        this._store.start();
        this._indicator.setEntries(this._store.entries);
    }

    disable() {
        if (this._store) {
            if (this._storeId) {
                this._store.disconnect(this._storeId);
                this._storeId = 0;
            }
            this._store.stop();
            this._store = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
