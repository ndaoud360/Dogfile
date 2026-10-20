# Dogfile — source

Electron app (no build step, no runtime dependencies).

```
npm install            # installs Electron for development
npm start              # run from source
node build/package-win.mjs electron-vXX-win32-x64.zip   # make the portable Windows folder (needs: npm i -D resedit pe-library)
```

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
