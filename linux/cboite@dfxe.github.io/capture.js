import Gio from 'gi://Gio';

// Screenshot capture through the Shell's own D-Bus service. This is the version
// -stable interface exported by gnome-shell on 45/46/47. We write straight into
// the user's Screenshots folder (so the existing ScreenshotStore watcher picks
// it up); the caller then reads the PNG back to ingest it into the vault and put
// it on the clipboard, matching the macOS "capture into app storage" behaviour.
//
// Fallback if these signatures ever drift on a future Shell: open GNOME's native
// picker with `Main.screenshotUI.open()` — it already saves to Screenshots and
// copies to the clipboard, so both popup sections still update via the watchers.
const ScreenshotIface = `
<node>
  <interface name="org.gnome.Shell.Screenshot">
    <method name="Screenshot">
      <arg type="b" direction="in" name="include_cursor"/>
      <arg type="b" direction="in" name="flash"/>
      <arg type="s" direction="in" name="filename"/>
      <arg type="b" direction="out" name="success"/>
      <arg type="s" direction="out" name="filename_used"/>
    </method>
    <method name="ScreenshotArea">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
      <arg type="b" direction="in" name="flash"/>
      <arg type="s" direction="in" name="filename"/>
      <arg type="b" direction="out" name="success"/>
      <arg type="s" direction="out" name="filename_used"/>
    </method>
    <method name="SelectArea">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="width"/>
      <arg type="i" direction="out" name="height"/>
    </method>
  </interface>
</node>`;

const ScreenshotProxy = Gio.DBusProxy.makeProxyWrapper(ScreenshotIface);

// The Screenshot service is hosted by gnome-shell itself — the same process this
// extension runs in. Building the proxy *synchronously* makes a blocking D-Bus
// call that gnome-shell must answer while its main loop is stuck waiting for that
// very reply, so the Shell freezes for the D-Bus timeout and the click is lost.
// Build it asynchronously instead (main loop keeps spinning) and cache the result
// so only the first capture pays the setup cost.
let _proxy = null;
let _pending = null;

function withProxy(cb) {
    if (_proxy) {
        cb(_proxy, null);
        return;
    }
    if (_pending) {
        _pending.push(cb);
        return;
    }
    _pending = [cb];
    const flush = (p, err) => {
        const waiters = _pending;
        _pending = null;
        for (const w of waiters) w(p, err);
    };
    try {
        ScreenshotProxy(
            Gio.DBus.session,
            'org.gnome.Shell.Screenshot',
            '/org/gnome/Shell/Screenshot',
            (p, err) => {
                if (err) {
                    flush(null, err);
                    return;
                }
                _proxy = p;
                flush(p, null);
            },
        );
    } catch (e) {
        flush(null, e);
    }
}

function finish(res, err, onDone) {
    if (err) {
        onDone(null, err);
        return;
    }
    const [success, filenameUsed] = res;
    if (success) onDone(filenameUsed, null);
    else onDone(null, new Error('screenshot was not saved'));
}

// onDone(pathUsed | null, error | null)
export function captureFull(destPath, onDone) {
    withProxy((p, err) => {
        if (err) {
            onDone(null, err);
            return;
        }
        p.ScreenshotRemote(false, true, destPath,
            (res, e) => finish(res, e, onDone));
    });
}

export function captureArea(destPath, onDone) {
    withProxy((p, err) => {
        if (err) {
            onDone(null, err);
            return;
        }
        p.SelectAreaRemote((sel, selErr) => {
            if (selErr) {
                onDone(null, selErr);
                return;
            }
            const [x, y, w, h] = sel;
            p.ScreenshotAreaRemote(x, y, w, h, true, destPath,
                (res, e) => finish(res, e, onDone));
        });
    });
}
