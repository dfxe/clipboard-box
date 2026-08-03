// Battery levels for connected Bluetooth devices, and fan speeds if this
// machine has any.
//
// Both readings are local: BlueZ over the system bus, and /sys/class/hwmon.
// Nothing here reaches the network, and neither source needs root.
//
// The shape is currency.js's: this module owns the asynchronous work and the
// cache, and hands the command bar a *synchronous* snapshot() that returns
// whatever is known right now. That split is not optional — search() runs on
// the compositor thread on every keystroke, so a D-Bus round trip or an ACPI
// read in that path would stutter the whole desktop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BLUEZ = 'org.bluez';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';

const HWMON_ROOT = '/sys/class/hwmon';

// BlueZ emits a burst of PropertiesChanged when a device connects — several
// interfaces settle in the same tick. Coalesce them into one re-read.
const SIGNAL_DEBOUNCE_MS = 150;

let _devices = [];
let _fans = [];

let _bus = null;
let _busPending = null;
let _subIds = [];
let _cancellable = null;
let _debounceId = 0;
let _tickId = 0;
let _primed = false;
let _bluezWarned = false;
let _onRefresh = null;

// Discovered once per process: which hwmon files to read. See fanSpecs().
let _fanSpecs = null;

// --- Pure parsers ---------------------------------------------------------
//
// Separated from the I/O above them so the tests can exercise the real parsing
// with plain object fixtures — the same seam dataDir.js opens with
// resolveDir(). CI has no session bus, no BlueZ and no fan, so anything that
// only exists inside a callback is untestable there.

// BlueZ hands out a freedesktop icon name (`input-mouse`, `audio-headphones`,
// `audio-card`, `input-gaming`); the symbolic variant of each is in Adwaita.
export function iconForDevice(dev) {
    const hint = dev?.Icon;
    return hint ? `${hint}-symbolic` : 'bluetooth-symbolic';
}

