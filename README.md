# clipboard-box

Tiny top-bar clipboard vault for **macOS**, with the original lightweight
**GNOME** screenshot extension still included.

On macOS, clipboard-box watches clipboard changes, captures screenshots directly
into its own app storage, stores each entry in a local plaintext history, then
clears the system pasteboard after the copy is saved. Text, images, screenshots,
and other pasteboard payloads are kept in the scrollable menu-bar popover.

```
macos/    Swift + SwiftUI MenuBarExtra app (macOS 13+)
linux/    GNOME Shell Extension, GJS / ESM (GNOME 45+), screenshots only
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

The GNOME extension is still the original screenshot picker. It does not yet
include the encrypted clipboard vault because GNOME Shell extensions do not have
native Keychain/CryptoKit equivalents; that would need a small native helper or
an explicit dependency on a system encryption tool.

Requires GNOME Shell 45 or later (Ubuntu 23.10+, Fedora 39+, current
Debian/Arch). No build step.

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

A camera icon appears in the top panel. Take a screenshot with `PrtScn`, click
the icon, click an entry, paste with `Ctrl+V`.
