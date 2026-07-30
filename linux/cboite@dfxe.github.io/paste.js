// Auto-paste: synthesize Ctrl+V into whatever window has focus once the popup
// is out of the way. This is what makes the command bar feel like Raycast —
// Enter puts the thing in the app you were already in, rather than making you
// paste it yourself.
//
// The keystroke goes through a Clutter virtual input device, which mutter backs
// with XTestFakeKeyEvent on X11 and with its native input path on Wayland, so
// the same code covers both.
//
// Module state survives disable/enable (ESM modules stay loaded), so shutdown()
// is called from the top of enable() as well as from disable() — the same
// discipline colorPicker.js uses for its grab.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// Time for the popup to finish closing and for focus to land back on the target
// window. Too short and the keystroke goes to the Shell instead; on X11 the
// input-focus sync is not guaranteed within the same main loop turn, so an idle
// callback is not enough.
const DEFAULT_DELAY_MS = 120;

// If the bar was opened with a shortcut, the user may still be physically
// holding its modifiers when they hit Enter — the app would then see
// Ctrl+Super+Shift+V and do nothing. Wait for them to let go.
const MOD_POLL_MS = 40;
const MOD_POLL_MAX_MS = 600;
const BLOCKING_MODS =
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.MOD4_MASK;

// {cursor} is implemented as arrow-key presses, and many apps drop long bursts
// of synthetic events. Past this point the marker is simply ignored.
const MAX_LEFT_PRESSES = 200;

// VTE-family terminals bind paste to Ctrl+Shift+V, and there is no protocol to
// ask a window what its paste binding is. This list is the honest ceiling; it
// lives in GSettings so it can be extended without a code change.
export const DEFAULT_SHIFT_CLASSES = [
    'gnome-terminal-server', 'org.gnome.Terminal', 'org.gnome.Ptyxis', 'Ptyxis',
    'org.gnome.Console', 'kgx', 'kitty', 'Alacritty', 'konsole', 'foot',
    'org.wezfurlong.wezterm', 'com.mitchellh.ghostty', 'xterm', 'urxvt',
    'rxvt', 'st-256color', 'Terminator', 'tilix', 'contour', 'WezTerm',
];

let _device = null;
const _timers = new Set();

function device() {
    if (_device) return _device;
    try {
        const seat = Clutter.get_default_backend().get_default_seat();
        // InputDeviceType, not VirtualDeviceType — both happen to be 1, but the
        // C signature is clutter_seat_create_virtual_device(ClutterInputDeviceType).
        _device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    } catch (e) {
        logError(e, 'cboite: no virtual keyboard, auto-paste unavailable');
        _device = null;
    }
    return _device;
}

function addTimer(ms, fn) {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        _timers.delete(id);
        fn();
        return GLib.SOURCE_REMOVE;
    });
    _timers.add(id);
    return id;
}

// notify_keyval wants microseconds.
function tap(dev, keyval, mods = []) {
    const t = GLib.get_monotonic_time();
    for (const m of mods) dev.notify_keyval(t, m, Clutter.KeyState.PRESSED);
    dev.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
    dev.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);
    for (const m of [...mods].reverse()) dev.notify_keyval(t, m, Clutter.KeyState.RELEASED);
}

function heldModifiers() {
    try {
        const [, , mods] = global.get_pointer();
        return mods & BLOCKING_MODS;
    } catch (_) {
        return 0;
    }
}

export function wantsShiftPaste(wmClass, settings) {
    if (!wmClass) return false;
    if (settings && !settings.get_boolean('paste-shortcut-terminals')) return false;
    const list = settings ? settings.get_strv('paste-shift-classes') : DEFAULT_SHIFT_CLASSES;
    const needle = wmClass.toLowerCase();
    return (list.length ? list : DEFAULT_SHIFT_CLASSES)
        .some(c => c.toLowerCase() === needle);
}

function fire(shift, leftPresses) {
    const dev = device();
    if (!dev) return;

    const mods = shift
        ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L]
        : [Clutter.KEY_Control_L];
    tap(dev, Clutter.KEY_v, mods);

    // {cursor}: walk the caret back into the placeholder's position. Best
    // effort — an editor that reformats or autocompletes after the paste will
    // land it somewhere else.
    const back = Math.min(leftPresses ?? 0, MAX_LEFT_PRESSES);
    for (let i = 0; i < back; i++) tap(dev, Clutter.KEY_Left);
}

// Wait out any modifiers the user is still holding, then paste. Gives up after
// MOD_POLL_MAX_MS and fires anyway — a stuck modifier shouldn't mean the paste
// silently never happens.
function whenModifiersClear(shift, leftPresses, waited = 0) {
    if (heldModifiers() === 0 || waited >= MOD_POLL_MAX_MS) {
        fire(shift, leftPresses);
        return;
    }
    addTimer(MOD_POLL_MS, () => whenModifiersClear(shift, leftPresses, waited + MOD_POLL_MS));
}

// `wmClass` is sampled when the popup opens, not now — by the time we run, the
// focus window may already have changed.
export function pasteInto({ wmClass, settings, leftPresses = 0 } = {}) {
    const shift = wantsShiftPaste(wmClass, settings);
    const delay = settings
        ? Math.max(0, settings.get_int('auto-paste-delay-ms'))
        : DEFAULT_DELAY_MS;
    addTimer(delay, () => whenModifiersClear(shift, leftPresses));
}

export function shutdown() {
    for (const id of _timers) GLib.source_remove(id);
    _timers.clear();
    _device = null;
}