// GetManagedObjects gives every known object with all of its interfaces. Keep
// the ones that are connected *and* actually report a battery: a paired but
// idle speaker has no percentage to show, and listing it with a blank gauge
// would be worse than leaving it out.
export function devicesFromManagedObjects(objects) {
    const out = [];

    for (const [path, ifaces] of Object.entries(objects ?? {})) {
        const dev = ifaces?.[DEVICE_IFACE];
        if (!dev || dev.Connected !== true) continue;

        const percent = ifaces?.[BATTERY_IFACE]?.Percentage;
        if (typeof percent !== 'number' || !Number.isFinite(percent)) continue;

        out.push({
            path,
            address: dev.Address ?? '',
            name: dev.Alias || dev.Name || dev.Address || 'Bluetooth device',
            percent: Math.max(0, Math.min(100, Math.round(percent))),
            icon: iconForDevice(dev),
        });
    }

    // By name, so the list doesn't reshuffle as D-Bus hands objects back in a
    // different order between calls.
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Turns raw hwmon readings into display rows. A fan reading 0 is either stopped
// or a channel the driver doesn't really populate; either way there is nothing
// worth showing.
export function fansFromReadings(readings) {
    const out = [];

    for (const r of readings ?? []) {
        const rpm = Number(r?.rpm);
        if (!Number.isFinite(rpm) || rpm <= 0) continue;

        // fanN_label is optional. Falling back to the chip name plus the
        // channel index keeps two unlabelled fans distinguishable.
        const label = r.label?.trim() || `${r.chip ?? 'fan'} fan${r.index ?? ''}`.trim();
        out.push({ id: r.id ?? label, label, rpm: Math.round(rpm) });
    }

    return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function formatRpm(rpm) {
    return `${rpm} RPM`;
}

// --- Bluetooth ------------------------------------------------------------

// Async like capture.js's withProxy, and for a related reason: bus_get_sync
// blocks the compositor's main loop until the handshake completes. Callers that
// arrive mid-connection queue up rather than opening a second connection.
function withBus(cb) {
    if (_bus) {
        cb(_bus, null);
        return;
    }
    if (_busPending) {
        _busPending.push(cb);
        return;
    }
    _busPending = [cb];

    const flush = (bus, err) => {
        const waiters = _busPending;
        _busPending = null;
        for (const w of waiters) w(bus, err);
    };

    try {
        Gio.bus_get(Gio.BusType.SYSTEM, null, (_source, res) => {
            try {
                _bus = Gio.bus_get_finish(res);
                flush(_bus, null);
            } catch (e) {
                flush(null, e);
            }
        });
    } catch (e) {
        flush(null, e);
    }
}

function readBluetooth(done) {
    withBus((bus, err) => {
        if (!bus) {
            done([], err);
            return;
        }
        try {
            bus.call(
                BLUEZ, '/', OBJECT_MANAGER, 'GetManagedObjects', null,
                new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE, -1, _cancellable,
                (conn, res) => {
                    try {
                        // recursiveUnpack turns the whole nested a{sv} tree into
                        // plain JS — a `y` byte becomes a number — which is what
                        // lets devicesFromManagedObjects be a pure function.
                        const [objects] = conn.call_finish(res).recursiveUnpack();
                        done(devicesFromManagedObjects(objects), null);
                    } catch (e) {
                        done([], e);
                    }
                });
        } catch (e) {
            done([], e);
        }
    });
}

// --- Fans -----------------------------------------------------------------

// Which files to read, worked out once. Walking /sys/class/hwmon and reading
// `name` / `fanN_label` is pure kernel memory and costs nothing, so it happens
// synchronously; only fanN_input is worth an async read, because on this class
// of laptop it goes through the vendor's ACPI/WMI handler rather than a value
// the kernel already has sitting in RAM.
function fanSpecs() {
    if (_fanSpecs) return _fanSpecs;
    _fanSpecs = [];

    let dir;
    try {
        dir = GLib.Dir.open(HWMON_ROOT, 0);
    } catch (_) {
        // No hwmon at all (a container, or a kernel without it). Not an error:
        // a machine with no fan sensors simply shows no fan rows.
        return _fanSpecs;
    }

    const readSysfs = path => {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes).trim() : null;
        } catch (_) {
            return null;
        }
    };

    for (;;) {
        const entry = dir.read_name();
        if (!entry) break;

        const base = GLib.build_filenamev([HWMON_ROOT, entry]);
        const chip = readSysfs(GLib.build_filenamev([base, 'name'])) ?? entry;

        let names;
        try {
            names = GLib.Dir.open(base, 0);
        } catch (_) {
            continue;
        }

        for (;;) {
            const file = names.read_name();
            if (!file) break;

            const m = /^fan(\d+)_input$/.exec(file);
            if (!m) continue;

            const index = m[1];
            _fanSpecs.push({
                id: `${entry}:fan${index}`,
                chip,
                index,
                label: readSysfs(GLib.build_filenamev([base, `fan${index}_label`])),
                input: GLib.build_filenamev([base, file]),
            });
        }
        names.close();
    }
    dir.close();

    return _fanSpecs;
}

function readFans(done) {
    const specs = fanSpecs();
    if (specs.length === 0) {
        done([]);
        return;
    }

    const readings = new Array(specs.length);
    let remaining = specs.length;

    for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const settle = rpm => {
            readings[i] = { ...spec, rpm };
            if (--remaining === 0) done(readings);
        };

        try {
            Gio.File.new_for_path(spec.input).load_contents_async(
                _cancellable, (file, res) => {
                    try {
                        const [ok, bytes] = file.load_contents_finish(res);
                        settle(ok ? parseInt(new TextDecoder().decode(bytes).trim(), 10) : NaN);
                    } catch (_) {
                        // The driver can refuse a read (fan powered down, or the
                        // device went away). fansFromReadings drops it.
                        settle(NaN);
                    }
                });
        } catch (_) {
            settle(NaN);
        }
    }
}

// --- Refresh --------------------------------------------------------------

function sameDevices(a, b) {
    if (a.length !== b.length) return false;
    return a.every((d, i) => d.path === b[i].path && d.percent === b[i].percent);
}

function sameFans(a, b) {
    if (a.length !== b.length) return false;
    return a.every((f, i) => f.id === b[i].id && f.rpm === b[i].rpm);
}

