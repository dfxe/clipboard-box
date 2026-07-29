// Clipboard writes, in one place. Every one of these tells the monitor to
// ignore the fingerprint it is about to produce, so our own writes don't come
// straight back in as fresh history entries.
//
// Success is confirmed by the row flash in the popup (see Indicator._flash), so
// only failures reach the notification tray.

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { fingerprintFor } from './vaultStore.js';

export function copyText(text, monitor) {
    monitor?.ignore(fingerprintFor('text', new TextEncoder().encode(text)));
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

// The one path every tool uses to hand text back to the user. The order is
// load-bearing: the vault has to own the fingerprint before the monitor is told
// to ignore it, and the monitor has to be told before the write lands, or our
// own write comes straight back in as a new history entry.
//
// Storing explicitly (rather than letting the monitor pick the write up) also
// means a tool's output still reaches history while monitoring is paused —
// deliberate, and the same way a capture behaves.
//
// `store` is per-tool: a calculator result is worth keeping, a 40-line snippet
// body or a single emoji would just crowd out the history you actually wanted.
export function ingestText(text, ctx, { store = false, title } = {}) {
    let fingerprint = null;
    if (store && ctx.vault)
        fingerprint = ctx.vault.add({ kind: 'text', text, title })?.fingerprint ?? null;

    ctx.monitor?.ignore(
        fingerprint ?? fingerprintFor('text', new TextEncoder().encode(text)));
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    ctx.requestPaste?.();
}

// Read a PNG off disk without blocking the compositor, then copy it to the
// clipboard. Large screenshots would otherwise stall the Shell if read
// synchronously on the main thread. `onDone` fires once the bytes are actually
// on the clipboard, which is the only safe moment to paste them.
export function copyPngFile(path, monitor, onDone) {
    const base = GLib.path_get_basename(path);
    Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
        try {
            const [ok, bytes] = file.load_contents_finish(res);
            if (!ok) {
                Main.notifyError('clipboard-box', `Could not read ${base}`);
                return;
            }
            // Unlike the vault paths there is no stored fingerprint to reuse —
            // a screenshot on disk was never a history entry — so compute it
            // here. Without this the copy bounces back through the monitor and
            // the screenshot lands in history as if the user had copied it.
            monitor?.ignore(fingerprintFor('image', bytes));
            St.Clipboard.get_default().set_content(
                St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
            onDone?.();
        } catch (e) {
            Main.notifyError('clipboard-box', e.message ?? String(e));
        }
    });
}

// Terminal programs can't read image/png off the clipboard without a helper
// binary, but every one of them understands a path — Claude Code turns a pasted
// path matching /\.(png|jpe?g|gif|webp)$/ straight into an image attachment.
export function copyPathText(path, monitor) {
    copyText(path, monitor);
}
