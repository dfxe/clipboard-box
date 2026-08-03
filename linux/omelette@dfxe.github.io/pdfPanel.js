// The panel the PDF shortcut opens into: a file to work on, a page range, and
// the button that does it. Sibling of sensorsPanel.js — a UI module, which is
// why it may import St where a provider may not.
//
// It is the only thing in this extension with a text entry outside the search
// box, and that costs something: the Indicator has to stop rebuilding the list
// while this is on screen, or a background refresh destroys the field
// mid-keystroke. See _panelHold in extension.js.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import { parsePageRange, outputPaths } from './pdfExtract.js';

// What the status line says before the user has typed anything worth judging.
const RESTING_HINT = 'A page, like 7, or a range, like 3-7.';

function label(text, styleClass, extra = {}) {
    const widget = new St.Label({ text, style_class: styleClass, ...extra });
    widget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return widget;
}

// -> { actor, holdsFocus, focus, onEscape, update }, or null.
//
// Null when poppler is missing: a form whose only button cannot possibly
// succeed is worse than a sentence, and returning null is what makes refresh()
// fall through to the ordinary rows so pdfProvider.emptyMessage can say why.
// Same bargain buildSensorsPanel makes with an empty snapshot, and it keeps
// that explanation in one place rather than two.
//
// `state` is read once to draw and then again on every update(); the panel
// keeps no copy of its own, so there is exactly one place the truth lives.
export function buildPdfPanel(state, handlers) {
    if (state.missing.length > 0) return null;

    const panel = new St.BoxLayout({
        vertical: true,
        style_class: 'cb-panel cb-pdf',
        x_expand: true,
    });

    const browse = new St.Button({
        label: state.path ? 'Choose a different PDF…' : 'Choose a PDF…',
        x_expand: true,
        can_focus: true,
        style_class: 'cb-capture-btn button',
    });
    browse.connect('clicked', () => handlers.onBrowse());
    panel.add_child(browse);

    const fileLine = label(
        state.path ? describeFile(state) : 'No PDF chosen yet.',
        state.path ? 'cb-pdf-file' : 'cb-pdf-file cb-pdf-dim');
    panel.add_child(fileLine);

    const row = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'cb-pdf-row' });
    row.add_child(new St.Label({
        text: 'Pages',
        style_class: 'cb-pdf-label',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    const entry = new St.Entry({
        style_class: 'cb-pdf-range',
        hint_text: '3-7',
        can_focus: true,
        x_expand: true,
    });
    entry.set_text(state.pages ?? '');
    row.add_child(entry);

    const extract = new St.Button({
        label: 'Extract',
        can_focus: true,
        style_class: 'cb-capture-btn button',
    });
    row.add_child(extract);
    panel.add_child(row);

    const status = label(RESTING_HINT, 'cb-pdf-status');
    panel.add_child(status);

    // The one place that decides whether Extract can fire, so the button and
    // the Enter key can never disagree about it.
    let range = null;
    const revalidate = () => {
        const text = entry.get_text();
        state.pages = text;

        if (!state.path) {
            range = null;
            setStatus(status, 'Choose a PDF first.', false);
        } else if (text.trim() === '') {
            range = null;
            setStatus(status, RESTING_HINT, false);
        } else {
            const parsed = parsePageRange(text, state.pageCount);
            if (parsed.error) {
                range = null;
                setStatus(status, parsed.error, true);
            } else {
                range = parsed;
                // Echo the destination before anything is written, so a
                // mistyped range is caught by reading rather than by finding
                // the wrong file afterwards.
                const { file } = outputPaths(state.path, parsed.first, parsed.last);
                setStatus(status, `→ ${shortenTo(file, state.path)}`, false);
            }
        }
        extract.reactive = range !== null;
        extract.can_focus = range !== null;
        if (range === null) extract.add_style_class_name('cb-pdf-off');
        else extract.remove_style_class_name('cb-pdf-off');
    };

    const fire = () => {
        if (range) handlers.onExtract(range);
    };
    extract.connect('clicked', fire);
    entry.clutter_text.connect('activate', fire);
    entry.clutter_text.connect('text-changed', revalidate);
    revalidate();

    // Grabbing focus before the actor is on screen silently does nothing, and
    // the popup builds its contents before it maps. Wait for the map when we
    // are early, which needs no timer and dies with the actor.
    const grab = target => {
        if (target.mapped) {
            target.grab_key_focus();
            return;
        }
        const id = target.connect('notify::mapped', () => {
            if (!target.mapped) return;
            target.disconnect(id);
            target.grab_key_focus();
        });
    };

    return {
        actor: panel,

        // Tells the Indicator to hand us the keyboard and stop rebuilding.
        holdsFocus: true,

        focus() {
            grab(state.path ? entry : browse);
        },

        // Escape peels the range field before it peels the tool, extending the
        // ladder the popup already uses rather than replacing it.
        onEscape() {
            if (entry.get_text() === '') return false;
            entry.set_text('');
            return true;
        },

        // Called when the page count arrives from pdfinfo. Rewrites labels in
        // place: a rebuild here would take the entry, and its text, with it.
        update(next) {
            fileLine.text = next.path ? describeFile(next) : 'No PDF chosen yet.';
            if (next.path) fileLine.remove_style_class_name('cb-pdf-dim');
            browse.label = next.path ? 'Choose a different PDF…' : 'Choose a PDF…';
            revalidate();
        },
    };
}

function describeFile(state) {
    const name = state.name || state.path;
    if (state.error) return `${name} · ${state.error}`;
    if (state.pageCount <= 0) return `${name} · reading…`;
    const pages = state.pageCount === 1 ? '1 page' : `${state.pageCount} pages`;
    // pdfseparate's manual says the source should not be encrypted, so warn
    // here rather than after a range has been typed and Extract pressed.
    return state.encrypted
        ? `${name} · ${pages} · encrypted, this may fail`
        : `${name} · ${pages}`;
}

function setStatus(widget, text, isError) {
    widget.text = text;
    if (isError) widget.add_style_class_name('cb-pdf-error');
    else widget.remove_style_class_name('cb-pdf-error');
}

// The destination always sits under the source's own folder, so showing the
// absolute path would be mostly repetition. Show the part that is new.
function shortenTo(file, source) {
    const cut = source.lastIndexOf('/');
    return cut > 0 && file.startsWith(source.slice(0, cut + 1))
        ? file.slice(cut + 1)
        : file;
}
