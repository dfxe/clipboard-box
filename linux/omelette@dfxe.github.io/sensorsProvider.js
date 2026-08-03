// Bluetooth battery levels and fan speeds, as command-bar rows.
//
// Pure and synchronous like every other provider: it reads the snapshot
// sensors.js already holds and never waits on anything. The first search after
// the popup opens may see empty lists; the refresh callback redraws the rows a
// moment later, the same bargain the currency answer makes.

import { scoreAnyPre, scorePre, normalize, byScore, NO_MATCH } from './match.js';
import { formatRpm } from './sensors.js';
import { ingestText } from './clipboardUtil.js';

// Shorter than aboutProvider's 3 because "bt" is the natural way to ask for
// this, and it is a specific enough pair not to fire by accident.
const MIN_QUERY = 2;

const DEVICE_KEYWORDS = ['bt', 'bluetooth', 'battery', 'batteries', 'batt'];
const FAN_KEYWORDS = ['fan', 'fans', 'rpm', 'cooling', 'speed'];

// Prefixes only, for the same reason aboutProvider scores that way: the loose
// subsequence tier that makes `bgcol` find `background-color` would have `bt`
// summon this section out of half the words in the language.
function scorePrefix(q, keywords) {
    const hits = keywords.filter(k => k.startsWith(q));
    return hits.length === 0 ? NO_MATCH : scoreAnyPre(q, hits);
}

function deviceResult(device, index, score) {
    const reading = `${device.percent}%`;
    return {
        id: `sensors:bt:${device.path}`,
        score,
        index,
        title: device.name,
        subtitle: `Bluetooth · ${reading}`,
        // The gauge stands in for the icon; the device's own symbolic icon is
        // already implied by its name, and two glyphs would crowd the row.
        visual: { kind: 'ring', percent: device.percent, size: 32 },
        accel: 'Copy',
        accessibleText: `${device.name}, battery ${reading}`,
        run: ctx => {
            ingestText(reading, ctx, { store: false });
            return { message: `Copied ${reading}`, close: true };
        },
    };
}

function fanResult(fan, index, score) {
    const reading = formatRpm(fan.rpm);
    return {
        id: `sensors:fan:${fan.id}`,
        score,
        index,
        title: fan.label,
        subtitle: reading,
        // No ring: RPM has no ceiling to fill an arc against, and inventing one
        // would draw a number that means nothing.
        visual: { kind: 'icon', name: 'weather-windy-symbolic', size: 32 },
        accel: 'Copy',
        accessibleText: `${fan.label}, ${reading}`,
        run: ctx => {
            ingestText(reading, ctx, { store: false });
            return { message: `Copied ${reading}`, close: true };
        },
    };
}

export const sensorsProvider = {
    id: 'sensors',
    title: 'System',
    cap: 8,

    search(query, ctx) {
        const snapshot = ctx.sensors?.();
        if (!snapshot) return [];

        const { devices = [], fans = [] } = snapshot;
        const scoped = ctx.scope === 'sensors';

        // One character is noise in the full bar. The exception is this
        // provider's own shortcut, which opens straight into the readings.
        if (query.length < MIN_QUERY && !scoped) return [];

        // Opened by the shortcut with nothing typed: list everything rather than
        // making the user type at a bar that was summoned for exactly this.
        // Typing then filters normally.
        const listAll = scoped && query === '';

        const q = normalize(query);
        const results = [];
        let index = 0;

        const deviceKeyword = listAll ? 0 : scorePrefix(q, DEVICE_KEYWORDS);
        for (const device of devices) {
            // A device also answers to its own name, so `master` finds the mouse
            // without knowing it is the thing called a battery.
            const byName = listAll ? NO_MATCH : scorePre(q, normalize(device.name));
            const score = Math.max(deviceKeyword, byName);
            if (score === NO_MATCH) continue;
            results.push(deviceResult(device, index++, score));
        }

        const fanKeyword = listAll ? 0 : scorePrefix(q, FAN_KEYWORDS);
        for (const fan of fans) {
            const byName = listAll ? NO_MATCH : scorePre(q, normalize(fan.label));
            const score = Math.max(fanKeyword, byName);
            if (score === NO_MATCH) continue;
            results.push(fanResult(fan, index++, score));
        }

        return results.sort(byScore);
    },

    // Silent in the unscoped bar, like the other tools — this only speaks up
    // when the user asked for it by shortcut and there was nothing to show.
    emptyMessage(ctx) {
        if (ctx.scope !== 'sensors') return null;
        if (!ctx.sensors?.()) return 'System readings are switched off in preferences.';
        return 'No connected Bluetooth device reports a battery, and no fan sensors were found.';
    },
};
