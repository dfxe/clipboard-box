// Screen colour picker: a full-stage overlay that samples the pixel under the
// pointer and shows it live as #RRGGBB, then copies it on click.
//
// The Shell exposes org.gnome.Shell.Screenshot.PickColor over D-Bus, but that
// opens GNOME's own eyedropper — a recoloured cursor with no readable value —
// so it can't give us a hex tooltip. We sample with Shell.Screenshot.pick_color
// directly instead, the same call the Shell's own PickPixel widget uses.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';

// Distance from the sampled pixel to the nearest corner of the readout.
// pick_color re-paints the stage to read it back, so anything we draw on top of
// the pointer gets sampled instead of the screen underneath — hence the offset,
// and hence _positionTip flips sides at a screen edge rather than clamping.
const TIP_GAP = 18;

// pick_color_finish() returns [ok, color]; GJS's promisified wrapper strips the
// leading `true` and resolves to [color]. Either way the colour is last.
function lastOf(value) {
    return Array.isArray(value) ? value[value.length - 1] : value;
}

// gnome-shell's ui/screenshot.js runs
//     Gio._promisify(Shell.Screenshot.prototype, 'pick_color')
// at startup, which moves the plain GAsyncReadyCallback version to
// _original_pick_color. Reaching for that keeps us on the callback form no
// matter how a given GJS treats a caller-supplied callback, and it still works
// if a future Shell drops the promisify — then pick_color *is* the raw form.
function pickColorAt(screenshot, x, y, onColor) {
    const proto = Shell.Screenshot.prototype;
    const pick = proto._original_pick_color ?? proto.pick_color;

    let settled = false;
    const deliver = color => {
        if (settled) return;
        settled = true;
        onColor(color ?? null);
    };

    let ret;
    try {
        ret = pick.call(screenshot, Math.round(x), Math.round(y), (obj, res) => {
            try { deliver(lastOf(obj.pick_color_finish(res))); }
            catch (_) { deliver(null); }
        });
    } catch (_) {
        deliver(null);
        return;
    }

    // Belt and braces: a GJS that promisified everything regardless of arity
    // would have swallowed the callback and handed us a promise instead.
    if (ret && typeof ret.then === 'function')
        ret.then(v => deliver(lastOf(v))).catch(() => deliver(null));
}

function toHex(rgb255) {
    const part = v =>
        Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${rgb255.map(part).join('')}`.toUpperCase();
}

// pick_color hands back a Clutter.Color on 45/46 (0-255 integer members) and a
// Cogl.Color on newer mutter, whose components have been both bytes and 0-1
// floats across releases — and which on some versions exposes no red/green/blue
// properties at all, only accessors. Probe the object rather than hardcoding a
// scale for whichever Shell we happen to be running under.
export function hexFromColor(color) {
    if (!color) return null;

    // Clutter.Color renders itself as "#rrggbbaa"; Cogl.Color has no to_string.
    if (typeof color.to_string === 'function') {
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color.to_string());
        if (m) return `#${m[1]}${m[2]}${m[3]}`.toUpperCase();
    }

    // Cogl.Color's accessors are floats in [0,1] on every mutter that has them.
    if (typeof color.get_red === 'function') {
        return toHex([color.get_red(), color.get_green(), color.get_blue()]
            .map(v => v * 255));
    }

    // Bare struct members: infer the scale from the values. This last tier is
    // only reachable on a Shell where both probes above fail, and it misreads a
    // byte-scale colour whose every component is 0 or 1 — i.e. near-black — as
    // unit floats. Nothing above it can go wrong on 45-49 as shipped.
    const parts = [color.red, color.green, color.blue];
    if (parts.some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
    const unit = parts.some(v => !Number.isInteger(v)) || Math.max(...parts) <= 1;
    return toHex(unit ? parts.map(v => v * 255) : parts);
}

