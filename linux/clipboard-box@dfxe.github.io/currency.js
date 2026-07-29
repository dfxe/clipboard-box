// Exchange rates for the calculator's currency conversions.
//
// This is the only part of clipboard-box that touches the network, and it is
// OFF by default. Nothing here runs unless the user turns on `currency-enabled`
// AND actually types a currency query — there is no background timer and no
// fetch at enable().
//
// Everything is asynchronous. A synchronous HTTP call here would block the
// compositor's main loop, which means freezing the entire desktop until the
// server answers — or until DNS times out.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

// ECB reference rates by way of frankfurter.app: no API key, no signup, no
// per-client rate limit, and a stable JSON shape. The endpoint is a setting so
// it can be pointed elsewhere without a code change.
const DEFAULT_URL = 'https://api.frankfurter.app/latest?from=USD';

// Rates are published once a working day, so refetching more often than this
// buys nothing.
const MAX_AGE_SECONDS = 12 * 3600;

const CACHE_NAME = 'rates.json';

let _session = null;
let _cancellable = null;
let _table = null;      // { base, rates, fetchedAt }
let _loaded = false;    // has the on-disk cache been consulted this process?
let _inFlight = false;

function cachePath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(), 'clipboard-box', CACHE_NAME]);
}

function readCache() {
    const path = cachePath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok) return null;
        const parsed = JSON.parse(new TextDecoder().decode(contents));
        if (!parsed?.rates || !parsed?.base) return null;
        return parsed;
    } catch (e) {
        log(`clipboard-box: unreadable rate cache (${e.message})`);
        return null;
    }
}

function writeCache(table) {
    try {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipboard-box']);
        GLib.mkdir_with_parents(dir, 0o700);
        GLib.file_set_contents(cachePath(),
            new TextEncoder().encode(JSON.stringify(table, null, 2)));
    } catch (e) {
        log(`clipboard-box: could not cache rates (${e.message})`);
    }
}

function ageSeconds(table) {
    if (!table?.fetchedAt) return Infinity;
    const then = GLib.DateTime.new_from_iso8601(table.fetchedAt, null);
    if (!then) return Infinity;
    return GLib.DateTime.new_now_local().difference(then) / 1e6;
}

function session() {
    if (!_session) _session = new Soup.Session({ timeout: 15 });
    return _session;
}

function fetchRates(url, onDone) {
    if (_inFlight) return;
    _inFlight = true;
    _cancellable = new Gio.Cancellable();

    const message = Soup.Message.new('GET', url);
    if (!message) {
        _inFlight = false;
        onDone?.(new Error('Bad currency API URL'));
        return;
    }

    const finish = error => {
        _inFlight = false;
        _cancellable = null;
        onDone?.(error ?? null);
    };

    try {
        session().send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, _cancellable, (self, res) => {
                try {
                    const bytes = self.send_and_read_finish(res);
                    if (message.get_status() !== Soup.Status.OK)
                        throw new Error(`HTTP ${message.get_status()}`);

                    const body = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    // frankfurter: {base, rates}. open.er-api: {base_code, rates}.
                    const base = body.base ?? body.base_code;
                    if (!base || !body.rates) throw new Error('Unexpected response shape');

                    _table = {
                        base,
                        rates: body.rates,
                        fetchedAt: GLib.DateTime.new_now_local().format_iso8601(),
                    };
                    writeCache(_table);
                    finish(null);
                } catch (e) {
                    finish(e);
                }
            });
    } catch (e) {
        finish(e);
    }
}

// The base is quoted against itself and so is absent from `rates`.
function knowsCodes(table, { from, to }) {
    const all = { ...table.rates, [table.base]: 1 };
    return all[from] !== undefined && all[to] !== undefined;
}

// Returns the best table available right now — possibly stale, possibly null —
// and kicks off a refresh in the background if the setting is on and what we
// have is old. Never blocks.
//
// `onRefresh` fires only when a fetch actually produced new rates, so the caller
// can redraw the answer row.
//
// `codes` is the optional { from, to } the caller is about to convert. When we
// already hold a table that doesn't list them, the query only *looks* like a
// conversion ("5 tsp in tbs" parses identically to "5 usd in eur") and is not
// worth a request.
export function ratesFor(settings, onRefresh, codes = null) {
    if (!settings?.get_boolean('currency-enabled')) return null;

    if (!_loaded) {
        _loaded = true;
        _table = readCache();
    }

    if (codes && _table?.rates && !knowsCodes(_table, codes)) return _table;

    if (ageSeconds(_table) > MAX_AGE_SECONDS) {
        const url = settings.get_string('currency-api-url') || DEFAULT_URL;
        fetchRates(url, error => {
            if (error) {
                // Silent in the UI: a flaky network must not throw a
                // notification on every keystroke. The stale table is still
                // returned above, labelled with its age.
                log(`clipboard-box: rate refresh failed (${error.message})`);
                return;
            }
            onRefresh?.();
        });
    }

    return _table;
}

export function shutdown() {
    _cancellable?.cancel();
    _cancellable = null;
    if (_session) {
        _session.abort();
        _session = null;
    }
    _inFlight = false;
    // Keep _table/_loaded: they are just a cache, and re-reading the file on
    // every enable would be wasted work.
}
