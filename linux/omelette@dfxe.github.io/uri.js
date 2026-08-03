// Handing a URI to whatever the desktop has registered for it. Shared because
// two providers open links — quicklinks and the About row — and neither should
// have to carry the notify-on-failure boilerplate itself.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (e) {
        Main.notifyError('Omelette', e.message ?? String(e));
    }
}
