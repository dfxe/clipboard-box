// The file chooser, through xdg-desktop-portal.
//
// gnome-shell cannot put up a Gtk dialog of its own — it *is* the compositor —
// so the only way to a real file chooser from here is to ask the portal for
// one. The caller must close the popup first: while the popup holds its modal
// grab, the chooser window appears but never receives a click.
//
// Unlike capture.js this uses a plain connection.call() rather than a proxy.
// makeProxyWrapper's synchronous constructor is what capture.js has to work
// around; a single method call needs no proxy at all, so there is nothing to
// work around here.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILE_CHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';

// Filter entries are (type, pattern) where 0 is a glob and 1 is a mime type.
const FILTER_MIME = 1;

let sequence = 0;

// The request in flight, if any. Module state because it has to outlive the
// popup — the whole point is that the popup closes while the chooser is up —
// and because disable() must be able to drop it: a Response landing after
// teardown would otherwise call into a destroyed Indicator.
let active = null;

// The portal derives the request's object path from our bus name and the token
// we hand it, which is what lets us subscribe *before* calling — otherwise a
// chooser the user dismisses instantly could answer before we were listening.
function requestPathFor(connection, token) {
    const unique = connection.get_unique_name() ?? '';
    const sender = unique.replace(/^:/, '').replace(/\./g, '_');
    return `${PORTAL_PATH}/request/${sender}/${token}`;
}

// cb(path, error). Both null means the user cancelled — the caller stays quiet
// about that, the way _capture() does for an abandoned SelectArea.
export function pickPdf(cb) {
    // Only one chooser at a time; a second Browse click abandons the first.
    cancelActive();

    const connection = Gio.DBus.session;
    const token = `omelette${sequence++}_${GLib.random_int_range(0, 1 << 30)}`;

    const subscriptions = [];
    let settled = false;

    const release = () => {
        settled = true;
        for (const id of subscriptions) connection.signal_unsubscribe(id);
        subscriptions.length = 0;
        if (active?.release === release) active = null;
    };

    const finish = (path, error) => {
        if (settled) return;
        release();
        cb(path, error);
    };

    active = { release };

    const onResponse = (_conn, _sender, _path, _iface, _signal, params) => {
        let response, results;
        try {
            [response, results] = params.deepUnpack();
        } catch (e) {
            finish(null, e);
            return;
        }

        // 1 is "cancelled", 2 is "ended some other way". Neither is an error.
        if (response !== 0) {
            finish(null, null);
            return;
        }

        const uris = results?.uris?.deepUnpack?.() ?? [];
        if (uris.length === 0) {
            finish(null, null);
            return;
        }

        // A file on a remote share has a URI but no local path, and poppler
        // takes paths. Say so rather than failing later with a confusing
        // "no such file".
        const path = Gio.File.new_for_uri(uris[0]).get_path();
        if (!path) {
            finish(null, new Error('That file is not on this machine.'));
            return;
        }
        finish(path, null);
    };

    const listenOn = objectPath => {
        subscriptions.push(connection.signal_subscribe(
            PORTAL_NAME, REQUEST, 'Response', objectPath, null,
            Gio.DBusSignalFlags.NONE, onResponse));
    };

    const expectedPath = requestPathFor(connection, token);
    listenOn(expectedPath);

    // The a{sv} has to be a plain object built inline, not a GLib.Variant that
    // was packed separately: packing a tuple walks each element, and handing it
    // an already-packed Variant makes it iterate that object's own methods and
    // fail on the first function it finds.
    const options = {
        handle_token: GLib.Variant.new_string(token),
        modal: GLib.Variant.new_boolean(true),
        multiple: GLib.Variant.new_boolean(false),
        accept_label: GLib.Variant.new_string('Choose'),
        filters: new GLib.Variant('a(sa(us))', [
            ['PDF documents', [[FILTER_MIME, 'application/pdf']]],
        ]),
    };

    connection.call(
        PORTAL_NAME, PORTAL_PATH, FILE_CHOOSER, 'OpenFile',
        // No parent window: the popup is closed by the time we get here, and
        // the Shell has no toplevel to parent a dialog to anyway.
        new GLib.Variant('(ssa{sv})', ['', 'Choose a PDF', options]),
        new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null,
        (conn, res) => {
            let handle;
            try {
                [handle] = conn.call_finish(res).deepUnpack();
            } catch (e) {
                finish(null, e);
                return;
            }
            // Older portals ignore handle_token and mint their own path. Listen
            // there too rather than waiting forever for a signal that will
            // arrive somewhere else.
            if (handle && handle !== expectedPath && !settled) listenOn(handle);
        });
}

// Drops any in-flight request without calling its callback. The chooser window
// itself stays up — the portal owns it and it is the user's to dismiss — but
// whatever they pick goes nowhere, which is the right outcome once the
// extension that asked has been torn down.
export function cancelActive() {
    active?.release();
    active = null;
}
