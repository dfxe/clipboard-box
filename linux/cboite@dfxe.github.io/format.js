// Small display helpers shared by the popup and by the search providers. They
// live here rather than in extension.js so providers can format their own
// subtitles without importing the module that imports them.

import GLib from 'gi://GLib';

// Text entries that are just a colour get a swatch instead of the generic text
// glyph. Picked colours are the obvious case, but this also lights up a #rrggbb
// copied out of a stylesheet, which is a nice accident.
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function formatBytes(n) {
    if (!n || n < 1024) return `${n ?? 0} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function relativeAge(iso) {
    const then = GLib.DateTime.new_from_iso8601(iso, null);
    if (!then) return '';
    const secs = Math.max(0, Math.floor(GLib.DateTime.new_now_local().difference(then) / 1e6));
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
}