const ColorPickerOverlay = GObject.registerClass(
class ColorPickerOverlay extends St.Widget {
    _init(onDone) {
        super._init({
            visible: false,
            reactive: true,
            // Honour the readout's set_position and natural size verbatim.
            layout_manager: new Clutter.FixedLayout(),
        });

        this._onDone = onDone;
        this._screenshot = new Shell.Screenshot();
        this._grabHelper = new GrabHelper.GrabHelper(this);

        this._hex = null;       // newest colour seen
        this._result = null;    // colour the user actually clicked on
        this._inPick = false;   // motion outruns pick_color by an order of magnitude
        this._queued = null;
        this._finished = false;
        this._settled = false;
        this._disposed = false;
        this._idleId = 0;
        this._tipX = 0;
        this._tipY = 0;

        Main.uiGroup.add_child(this);
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._swatch = new St.Widget({
            style_class: 'cb-pick-swatch',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'cb-pick-hex',
            text: '#……',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tip = new St.BoxLayout({ style_class: 'cb-pick-tip' });
        this._tip.add_child(this._swatch);
        this._tip.add_child(this._label);
        // Our own position is bound to the stage, so a child's local coordinates
        // are stage coordinates and _positionTip can use pointer coords as-is.
        this.add_child(this._tip);

        const click = new Clutter.ClickAction();
        click.connect('clicked', action => {
            if (this._finished) return;
            if (action.get_button() !== Clutter.BUTTON_PRIMARY) {
                this._ungrab();     // right / middle click cancels
                return;
            }
            this._finished = true;  // freeze the live readout
            // Re-pick at the click point rather than trusting the last live
            // value: the _inPick guard drops motion samples, so the readout can
            // legitimately be one position behind at the moment of the click.
            this._pickAt(...action.get_coords(), true);
        });
        this.add_action(click);

        // The generic ::event signal rather than vfunc_motion_event: per-type
        // event vfuncs are the part of the Clutter actor API most likely to have
        // shifted across the 45-49 range this extension claims.
        this.connect('event', (_actor, event) => this._onEvent(event));
    }

    // Returns false if the modal grab could not be taken.
    start() {
        Main.uiGroup.set_child_above_sibling(this, null);
        this.show();
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);

        const [x, y] = global.get_pointer();
        this._positionTip(x, y);
        this._pickAt(x, y, false);

        const ok = this._grabHelper.grab({
            actor: this,
            onUngrab: () => this._settle(),
        });
        if (!ok) {
            this._teardown();
            this._report(null, new Error('Could not grab the pointer'));
        }
        return ok;
    }

    _onEvent(event) {
        if (this._finished || this._disposed)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        if (type === Clutter.EventType.MOTION || type === Clutter.EventType.ENTER) {
            const [x, y] = event.get_coords();
            this._positionTip(x, y);
            this._pickAt(x, y, false);
        }
        // Never swallow: the ClickAction has to see press and release.
        return Clutter.EVENT_PROPAGATE;
    }

    _pickAt(x, y, final) {
        if (this._inPick) {
            // Keep the newest request so the readout catches up the moment the
            // pointer settles — PickPixel just drops these, which leaves it
            // showing whatever it sampled mid-sweep. A live sample must never
            // displace a queued final pick.
            if (!this._queued?.final)
                this._queued = { x, y, final };
            return;
        }

        this._inPick = true;
        pickColorAt(this._screenshot, x, y, color => {
            this._inPick = false;
            if (this._disposed) return;

            const hex = hexFromColor(color);
            if (hex) {
                this._hex = hex;
                this._label.text = hex;
                this._swatch.style = `background-color: ${hex};`;
                // The readout just changed width; re-place it so it keeps its
                // gap from the pointer and stays on the right side of an edge.
                this._positionTip(this._tipX, this._tipY);
            }

            if (final) {
                this._result = this._hex;
                this._ungrab();
                return;
            }

            const queued = this._queued;
            this._queued = null;
            if (queued) this._pickAt(queued.x, queued.y, queued.final);
        });
    }

    _positionTip(x, y) {
        this._tipX = x;
        this._tipY = y;

        // Scan layoutManager.monitors rather than using a Meta rectangle helper:
        // the Meta.Rectangle -> Mtk.Rectangle rename landed inside our range.
        const mon = Main.layoutManager.monitors.find(m =>
            x >= m.x && x < m.x + m.width &&
            y >= m.y && y < m.y + m.height) ?? Main.layoutManager.primaryMonitor;
        if (!mon) return;

        const [, width] = this._tip.get_preferred_width(-1);
        const [, height] = this._tip.get_preferred_height(width);

        // Flip, don't clamp: a clamped readout could end up under the pointer,
        // and pick_color would then sample the readout instead of the screen.
        let tipX = x + TIP_GAP;
        if (tipX + width > mon.x + mon.width) tipX = x - TIP_GAP - width;
        let tipY = y + TIP_GAP;
        if (tipY + height > mon.y + mon.height) tipY = y - TIP_GAP - height;

        this._tip.set_position(Math.round(tipX), Math.round(tipY));
    }

    _ungrab() {
        if (this._grabHelper?.grabbed) this._grabHelper.ungrab();
        else this._settle();
    }

    // Every ordinary exit runs through here: our own ungrab after a click, the
    // Escape key (which GrabHelper handles for us), or a dismissal it decided on.
    _settle() {
        if (this._settled) return;
        this._settled = true;
        const hex = this._result;
        this._teardown();
        this._report(hex, null);    // a null hex means the user cancelled
    }

    _teardown() {
        this._disposed = true;
        this._queued = null;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        // Destroying an actor from inside its own grab/event dispatch is asking
        // for trouble; PickPixel defers the same way.
        if (!this._idleId) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleId = 0;
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _report(hex, err) {
        const onDone = this._onDone;
        this._onDone = null;
        onDone?.(hex, err);
    }

    // Hard stop for disable(). Tears down without ever calling back.
    cancel() {
        this._settled = true;   // set before ungrab so _settle() no-ops
        this._onDone = null;
        if (this._grabHelper?.grabbed) this._grabHelper.ungrab();
        this._teardown();
        this.destroy();
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._disposed = true;
        this._grabHelper = null;
        this._screenshot = null;
        this._onDone = null;
        super.destroy();
    }
});

let _active = null;
let _deferId = 0;

// onDone(hex, error). A null hex with no error means the user cancelled with
// Escape or a non-primary click — callers stay silent on that, the same way
// Indicator._capture() swallows a cancelled SelectArea.
export function pickColor(onDone) {
    cancelActive();

    // menu.close() drops the popup's own modal grab synchronously, but the
    // button release that got us here is still in flight. Taking our grab on the
    // next main-loop turn keeps the two grabs from overlapping.
    _deferId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        _deferId = 0;
        const picker = new ColorPickerOverlay((hex, err) => {
            if (_active === picker) _active = null;
            onDone(hex, err);
        });
        _active = picker;   // assign before start(): a failed grab reports from
        picker.start();     // inside it, synchronously
        return GLib.SOURCE_REMOVE;
    });
}

// A modal grab that outlives the extension leaves the session unable to click
// anything, so disable() calls this before it can throw anywhere else.
export function cancelActive() {
    if (_deferId) {
        GLib.source_remove(_deferId);
        _deferId = 0;
    }
    const picker = _active;
    _active = null;         // null first so a re-entrant call can't double-free
    picker?.cancel();
}
