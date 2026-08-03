// The dashboard the sensors shortcut opens into: every battery at once as a
// grid of gauges, with the fans listed underneath.
//
// This is a UI module rather than a provider, which is why it may import St.
// The command bar's row-per-result shape answers "what is my mouse at?"; this
// one answers "how is this machine doing?" at a glance, without typing.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import { makeRing } from './gauge.js';
import { formatRpm } from './sensors.js';

// Big enough for "85%" inside the ring, and for four of them to sit across the
// 420px popup without crowding.
const RING_SIZE = 56;
const PER_ROW = 4;

function deviceTile(device) {
    const tile = new St.BoxLayout({
        vertical: true,
        style_class: 'cb-panel-tile',
        x_align: Clutter.ActorAlign.CENTER,
    });

    tile.add_child(makeRing({ percent: device.percent, size: RING_SIZE }));

    const caption = new St.Label({
        text: device.name,
        style_class: 'cb-panel-caption',
        x_align: Clutter.ActorAlign.CENTER,
    });
    // The tile is width-capped in the stylesheet, so a long alias ellipsizes
    // instead of pushing its neighbours off the grid.
    caption.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    tile.add_child(caption);

    return tile;
}

function fanLine(fan) {
    const line = new St.BoxLayout({
        vertical: false,
        style_class: 'cb-fan-row',
        x_expand: true,
    });

    line.add_child(new St.Icon({
        icon_name: 'weather-windy-symbolic',
        icon_size: 16,
        style_class: 'cb-fan-icon',
    }));

    const name = new St.Label({ text: fan.label, x_expand: true });
    name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    line.add_child(name);

    line.add_child(new St.Label({ text: formatRpm(fan.rpm), style_class: 'cb-fan-rpm' }));

    return line;
}

// Returns null when there is nothing to draw, so the caller can fall back to
// the ordinary rows and let the provider's emptyMessage explain why.
export function buildSensorsPanel(snapshot) {
    const devices = snapshot?.devices ?? [];
    const fans = snapshot?.fans ?? [];
    if (devices.length === 0 && fans.length === 0) return null;

    const panel = new St.BoxLayout({
        vertical: true,
        style_class: 'cb-panel',
        x_expand: true,
    });

    for (let i = 0; i < devices.length; i += PER_ROW) {
        const row = new St.BoxLayout({
            vertical: false,
            style_class: 'cb-panel-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        for (const device of devices.slice(i, i + PER_ROW))
            row.add_child(deviceTile(device));
        panel.add_child(row);
    }

    if (fans.length > 0) {
        const strip = new St.BoxLayout({
            vertical: true,
            style_class: 'cb-fan-strip',
            x_expand: true,
        });
        for (const fan of fans) strip.add_child(fanLine(fan));
        panel.add_child(strip);
    }

    return panel;
}
