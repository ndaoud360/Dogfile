# Dogfile — source

Dogfile 2 is a Tauri app: the interface (`src/renderer/`, plain ES modules, no build step) runs in the system web
view (WebView2 on Windows), and everything else is Rust in the same process.

```
cargo run -p dogfile                    # the app (Linux needs webkit2gtk-4.1; Windows needs WebView2)
cargo run -p dogfile-dev                # the interface in any browser at http://127.0.0.1:47800/app/index.html
cargo test -p dogfile-core              # engine tests
node build/package-win.mjs Dogfile.exe ffmpeg-win64-shared.zip   # portable Windows folder (+ zip it)
```
Windows builds come from GitHub Actions (`.github/workflows/app.yml`): it builds `Dogfile.exe`, starts it on the
runner to check it draws, runs Windows checks inside the app (`build/ci/wintest.js`), measures memory next to
Dogfile 1.6, and publishes the exe on the `app-bin` branch.

Crates
- `core/` — the engine: instant index (in-memory tree, NTFS file-table reader, watcher, sleeps when idle),
  parallel folder walker, search, folder sizes, duplicates, storage inventory, checksums.
- `backend/` — every call the interface makes (`dispatch.rs` routes them by name): files, the copy queue
  (`ops.rs`), archives, media (ffmpeg), documents, tags, versions, remote (SFTP/FTP/WebDAV), terminal,
  Windows shell (`win/`: drives, Recycle Bin, thumbnails, icons, shell verbs, clipboard, MTP, registry).
- `app/` — the Tauri shell: frameless windows, events, dialogs, drag in/out, tray, single instance.
- `devserver/` — the same back end over HTTP, for development and automated tests.

The Electron version's main process is still in `src/main/` for reference (not used by the app).

Layout
- `src/main/` — main process: window, `atlas://` protocol (thumbnails/previews with range requests), IPC,
  `ops.js` (queued copy/move/delete/extract/compress with pause, cancel, conflicts, undo records),
  `worker.js` (search, folder sizes, duplicates), `winshell.js` (PowerShell host, drives, Recycle Bin,
  shell verbs, clipboard file lists, default-file-manager registry keys).
- `src/renderer/` — UI: `pane.js` (tabs, 1–4 panes, virtualized Grid/Details/List/Columns views, selection,
  drag & drop, inline rename), `actions.js`, `commands.js` (every command + remappable shortcuts + palette),
  `tools.js` (search, compare/sync, duplicates, disk usage, workspaces, operations center), `preview.js`,
  `sidebar.js`, `settings.js`, `styles.css`.

1.5 modules
- `organize.js` (topic grouping engine for Tidy up / automations / assistant), `rules.js` (folder automations),
  `collections.js` (smart collections), `cleanup.js` (storage cleanup center; worker job `inventory`),
  `gallery.js` + `mediameta.js` (gallery view, media filter, contact sheets, similar media; main `imgmeta.js`),
  `history.js` (file history, versions via main `versions.js`, checksums via worker job `hashfiles`),
  `assistant.js` + `assistant-parse.js` (local file assistant; main `doctext.js` reads Office/PDF text),
  `docpreview.js` (Office previews, file notes, preview panel options), `workspaces.js` (workspaces 2.0 + profiles),
  `network.js` + main `remote.js` (saved SFTP/FTP/SMB/WebDAV connections; `src/main/vendor/remote-libs.js` is
  ssh2 + basic-ftp bundled with esbuild from `build/vendor-src/remote.js`), `renamestudio.js`, `smartdrop.js`,
  `cliphistory.js`, `assoc.js` (file types), `a11y.js`, `macros.js`, `extensions.js` + `ext-worker.js` (sandboxed
  features; the worker is served with a CSP that blocks network and script loading), `features.js`,
  `featurestore.js` (GitHub-backed feature browser; requests go through main `gh:request`).

1.5.1
- Making features: `FEATURES.md` is the guide (also shipped in `src/renderer/assets/` and opened from File > Help).
  It is generated from `featureapi.js` (the API description) and `featureexamples.js` (the examples) by
  `node build/make-feature-docs.mjs`; run it after changing either. `featureref.js` is the Notepad help panel
  (F1): reference, autocomplete, hover help, Check tab and the feature log (main `ext:log`).
- `build/vendor-src/cm.js` also exports `hoverTooltip`, `showPanel`, `snippetCompletion`, `startCompletion`;
  rebuild with `npx esbuild build/vendor-src/cm.js --bundle --format=esm --minify --outfile=src/renderer/vendor/cm.js`.
- Ribbon tabs are Home / Organize / Tools / View (`R` in `app.js`); groups fold into a menu when the window is narrow.
