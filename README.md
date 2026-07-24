# clipboard-box

Top-bar clipboard vault for both **macOS** and **GNOME**.

On macOS, clipboard-box watches clipboard changes, captures screenshots directly
into its own app storage, stores each entry in a local plaintext history, then
clears the system pasteboard after the copy is saved. Text, images, screenshots,
and other pasteboard payloads are kept in the scrollable menu-bar popover.

On GNOME, a top-bar indicator keeps a persistent history of the text and images
you copy, lists your recent screenshots, and can capture a new Area/Screen
screenshot on the spot. Click any entry to copy it back, then paste with
`Ctrl+V`.

```
macos/    Swift + SwiftUI MenuBarExtra app (macOS 13+)
linux/    GNOME Shell Extension, GJS / ESM (GNOME 45+)
```

## macOS

Requires macOS 13 Ventura or later and the Xcode command-line tools
(`xcode-select --install`). No third-party deps, no Xcode project.

```sh
cd macos
./build.sh
open build/ClipboardBox.app
```

A vault icon appears in the menu bar; the app has no Dock icon
(`LSUIElement = true`). Copy text or images as usual, or capture an area with
`⌃⌥S` while ClipboardBox is running. The app writes the screenshot directly into
its own storage, selects it in the vault, and clears the normal pasteboard
shortly after capture. The native `⇧⌘3`, `⇧⌘4`, and `⇧⌘5` shortcuts are also
intercepted, and you can use the Area and Screen buttons in the popover to
capture directly through the app.

Screenshot files live under
`~/Library/Application Support/clipboard-box/synced-screenshots`. ClipboardBox
does not scan Desktop, Documents, Downloads, Pictures, or the rest of `$HOME` for
screenshots.

`⌘V` is globally intercepted while clipboard-box is running. The app places the
selected history item onto the pasteboard just in time, sends the paste
keystroke to the target app, then clears the pasteboard again if it still
contains that item. Clicking a row in the menu selects that item for the next
`⌘V`; otherwise the newest item is pasted.

macOS requires Accessibility permission for global `⌘V` interception. On first
launch, approve clipboard-box in **System Settings -> Privacy & Security ->
Accessibility**.

To launch on login, drag `build/ClipboardBox.app` to `/Applications`, then add
it under **System Settings -> General -> Login Items**.

Screenshot capture uses macOS `screencapture` with an explicit destination in
ClipboardBox's Application Support folder.

## Linux (GNOME)

The GNOME extension is a clipboard vault: a top-panel indicator that keeps a
persistent history of the text and images you copy, lists your recent
screenshots, and can capture a new screenshot from the popup.

- **Clipboard history** — the extension watches for clipboard changes (via the
  compositor's selection-owner signal) and records copied text and PNG images,
  deduplicated by content, newest first (up to 200 entries by default). Click a
  row to copy that item back onto the clipboard, then paste with `Ctrl+V`. Each
  row has **pin** (keep it at the top, exempt from the history cap and expiry)
  and **delete** buttons. Content flagged by a password manager is ignored and
  never stored.
- **Search** — the box at the top of the popup filters the history and
  screenshots as you type; the popup focuses it on open, so you can just start
  typing.
- **Pause** — the **Pause monitoring** toggle stops recording new clipboard
  content (an incognito mode) without disabling the extension.
- **Screenshots** — the popup lists the newest PNGs in `~/Pictures/Screenshots`
  (where GNOME's `PrtScn` saves), each one click-to-copy.
- **Capture** — the **Area** and **Screen** buttons capture through GNOME's own
  screenshot service into `~/Pictures/Screenshots`, then add the shot to the
  history and copy it to the clipboard.

### Pasting into terminal apps

Clicking a row puts the real PNG bytes on the clipboard as `image/png`, which GUI
apps (GIMP, browsers, chat clients) paste directly. Terminal programs can't read an
X11/Wayland selection themselves — they shell out to a helper binary — so for
`Ctrl+V` image paste inside a terminal (Claude Code, editors) you need:

```sh
sudo apt install xclip          # X11
sudo apt install wl-clipboard   # Wayland
```

If neither is installed, the extension says so once in a notification; without one,
clicking an image row appears to work but pasting into a terminal does nothing.

Every image and screenshot row also has a **link** button that copies the file's
*path* as plain text instead of its bytes. That needs no helper binary at all and
works over SSH — Claude Code turns a pasted path ending in `.png`/`.jpg`/`.gif`/
`.webp` into a real image attachment. Path copies are not added to the history.

### Preferences

Open settings with `gnome-extensions prefs clipboard-box@dfxe.github.io` (or via
the Extensions app). You can configure:

- **Maximum entries** and **auto-expire after (days)** — bound the history by
  count and age; pinned entries survive both.
- **Store copied images** and **max copied-image size** — control what passive
  clipboard images get stored. Explicit Area/Screen captures are always kept.
- **Screenshots folder** — where captures are saved and which folder is watched
  (blank = `~/Pictures/Screenshots`).
- **Pause monitoring**.
- **Keyboard shortcuts** — open the menu, capture area, capture screen. Type an
  accelerator such as `<Super><Shift>V`; leave a field blank to disable it. No
  shortcuts are bound by default.

History is stored as plaintext under `~/.local/share/clipboard-box/`
(`vault.json` plus `images/`), written owner-only (`0600`/`0700`). Like the
current macOS build, it is **not encrypted** — GNOME Shell extensions have no
native Keychain/CryptoKit equivalent, so at-rest encryption via libsecret/GNOME
Keyring is left as future work (there is an inert **Encrypt history at rest**
toggle in preferences reserved for it). Don't copy secrets you wouldn't want
written to disk (password-manager content is already skipped, and you can flip
on **Pause monitoring** before copying something sensitive).

Requires GNOME Shell 45 or later (Ubuntu 23.10+, Fedora 39+, current
Debian/Arch). No build step, but the bundled GSettings schema must be compiled
once (and again whenever it changes):

```sh
glib-compile-schemas "linux/clipboard-box@dfxe.github.io/schemas/"
```

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD/linux/clipboard-box@dfxe.github.io" \
      ~/.local/share/gnome-shell/extensions/
```

Then reload Shell:

- **X11:** `Alt+F2` -> type `r` -> Enter.
- **Wayland:** log out and back in (Shell can't hot-reload extensions on
  Wayland).

Enable it:

```sh
gnome-extensions enable clipboard-box@dfxe.github.io
```

A clipboard icon appears in the top panel. Copy text or an image and it shows up
under **Clipboard history**; click any entry to copy it back. Use **Area** /
**Screen** to grab a screenshot, or press `PrtScn` and it appears under
**Screenshots**.

### Testing without logging out

On Wayland you can try the extension in a nested Shell instead of re-logging:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

Enable it inside that session and watch logs with
`journalctl -f -o cat | grep -i clipboard`.