function refreshNow() {
    _cancellable ??= new Gio.Cancellable();
    const generation = _cancellable;

    // Ignore anything that lands after a shutdown() — the extension may already
    // have torn its UI down, and refreshing into it would resurrect actors.
    const current = () => _cancellable === generation && !generation.is_cancelled();

    readBluetooth((devices, err) => {
        if (!current()) return;
        if (err && !_bluezWarned) {
            // Once per process. A machine with bluetoothd stopped would
            // otherwise log this on every tick.
            _bluezWarned = true;
            log(`omelette: no Bluetooth battery data (${err.message ?? err})`);
        }
        if (sameDevices(devices, _devices)) return;
        _devices = devices;
        _onRefresh?.();
    });

    readFans(readings => {
        if (!current()) return;
        const fans = fansFromReadings(readings);
        if (sameFans(fans, _fans)) return;
        _fans = fans;
        _onRefresh?.();
    });
}

function scheduleRefresh() {
    if (_debounceId) GLib.source_remove(_debounceId);
    _debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SIGNAL_DEBOUNCE_MS, () => {
        _debounceId = 0;
        refreshNow();
        return GLib.SOURCE_REMOVE;
    });
}

// --- Public API -----------------------------------------------------------

// Never blocks. Returns the last known readings — possibly a moment stale,
// possibly empty on the very first call — or null when the feature is off.
//
// `onRefresh` fires only when a value actually changed, so the popup redraws
// when a battery ticks down but not on every identical poll.
export function snapshot(settings, onRefresh) {
    if (!settings?.get_boolean('sensors-enabled')) return null;

    if (onRefresh) _onRefresh = onRefresh;
    if (!_primed) {
        _primed = true;
        refreshNow();
    }

    return { devices: _devices, fans: _fans };
}

// Called when the popup opens. Bluetooth is push-driven: BlueZ signals a
// battery change, so there is nothing to poll. Fans have no signal, so they get
// the codebase's only repeating timer — armed here and disarmed on close, so it
// never runs against a popup nobody is looking at.
export function startWatching(settings) {
    if (!settings?.get_boolean('sensors-enabled')) return;
    if (_subIds.length > 0 || _tickId) return;

    _cancellable ??= new Gio.Cancellable();

    withBus(bus => {
        // The bus resolves asynchronously, so a second startWatching() can land
        // before the first one has subscribed. Without this the popup would hold
        // two subscriptions and refresh twice per battery change.
        if (!bus || _subIds.length > 0) return;
        const sub = (iface, name, handler) => _subIds.push(
            bus.signal_subscribe(BLUEZ, iface, name, null, null,
                Gio.DBusSignalFlags.NONE, handler));

        sub(OBJECT_MANAGER, 'InterfacesAdded', () => scheduleRefresh());
        sub(OBJECT_MANAGER, 'InterfacesRemoved', () => scheduleRefresh());
        sub('org.freedesktop.DBus.Properties', 'PropertiesChanged',
            (_c, _s, _p, _i, _n, params) => {
                // Every object on the bus emits this; only the two interfaces we
                // read from are worth a re-read.
                const [changed] = params.deepUnpack();
                if (changed === BATTERY_IFACE || changed === DEVICE_IFACE)
                    scheduleRefresh();
            });
    });

    if (fanSpecs().length > 0) {
        const seconds = Math.max(1, settings.get_int('sensors-poll-seconds'));
        _tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            refreshNow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    refreshNow();
}

export function stopWatching() {
    if (_tickId) {
        GLib.source_remove(_tickId);
        _tickId = 0;
    }
    if (_debounceId) {
        GLib.source_remove(_debounceId);
        _debounceId = 0;
    }
    if (_bus) {
        for (const id of _subIds) _bus.signal_unsubscribe(id);
    }
    _subIds = [];
}

export function shutdown() {
    stopWatching();
    _cancellable?.cancel();
    _cancellable = null;
    _bus = null;
    _busPending = null;
    _primed = false;
    _onRefresh = null;
    // _devices/_fans/_fanSpecs survive: they are a cache, and re-walking hwmon
    // on every enable would be wasted work. _primed resets so the next
    // snapshot() re-reads rather than serving values from before the disable.
}
