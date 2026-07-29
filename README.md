# 📋 clipboard-box

**Your clipboard, boxed up.** A top-bar vault that remembers everything you copy
or screenshot — on macOS *and* GNOME.

![macOS 13+](https://img.shields.io/badge/macOS-13%2B-black)
![GNOME 45-49](https://img.shields.io/badge/GNOME-45--49-4A86CF)
![license MIT](https://img.shields.io/badge/license-MIT-green)

Your system clipboard remembers exactly one thing. clipboard-box keeps the last
few hundred, puts your recent screenshots next to them, and hands any of it back
with a click. On GNOME it also does the handful of things people actually open
Raycast for — snippets, a calculator, quicklinks, an emoji picker — from the
same search box.

No accounts and no sync. Nothing leaves your disk unless you switch on currency
conversion, which is off by default and is the only feature that touches the
network.

```
macos/    Swift + SwiftUI MenuBarExtra app   (macOS 13+, no Xcode project)
linux/    GNOME Shell extension, GJS / ESM   (GNOME 45–49, no build step)
```

## ✨ At a glance

The two platforms share a design, not a codebase. GNOME is the more complete
implementation today.

|                                        | macOS | GNOME |
| -------------------------------------- | :---: | :---: |
| Clipboard history (text + images)      |   ✅   |   ✅   |
| Screenshot capture (area / screen)     |   ✅   |   ✅   |
| Screen color picker (hex)              |   —   |   ✅   |
| Search · pin · delete                  |   —   |   ✅   |
| Pause (incognito)                      |   ✅   |   ✅   |
| Ranked command bar + keyboard nav      |   —   |   ✅   |
| Snippets with placeholders             |   —   |   ✅   |
| Calculator · units · dates             |   —   |   ✅   |
| Quicklinks + web search                |   —   |   ✅   |
| Emoji & symbol picker                  |   —   |   ✅   |
| Currency conversion (opt-in, network)  |   —   |   ✅   |
| Auto-expiry, size caps, settings UI    |   —   |   ✅   |
| Configurable shortcuts                 |   —   |   ✅   |
| Password-manager filtering             |   ✅   |   ✅   |
| Paste injection                        |   ✅   |   ✅   |
| Clipboard auto-clear                   |   ✅   |   —   |
| Encrypted at rest                      |   —   |   —   |

## ⚡ Quick start

**macOS** — needs the Xcode command-line tools (`xcode-select --install`). No
third-party dependencies.

```sh
cd macos
./build.sh
open build/ClipboardBox.app
```

**GNOME** — no build step, but the bundled GSettings schema must be compiled once
(and again whenever it changes).

```sh
glib-compile-schemas "linux/clipboard-box@dfxe.github.io/schemas/"
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD/linux/clipboard-box@dfxe.github.io" ~/.local/share/gnome-shell/extensions/
# X11: Alt+F2 → r → Enter.   Wayland: log out and back in.
gnome-extensions enable clipboard-box@dfxe.github.io
```

## 🍎 macOS

A vault icon appears in the menu bar. There's no Dock icon (`LSUIElement`). Copy
text or images as usual and they land in the popover; click a row to select it
for the next paste.

### Shortcuts

| Shortcut                | Does                                                      |
| ----------------------- | --------------------------------------------------------- |
| `⌘V`                    | Pastes the selected vault item (newest, if none selected)  |
| `⌃⌥S`                   | Capture an area into the vault                             |
| `⇧⌘3` / `⇧⌘4` / `⇧⌘5`   | Capture — **replaces** the native macOS screenshot UI      |

> ⚠️ **The native screenshot shortcuts are swallowed, not shared.** While
> ClipboardBox is running, `⇧⌘3`/`⇧⌘4`/`⇧⌘5` never reach macOS — including the
> `⇧⌘5` toolbar with its recording and timer options. Quit ClipboardBox to get
> them back.

None of these are configurable.

### How the paste override works

`⌘V` is intercepted globally. The app swallows your keystroke, places the
selected history item on the pasteboard just in time, synthesizes a fresh paste
into the target app, then wipes the pasteboard ~350 ms later if it still holds
that item. The practical effect: while ClipboardBox runs with permissions, the
system pasteboard sits empty and every paste is routed through the vault.

This needs **Accessibility** permission. On first launch, approve ClipboardBox
under **System Settings → Privacy & Security → Accessibility**. Without it the
app degrades gracefully — `⌘V` behaves normally and the pasteboard is left alone.

### Screenshots

Capture with `⌃⌥S`, the intercepted native shortcuts, or the **Area** / **Screen**
buttons in the popover. Shots are written straight into the app's own storage,
selected in the vault, and copied to the pasteboard. ClipboardBox never scans
Desktop, Documents, Downloads, Pictures, or the rest of `$HOME`.

### Launch on login

Drag `build/ClipboardBox.app` to `/Applications`, then add it under
**System Settings → General → Login Items**.

### Current limits

The macOS build is deliberately minimal — the popover has a Pause toggle, Area,
Screen, and Quit, and nothing else:

- No per-item delete, no "clear history", no pin, no search.
- History is capped at 200 entries; oldest are dropped. Not configurable.
- There is no image size cap, and images are stored base64-inline in
  `vault.json` rather than as sidecar files the way GNOME does — so a history
  full of Retina screenshots makes for a very large file.
- Anything on the pasteboard that isn't text or an image (RTF, app-specific
  flavors) still gets stored as a generic entry, unless it carries one of the
  privacy hints below.
- To wipe history, quit the app and delete the file:
  ```sh
  rm ~/Library/Application\ Support/clipboard-box/vault.json
  ```

## 🐧 GNOME

A clipboard icon appears in the top panel. Copy text or an image and it shows up
under **Clipboard history**; press `PrtScn` and it shows up under **Screenshots**.
Click any entry to copy it back — or just start typing.

### The command bar

The box at the top of the popup searches everything at once and ranks the
results, with each source under its own heading. It's focused the moment the
popup opens, so you can type immediately.

```
┌──────────────────────────────────────┐
│ 🔍 100 km in mi                      │
├──────────────────────────────────────┤
│ ANSWER                               │
│ 62.1371192237 mi        100 km  Enter│
├──────────────────────────────────────┤
│ CLIPBOARD HISTORY                    │
│ 📄 100 km in mi        Text · 11 B ·…│
└──────────────────────────────────────┘
```

| Key | Does |
| --- | --- |
| `↑` `↓` | Move through results, across section boundaries |
| `Page Up` / `Page Down` | Jump eight rows |
| `Enter` | Activate the selected row |
| `Esc` | Clears the query, then leaves a tool, then closes the popup |

Sections appear in a fixed order — **Answer**, **Quicklinks**, **Snippets**,
**Emoji & symbols**, **Clipboard history**, **Screenshots** — and each is capped
so no single source can flood the list. With a query, sections that match
nothing are hidden rather than each printing "No matches".

Ranking is shared by every source: an exact match beats a prefix, which beats a
match at a word boundary, which beats a substring, which beats a loose
subsequence (`bgcol` still finds `background-color`). Shorter matches win ties,
which is why typing `g` surfaces the `g` quicklink rather than some history
entry that happens to contain a *g*.

### Enter pastes

Activating a row copies it **and** sends `Ctrl+V` to the window that had focus,
so the content lands where you were working. Terminals get `Ctrl+Shift+V`,
matched on the window class.

If a paste ever lands somewhere unexpected, raise **Paste delay** in
preferences — the extension has to wait for focus to return to your window, and
120 ms isn't always enough on a loaded machine. Turn **Paste after copying**
off to go back to copy-only.

### Tools

- **Answer** — arithmetic (`2+2*8`, `2^10`, `sqrt(16)`, `max(3,9,2)`), unit
  conversion (`100 km in mi`, `72f to c`, `2.5 GiB in MB`), percentages
  (`20% of 300`, `300 + 20%`, `45 as % of 60`) and dates (`today + 30 days`,
  `days until 2026-12-25`). Answers are kept in history — you usually want the
  number again a minute later. There is no `eval()` anywhere in this: the
  expression parser is hand-written, because this code runs inside the
  compositor process.

- **Snippets** — saved blocks of text, searched by keyword, label or body. The
  body can contain `{date}`, `{time}`, `{clipboard}`, `{uuid}` and `{cursor}`;
  `{date:%d %b %Y}` takes any `strftime` format. Every text row in history has a
  **Save as snippet** button, which is how most snippets actually get made.

  `{cursor}` walks the caret back after pasting by sending arrow keys. It works
  in a plain text field; an editor that autocompletes or reindents after the
  paste will land it somewhere else. It needs pasting turned on, and is ignored
  beyond 200 characters.

- **Quicklinks** — type a keyword and your search: `gh clipboard box` opens a
  GitHub search. Typing `github` finds it by name instead. Google, DuckDuckGo,
  GitHub, YouTube, Wikipedia, Stack Overflow, npm, MDN and Translate are set up
  on first run; delete them and they stay deleted. When nothing else matches you
  get a **Search the web for…** row.

- **Emoji & symbols** — searchable from two characters up, ordered with
  recently-used first. Alongside emoji it carries arrows, maths, typography,
  Greek, currency and the invisible characters that are otherwise a nuisance to
  produce (non-breaking space, zero-width space, em space).

  No emoji data is bundled: GNOME Shell already ships a set for its on-screen
  keyboard and this reads that, so there's nothing to download and it matches
  whatever Unicode version your Shell targets. Unicode names make poor search
  keys, so common nicknames (`lol`, `shrug`, `+1`, `tada`, `lgtm`) are mapped on
  top.

- **Currency** — `100 usd in eur`, **off by default**. See
  [Currency and the network](#currency-and-the-network).

### The rest

- **History** — watches the compositor's selection-owner signal and records
  copied text and PNGs, deduplicated by content, newest first (200 by default).
  Every row has **pin** (sticks to the top, exempt from the cap and from expiry)
  and **delete**. Copying something again promotes it back to the top.
- **Search** — the box at the top filters history *and* screenshots as you type.
  The popup focuses it on open, so you can just start typing.
- **Pause** — an incognito toggle that stops recording without disabling the
  extension. Content flagged by a password manager is skipped even when running.
- **Screenshots** — lists the 10 newest PNGs in `~/Pictures/Screenshots` (where
  GNOME's `PrtScn` saves), each one click-to-copy.
- **Capture** — **Area** and **Screen** go through GNOME's own screenshot
  service, then add the shot to history and copy it to the clipboard.
- **Color** — an eyedropper. The popup closes, the cursor becomes a crosshair,
  and a readout follows the pointer showing a swatch and the live `#RRGGBB`
  under it. Click to copy that hex and store it in history; `Esc` or a
  right-click cancels. Hex entries show up in the list as a colour swatch.
- **Quit** — turns the extension off from the popup: panel icon gone, monitoring
  stopped, shortcuts released. It stays off across a reboot; bring it back with
  `gnome-extensions enable clipboard-box@dfxe.github.io` or the Extensions app.

### Pasting into terminal apps

Clicking a row puts real PNG bytes on the clipboard as `image/png`, which GUI
apps (GIMP, browsers, chat clients) paste directly. Terminal programs can't read
an X11/Wayland selection themselves — they shell out to a helper binary — so for
`Ctrl+V` image paste inside a terminal you need one of:

```sh
sudo apt install xclip          # X11
sudo apt install wl-clipboard   # Wayland
```

If neither is installed, the extension says so once in a notification. Without
one, clicking an image row *looks* like it worked but pasting into a terminal
does nothing.

Every image and screenshot row also has a **link** button that copies the file's
*path* as plain text instead of its bytes. That needs no helper binary and works
over SSH — Claude Code turns a pasted path ending in `.png`/`.jpg`/`.gif`/`.webp`
into a real image attachment. Path copies aren't added to history.

### Preferences

```sh
gnome-extensions prefs clipboard-box@dfxe.github.io
```

Four pages: **General**, **Tools**, **Snippets** and **Quicklinks**. The last two
are list editors — a `+` in the group header adds an entry, each row expands to
its fields, and edits reach the popup immediately without a shell restart.

| Setting                     | Default                  | Effect                                             |
| --------------------------- | ------------------------ | -------------------------------------------------- |
| Maximum entries             | 200                      | Oldest unpinned dropped first                       |
| Auto-expire after (days)    | 0 — never                | Unpinned entries only                               |
| Store copied images         | on                       | Off = text only; Area/Screen captures still stored  |
| Max copied-image size       | 10 MB                    | 0 = unlimited; captures are exempt                  |
| Screenshots folder          | `~/Pictures/Screenshots` | Watched *and* captured into                         |
| Pause monitoring            | off                      | Incognito                                           |
| Encrypt history at rest     | off                      | **Not implemented** — inert placeholder             |
| Paste after copying         | **on**                   | Sends `Ctrl+V` to the focused window                |
| Use Ctrl+Shift+V in terminals | on                     | Matched on window class                             |
| Paste delay                 | 120 ms                   | Raise if pastes land in the wrong place             |
| Fallback search URL         | DuckDuckGo               | Used by the "Search the web for…" result            |
| Convert currencies          | **off**                  | The only setting that enables a network request     |
| Exchange rate endpoint      | frankfurter.app          | ECB daily rates, no API key                         |

Shortcuts — all unbound by default, all taking a raw accelerator string such as
`<Super><Shift>V` rather than a key-capture widget. Leave one blank to disable:
**Open clipboard menu**, **Capture area**, **Capture screen**, **Pick color**,
**Open snippets**, **Open emoji picker**.

The last two open the popup scoped to that one tool, listing everything it has
before you type anything — recently-used emoji, or your snippets most-used
first. `Esc` steps back out to the full command bar.

### Currency and the network

Currency conversion is the only feature that makes a network request, and it is
**off by default**. With it off, `100 usd in eur` simply produces no answer row
and nothing is ever fetched.

With it on:

- Rates come from `api.frankfurter.app` (European Central Bank daily reference
  rates — no API key, no signup, no account). The endpoint is configurable.
- A fetch happens only when you actually type a currency conversion, and at most
  once every 12 hours. There is no background timer and nothing is fetched at
  startup.
- Results are cached in `~/.local/share/clipboard-box/rates.json`. Offline, you
  get the cached rates with their age shown in the row (`rates from 3d ago`)
  rather than a wrong number or a silent failure.
- Only the currency codes are implied by the request — no clipboard content, no
  identifiers, nothing about you.

## 🔒 Storage & privacy

Everything is local. Nothing is uploaded anywhere, and the only outbound request
the extension can ever make is the opt-in exchange-rate fetch described above.

|                     | macOS                                                       | GNOME                                        |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| History             | `~/Library/Application Support/clipboard-box/vault.json`     | `~/.local/share/clipboard-box/vault.json`     |
| Images              | inline, base64 in `vault.json`                               | `~/.local/share/clipboard-box/images/*.png`   |
| Screenshots         | `~/Library/Application Support/clipboard-box/synced-screenshots/` | `~/Pictures/Screenshots/`               |
| Snippets, quicklinks | —                                                          | GSettings (`dconf`), as JSON strings          |
| Cached rates        | —                                                            | `~/.local/share/clipboard-box/rates.json`     |
| File perms          | `0600`                                                       | `0600` / `0700`                               |

Snippets live in GSettings rather than in a file because the preferences window
is a separate process from the Shell — GSettings is what lets an edit show up in
the popup straight away. Note that `dconf` is **not** `0600`-protected the way
`vault.json` is, so treat a snippet as no more private than any other desktop
setting.

**Neither platform encrypts at rest.** History is plain JSON on disk.

On macOS, `VaultCrypto.swift` contains a complete scheme — Curve25519 ECDH →
HKDF-SHA256 → AES-GCM, with keys in the Keychain — but **nothing calls it yet**.
It's scaffolding for a future release, not active protection; don't let its
presence in the source tree mislead you. The popover says "Local plaintext
history" for exactly this reason. GNOME has the matching inert **Encrypt history
at rest** toggle in preferences; GNOME Shell extensions have no native CryptoKit
equivalent, so a libsecret-backed implementation is future work.

Until then: don't copy secrets you wouldn't want written to disk. Both platforms
skip content a password manager has flagged, and both give you a pause toggle
for anything else sensitive. macOS still vacuums up unrecognised pasteboard
flavors, so it captures more than GNOME does.

The flags honoured are `org.nspasteboard.TransientType`,
`org.nspasteboard.ConcealedType`, `org.nspasteboard.AutoGeneratedType` and
`com.agilebits.onepassword` on macOS, and the `passwordmanagerhint`,
`x-kde-passwordmanagerhint`, `org.freedesktop.secrets` and `concealed` MIME
hints on GNOME. An app that sets none of them is indistinguishable from any
other app, on either platform.

**If the history file is ever unreadable it is moved aside, never overwritten.**
A vault that fails to parse is renamed to `vault.corrupt-<timestamp>.json` and
the app starts empty; if even that rename fails, nothing is saved for the rest
of the session rather than writing over what could not be read.

## 🛠 Development

### Tests

```sh
linux/tests/run.sh          # unit tests
linux/tests/parse-check.sh  # syntax-check every module
```

No dependencies and no build step: the tested modules import nothing from
`resource:///`, so they load in plain `gjs` with no Shell and no display.
`run.sh` points `XDG_DATA_HOME` at a throwaway directory before starting gjs —
GLib caches the data dir on first use, so this cannot be done from inside the
test process, and `vaultStore.test.js` refuses to run without it.

That covers `match`, `calc`, `units`, `format`, `configStore`, `searchRegistry`
and `vaultStore`. Everything else imports `St`/`Clutter`/`PanelMenu` and can only
be exercised in a real shell — `parse-check.sh` gives those at least a syntax
check, which is the mistake that otherwise costs a shell restart to find.

The `match.js` tests are worth keeping honest: they pin the exact tier ordering,
so a change to the scorer that quietly reorders results fails rather than merely
looking different.

```
macos/build.sh                    swiftc → ad-hoc-signed .app bundle in build/
macos/ClipboardBox/*.swift        app, vault store, event tap, popover
linux/clipboard-box@dfxe.github.io/
  extension.js                    panel indicator, command bar, keyboard nav
  searchRegistry.js               provider interface, per-source caps
  match.js                        shared ranking (exact ▸ prefix ▸ word ▸ …)
  historyProvider.js              clipboard history + screenshots as providers
  answerProvider.js               the Answer section
  snippetProvider.js              snippet search + placeholder expansion
  quicklinkProvider.js            keyword links + web-search fallback
  emojiProvider.js                emoji/symbol search over the Shell's dataset
  calc.js                         expression parser, percentages, dates
  units.js                        unit tables + conversion
  currency.js                     opt-in async rate fetch + disk cache
  paste.js                        Ctrl+V injection via a virtual keyboard
  configStore.js                  snippets/quicklinks in GSettings (shared with prefs)
  clipboardUtil.js                the single clipboard-write path
  format.js                       byte/age formatting, hex sniffing
  clipboardMonitor.js             selection-owner watcher, secret filtering
  vaultStore.js                   persistence, dedup, pinning, expiry
  screenshotStore.js              screenshots folder watcher
  capture.js                      org.gnome.Shell.Screenshot D-Bus client
  colorPicker.js                  full-stage eyedropper overlay + hex readout
  prefs.js                        Adwaita preferences window
linux/tests/                      gjs unit tests + the two runner scripts
```

Every clipboard write goes through `clipboardUtil.ingestText()`, which keeps one
invariant in one place: store to the vault first so it owns the fingerprint,
tell the monitor to ignore that fingerprint, *then* write. Get the order wrong
and the extension's own writes come straight back in as new history entries.

Three more invariants that are easy to break by accident:

- **The monitor's ignore set is consuming.** `_ignored` swallows exactly one
  bounce of our own write, then forgets it. Peeking with `.has()` instead of
  `.delete()` means that once you copy something from the popup, copying the
  same text by hand later is silently dropped from history.
- **Nothing runs on the compositor thread that doesn't have to.** GJS extensions
  live *inside* `gnome-shell`, so per-keystroke work is frame budget. Providers
  score against pre-normalized text via `match.scorePre` rather than `score`,
  and the vault's writes are coalesced and asynchronous — which is why
  `disable()` has to call `vault.flush()`.
- **Rebuilds are suspended while a row is activating.** `run()` usually mutates a
  store, and `changed` lands synchronously; without `_suspendRefresh()` the
  rebuild destroys the very row that is about to show its ✓ confirmation.

Providers are pure and synchronous, so anything expensive they might want —
notably an exchange-rate lookup — has to be deferred rather than done inline.
`calc.evaluate` accepts a *function* for `rates` and calls it only once a query
has parsed as a currency conversion; that is what keeps the opt-in network fetch
from firing merely because the popup opened.

Adding a tool means writing a provider — `{id, title, cap, search(query, ctx)}`
returning result descriptors — and appending it to `PROVIDERS` in
`extension.js`. Providers are pure, synchronous, and never touch `St`: visuals
are plain data (`{kind: 'icon'|'gicon'|'swatch'|'glyph', …}`) that
`_makeResultRow` turns into actors.

`build.sh` compiles every `.swift` in one `swiftc` invocation and ad-hoc-signs the
bundle so Gatekeeper allows it locally. Note that re-signing invalidates the
Accessibility grant, so you'll re-approve after each rebuild.

Extension JS changes need a **full gnome-shell restart**, not a
disable/enable — the ESM modules stay loaded across the latter. On X11 that's
`Alt+F2` → `r` → Enter; on Wayland, log out and back in, or use a nested Shell:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

Enable it inside that session and watch logs with:

```sh
journalctl -f -o cat | grep -i clipboard
```

Any change under `schemas/` needs `glib-compile-schemas schemas/` before that
restart, or the new keys read as missing and `enable()` throws.

Because the modules survive disable/enable, anything holding a resource has to
be cleared from the top of **both** `enable()` and `disable()` —
`ColorPicker.cancelActive()`, `Paste.shutdown()`, `Currency.shutdown()`. A modal
grab that outlives the extension leaves the session unable to click anything,
and `ExtensionManager` only *logs* a throw from `disable()`.

## License

MIT — see [LICENSE](LICENSE).
