import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MB = 1024 * 1024;

// A shortcut is stored as a GSettings `as` array. We keep the prefs UI simple
// and robust: the user types an accelerator string (e.g. <Super><Shift>V) which
// we validate with Gtk.accelerator_parse before storing; blank clears it.
function shortcutRow(settings, key, title) {
    const row = new Adw.EntryRow({ title });
    const current = settings.get_strv(key);
    row.set_text(current.length ? current[0] : '');

    row.connect('changed', () => {
        const text = row.get_text().trim();
        if (text === '') {
            settings.set_strv(key, []);
            row.remove_css_class('error');
            return;
        }
        const [ok, keyval] = Gtk.accelerator_parse(text);
        if (ok && keyval !== 0) {
            settings.set_strv(key, [text]);
            row.remove_css_class('error');
        } else {
            // Leave the stored value alone until it parses.
            row.add_css_class('error');
        }
    });
    return row;
}

export default class ClipboardBoxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- History ---------------------------------------------------------
        const history = new Adw.PreferencesGroup({ title: 'History' });
        page.add(history);

        const maxItems = new Adw.SpinRow({
            title: 'Maximum entries',
            subtitle: 'Oldest unpinned entries drop beyond this.',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 1000, step_increment: 10, page_increment: 50 }),
        });
        settings.bind('max-items', maxItems, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(maxItems);

        const ttl = new Adw.SpinRow({
            title: 'Auto-expire after (days)',
            subtitle: '0 disables expiry. Pinned entries never expire.',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 3650, step_increment: 1, page_increment: 7 }),
        });
        settings.bind('entry-ttl-days', ttl, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(ttl);

        // --- Images ----------------------------------------------------------
        const images = new Adw.PreferencesGroup({ title: 'Images' });
        page.add(images);

        const storeImages = new Adw.SwitchRow({
            title: 'Store copied images',
            subtitle: 'Explicit Area/Screen captures are always stored.',
        });
        settings.bind('store-images', storeImages, 'active', Gio.SettingsBindFlags.DEFAULT);
        images.add(storeImages);

        // Stored as bytes; presented in whole megabytes.
        const maxImg = new Adw.SpinRow({
            title: 'Max copied-image size (MB)',
            subtitle: '0 means unlimited. Does not affect captures.',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 500, step_increment: 1, page_increment: 10 }),
        });
        maxImg.set_value(Math.round(settings.get_int('max-image-bytes') / MB));
        maxImg.connect('notify::value', () =>
            settings.set_int('max-image-bytes', Math.round(maxImg.get_value()) * MB));
        settings.connect('changed::max-image-bytes', () =>
            maxImg.set_value(Math.round(settings.get_int('max-image-bytes') / MB)));
        images.add(maxImg);

        const dir = new Adw.EntryRow({ title: 'Screenshots folder' });
        dir.set_text(settings.get_string('screenshots-dir'));
        dir.connect('changed', () => settings.set_string('screenshots-dir', dir.get_text().trim()));
        images.add(dir);
        const dirHint = new Adw.ActionRow({
            subtitle: 'Blank uses the default ~/Pictures/Screenshots.',
        });
        images.add(dirHint);

        // --- Privacy ---------------------------------------------------------
        const privacy = new Adw.PreferencesGroup({ title: 'Privacy' });
        page.add(privacy);

        const paused = new Adw.SwitchRow({
            title: 'Pause monitoring',
            subtitle: 'While on, newly copied content is not recorded.',
        });
        settings.bind('paused', paused, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacy.add(paused);

        const encrypt = new Adw.SwitchRow({
            title: 'Encrypt history at rest',
            subtitle: 'Not yet implemented.',
            sensitive: false,
        });
        settings.bind('encrypt-at-rest', encrypt, 'active', Gio.SettingsBindFlags.DEFAULT);
        privacy.add(encrypt);

        // --- Shortcuts -------------------------------------------------------
        const shortcuts = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description: 'Type an accelerator such as <Super><Shift>V. Leave blank to disable.',
        });
        page.add(shortcuts);
        shortcuts.add(shortcutRow(settings, 'toggle-menu', 'Open clipboard menu'));
        shortcuts.add(shortcutRow(settings, 'capture-area', 'Capture area'));
        shortcuts.add(shortcutRow(settings, 'capture-full', 'Capture screen'));
    }
}
