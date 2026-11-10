# UI polish 2

- **Web pane**: dismissing the "Private" notice no longer collapses the page (the pane's layout used grid auto-placement, so hiding the notice moved every row up one). The tab spinner stops once the page has a title. Dragging a pane divider, the sidebar edge or the preview edge no longer gets stuck over a web page or an app tab: pages are hidden and app tabs ignore the mouse while you drag.
- **Command wheel**: mouse gestures and per-button commands are gone; the wheel stays and can use any key or any mouse button (extra thumb buttons included). Alt works (Windows no longer moves to the menu bar). The Windows key, Enter, Escape, Tab, Space, Backspace, Delete, the arrows, Print Screen, the Menu key and F10 can't be the trigger, and the settings dialog says why. The wheel no longer lags (a large blurred shadow was being redrawn on every move) and its icons and names no longer overlap (icon SVGs were being stretched over the slice by a too-broad CSS rule).
- **Ribbon**: removed the bracketed notes ("Tidy up", "Multiverse", "Self-destruct") and "Rename by describing it". A window too narrow for the ribbon now gets a "More" menu instead of cut-off groups.
- **URL buttons dialog**: redesigned as cards with toggle chips; it was unstyled because its CSS only loaded inside the web tab.
- **Git and Docker tabs**: buttons keep icon and label on one line and are never cut off; empty states are centered.
- **Operations**: a job with nothing counted yet (recycling one folder, or a copy before its first bytes) shows a sliding bar and "Working…" instead of an empty "0%" bar.
- **Photoshop helper**: the packaged helper was missing numpy, scipy and scikit-image pieces ("No module named numpy._core._exceptions"). Build now bundles them, pins numpy 2.2.6, and the CI runs the helper's real self-test (it only ran `version` before, which never loaded numpy). Fixed `psd.mark_updated()` (not in psd-tools 1.10) and the self-test, which was hiding its own failure.

# Web browser audit
- Pages were placed wrongly when the program's zoom (Ctrl +/-) wasn't 100%: the zoom is now sent with every position.
- A page could open dozens of tabs and pull you into each one; now at most 3 per 4 seconds, 25 tabs in all, and only the first comes to the front.
- A web pane hidden behind another tab kept its pages only as long as a background tab did (5 minutes by default), so a half-finished upload could reload; hidden panes now keep pages at least 20 minutes.
- The "URL button" click right after opening the web tab could be lost while the page was still loading; it is now held until the browser is ready, and clicking it while the web page is itself on show just goes to the address.
- Ctrl+L / Alt+D (address), Ctrl+W (close tab), F5 / Ctrl+R (reload) and Alt+Left/Right work from the address bar and tab strip. Ctrl + mouse wheel zooms a page.
- Typing localhost:3000 or a home network address uses http (https can't work there); names with letters like ü are addresses, not searches.
- Edit URL buttons: Start page and "allow this computer" were saved even when you pressed Cancel.
- about:blank is allowed as a navigation target (some sign-in pages use it).
- address helpers moved to webaddr.js and tested.
