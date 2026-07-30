import GLib from 'gi://GLib';

import { formatBytes, relativeAge, HEX_RE } from '../cboite@dfxe.github.io/format.js';
import { suite, it, eq, ok } from './harness.js';

suite('format');

it('formats byte counts across the unit boundaries', () => {
    eq(formatBytes(0), '0 B');
    eq(formatBytes(1023), '1023 B');
    eq(formatBytes(1024), '1.0 KB');
    eq(formatBytes(1536), '1.5 KB');
    eq(formatBytes(1024 * 1024), '1.0 MB');
    eq(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

it('treats missing byte counts as zero rather than printing NaN', () => {
    eq(formatBytes(null), '0 B');
    eq(formatBytes(undefined), '0 B');
});

it('formats relative ages', () => {
    const ago = secs => GLib.DateTime.new_now_local().add_seconds(-secs).format_iso8601();
    eq(relativeAge(ago(5)), '5s');
    eq(relativeAge(ago(120)), '2m');
    eq(relativeAge(ago(7200)), '2h');
    eq(relativeAge(ago(172800)), '2d');
});

it('never renders a negative age for a clock skewed into the future', () => {
    const future = GLib.DateTime.new_now_local().add_seconds(60).format_iso8601();
    eq(relativeAge(future), '0s');
});

it('returns empty string for an unparseable timestamp', () => {
    eq(relativeAge('not a date'), '');
    eq(relativeAge(''), '');
});

it('HEX_RE matches only full six-digit hex colours', () => {
    ok(HEX_RE.test('#ff0000'));
    ok(HEX_RE.test('#AABBCC'));
    ok(!HEX_RE.test('#fff'), 'three-digit shorthand is not matched');
    ok(!HEX_RE.test('ff0000'), 'the hash is required');
    ok(!HEX_RE.test('#ff0000 '), 'trailing space must not match');
    ok(!HEX_RE.test('#gg0000'));
});
