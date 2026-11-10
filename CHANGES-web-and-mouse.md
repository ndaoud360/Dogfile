# Web pane + mouse gestures & command wheel

Unzip over your repo (paths are relative to the repo root). Built on top of the current GitHub `main`.

## Web pane (Dogfile Web)
- Open it from: the pane/layout picker ("Web pane"), View > Panes > Web pane, Tools > Apps > Web browser, or the command palette.
  It opens a browser in the other pane and keeps your folder where it is.
- A plain browser: browser tabs, address bar (types a search if it isn't an address), start page with your URL buttons.
  Video works, links that want a new window open as a new tab, downloads go to your Downloads folder (a program/script
  download is flagged), dragging files from the other pane onto a page works (YouTube upload, Photopea, GitHub...).
- Private: every page lives in a private web view (no history, cookies, passwords, cache survive). Closing the tab
  closes all its pages and shows "Dogfile Web closed. Nothing was saved...". A note in the tab says the same.
- Light on memory: a tab's page is only created when the tab is shown; tabs you leave go to sleep (page closed, address
  kept) after 5 min (Settings > Web pane), the whole browser sleeps when its pane is hidden, background pages use the
  low-memory mode. Nothing runs in the background after you close the tab.
- Safe: pages get no access to Dogfile (the app's own address scheme refuses them, they have no app permissions),
  only http/https is opened (never file:, dogfile:, javascript:, data: ...), no user@host tricks, this PC and your home
  network (localhost, 127.x, 10.x, 192.168.x, 169.254.x ... in every spelling) are blocked unless you switch that on.
  Rules live in backend/src/webguard.rs with tests. Pop-ups become tabs, nothing else opens a window.
- URL buttons: ribbon "URL" (Tools > Apps; also in the Photos and PSD tab ribbons). Click it and a site opens beside
  the current tab (Photopea beside a picture or PSD...). Make as many as you like in Settings > Web pane (or
  "Edit URL buttons..."), each shown for: everywhere, folders, pictures, Photoshop files, videos, music, documents.
- New Rust: app/src/web.rs (needs Tauri's `unstable` feature, added in app/Cargo.toml), Host::web + web:do / web:check.

## Mouse gestures, mouse buttons, command wheel (Settings > Mouse & wheel)
- Trigger = a key you hold and/or a mouse button (any key, left/middle/right/back/forward; the left button needs a key).
- Gestures: hold the trigger and draw: ← → ↑ ↓, two or three strokes in a row, or shake. Each runs any command from the
  palette. "Start with suggestions" fills a useful set. A trail and a label show while you draw.
- Mouse buttons: an extra button (thumb button of your MX Master 4...) runs any command. If Logi Options+ can send a
  key (F13-F24) instead, hold that key as a trigger.
- Wheel: six commands you pick, opens at the pointer with an animation when you hold its trigger, let go over one (or
  click it, or press 1-6). Closes with an animation. "Try the wheel" previews it.
- Nothing listens until you set something up. Works over the file panes and tab strip (not inside Notepad/Photos tabs,
  and not over a web page, which is a separate native view).
