DOGFILE: a power-user file manager for Windows 10/11
==========================================================

RUN IT
  * Portable: just double-click Dogfile.exe (put an empty file named
    portable.txt next to it to keep settings in a "data" folder beside it).
  * Install:  double-click "Install Dogfile.cmd". It installs per-user (no
    admin), adds a Start-menu entry and asks if Dogfile should replace File
    Explorer as the default (folders, Win+E, "Open folder" buttons).
  * Default can also be toggled any time: File > Settings > General.
  * Uninstall: Settings > Apps, or "Uninstall Dogfile.cmd". Uninstalling
    always restores Windows File Explorer as the default.

NEW TO DOGFILE?
  The first time it opens, Dogfile asks whether you want Simple or Full menus.
  Simple keeps the ribbon and right-click menus short; everything else waits
  under "More options" and in the command palette (Ctrl+Shift+P). Switch any
  time in Settings > General > Interface. File > Welcome tour shows it again,
  and Settings has a search box.

FIRST THINGS TO TRY
  Ctrl+Shift+P   command palette (every action, searchable)
  Ctrl+T / W     new / close tab        Ctrl+Shift+T   reopen closed tab
  Ctrl+Alt+1..5  1, 2, 2 stacked, 3 or 4 panes   F3  toggle dual pane
  Tab            jump between panes     F5 / F6        copy / move to other pane
  Space          Quick Look             Alt+P          preview pane
  Ctrl+F         filter this folder     Ctrl+E         search (regex, content…)
  F2             rename (Tab = next)    Ctrl+Shift+R   batch rename
  Ctrl+Z / Y     undo / redo            Alt+1..7       color tags
  Ctrl+`         terminal here          Ctrl+L         type a path
  F1             all shortcuts (remappable in Settings)

BUILT-IN APPS
  Dogfile Notepad  Notepad++-style editor for every text/code file: tabs, 55+
                 languages, find/replace (regex), multi-cursor + Alt-drag column
                 select, bookmarks (Ctrl+F2/F2), encodings (UTF-8/BOM, UTF-16,
                 ANSI), CRLF/LF, Markdown/HTML preview, unsaved-tab backup.
  Dogfile Player   VLC-style player: MKV/MP4/AVI/WebM/MPEG/WMV, 4K HEVC/AV1/VP9 on
                 the GPU, AC3/DTS/TrueHD/FLAC/WMA/APE audio, subtitles (embedded
                 + .srt/.ass), audio/sub tracks, 10-band EQ, 200% volume,
                 A-B repeat, frame step, screenshots, resume, playlists.
                 New: Edit button (Ctrl+K) to trim, remove or extract audio and
                 convert, then save a copy or overwrite. Songs show BPM, key
                 (with Camelot code) and loudness.
  Dogfile Photos   Photo viewer with a queue, slideshow (shuffle, 2-30 s), full
                 screen, zoom/pan, EXIF info, and an editor: adjustments, filter
                 presets, crop (aspect presets), rotate/flip, draw, highlighter,
                 text, resize. Save as a copy or overwrite the original.
  All three open automatically (toggle in Settings > General) and are in every
  right-click menu. Select many files and "Open all in ..." puts them in a queue.
  Settings > General > "Open built-in apps as tabs" keeps them inside the main
  window instead of their own windows. Settings > General can also add them to
  the Windows right-click menu.

NEW IN 2.0.1: AUTOMATIC UPDATES
  Dogfile checks for a new version a few seconds after it starts and every
  few hours. When one is out you'll see "New update available" (Later asks
  again in 24 hours); Update shows what's new and installs it in about a
  minute, then Dogfile restarts. File > Updates is red while an update is
  waiting and green when you're up to date. Turn checking off in Settings >
  Behavior. The sidebar's Collections section is now off by default (Settings
  > Behavior > Sidebar sections).

NEW IN 2.0: REBUILT ON TAURI + RUST
  Dogfile no longer carries its own copy of Chrome and Node.js. The window is
  drawn by Windows' built-in WebView2 (the Edge engine) and everything else -
  folders, copying, search, archives, media, documents, tags, the terminal - is
  native Rust inside Dogfile.exe. About a third less memory than 1.6, half
  the download, big folders list several times faster, and no PowerShell
  helpers running in the background.
  Instant search index: built at low priority, refreshed only when it is more
  than 6 hours old, and it lets go of its memory after 90 seconds without a
  search (it wakes in a blink on the next one). Windows and program folders are
  left out by default (Settings > Tools & apps > Search to include them).
  Your settings, tags, workspaces and features carry over from 1.6.
  Needs Microsoft Edge WebView2 Runtime (already part of Windows 11 and of an
  up-to-date Windows 10; the installer checks).

MORE NEW STUFF
  Ctrl+B / top-left menu button   folding sidebar animation
  Ctrl+`        built-in terminal (synced with the folder you're in)
  Ctrl+Shift+J  Drop Shelf - collect files from many folders, drop them all
  Ctrl+P        jump to any file below the current folder
  Ctrl+Alt+B    flatten a folder (every file in every subfolder)
  Settings > Colors   recolor any part of the UI, save your own presets,
                      export them to Downloads and import them back
  Settings > Appearance > Rounded corners   one roundness slider plus which
                      parts get rounded (tabs, window, menus, dialogs...)
  Phones & cameras (MTP) appear under This PC; drives are detected on plug-in.
  Network shows computers, TVs, speakers, media servers and routers it finds.

ZIP MANAGER
  Right-click > Add to zip, or Archive > Add to archive / Add to existing.
  Open an archive like a folder: drag files in (or paste) to add them, Delete
  removes, F2 renames, and a Zip tab appears next to View with extract, add,
  convert (zip, 7z, tar.gz, RAR*) and test. Dropping files onto a zip adds them.
  * Creating RAR files needs WinRAR installed (RAR is a closed format).

CONTEXT TABS
  A tab appears next to View for whatever you are doing: Zip inside archives,
  Audio for songs (BPM & key, convert, normalize), Video, Pictures (convert,
  resize, set as background), and Editor for a photo or video open in a tab.

DROP SHELF
  Click Actions (or right-click a chip) to do anything with the files: open all
  in Notepad / Player / Photos, zip, copy / move, rename, tag, convert, delete.
  Ctrl+click chips to act on just some of them.

AI SEARCH (free, private)
  Type a description in Search (Ctrl+E): "photos of a dog running on grass",
  "videos of people at the beach", "songs with piano", "photos taken at sunset",
  "find the video where I'm riding a bicycle". Sentences like these switch to
  AI automatically (the AI chip in the search box can force it on or off).
  The first time, Dogfile downloads two open models once (about 330 MB): CLIP
  for pictures and video frames, CLAP for music and sounds. Everything runs on
  this PC; nothing about your files is uploaded. Each file is analyzed once and
  remembered, so later searches are fast. Settings > Tools & apps > AI search.

MUSIC TAG EDITOR
  Right-click songs > Edit tags (or the Audio tab). Edit title, artist, album,
  year, track, genre, BPM, key and more for one song or many at once, and set,
  paste or remove cover art (MP3, FLAC, M4A; WAV/OGG have no cover support).
  Auto: "Find by name" looks the song up on iTunes and MusicBrainz (free) and
  fills everything in, cover included. "Identify by sound" recognizes the song
  from its audio with AcoustID (add your free key in Settings > Tools & apps).
  "Fill BPM & key" writes the detected tempo and key into the tags.

MORE IN 1.4
  Photos: press T (or the text button) to read the text in a picture or
          screenshot, select words right on the photo, copy all or save .txt.
  Player: Alt+T makes a transcript of speech (free Whisper model, runs
          on this PC): click a line to jump there, search it, show it as
          subtitles or save an .srt file.
  Tidy up: right-click empty space > Tidy up this folder. Groups files by
          topic ("invoice", "wedding") then by kind, shows the new folders
          first, and every move can be undone. Optional AI grouping.
  Rename by describing it: in Batch rename, type "format as
          YYYY-MM-DD_Invoice_### and lowercase everything" and watch the
          preview.
  Drag a tab to the left, right or bottom of the window to split the view.
  Archives: files opened from inside a zip are packed back in when you save.
  Compare two files side by side: select two files > right-click > Compare.
  Git: click the branch name in the status bar to switch branches or see
          recent commits.
  Scripts: right-click a .ps1/.bat/.py file > Run in terminal. Custom
          commands now show their output in the terminal.
  Folder notes: right-click empty space > Add folder note (a .folder.md
          with clickable to-do boxes pinned at the top of the folder).
  Similar pictures: Share > Similar pictures finds the same photo at other
          sizes or qualities.
  Previews for 3D models (.glb .gltf .obj .stl .ply) and font thumbnails.

SIDEBAR ACTIONS
  Settings > General > "Sidebar shows actions for selected items" turns the
  sidebar into the right-click menu for whatever you select.

OPTIONAL EXTRAS
  * Dogfile ships with 7-Zip's 7za for zip/7z/tar/gz/xz. Installing the full
    7-Zip adds reading RAR, ISO and more.
  * Everything (voidtools) + es.exe -> instant whole-disk search.
  * Windows 11 23H2+ already opens .7z/.rar via the built-in tar.exe.

NOTE: Windows SmartScreen may warn on first run because the app is not
code-signed. Choose "More info" > "Run anyway".
