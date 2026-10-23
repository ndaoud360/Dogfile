// Settings: general, appearance, behavior, views, tools, keyboard shortcuts (remappable), custom commands, tags, data.
import { FOLDER_ANIMS } from './folderanim.js';
import { setNativeDialogs } from './core.js';
import { api, state, bus, h, esc, saveSettings, saveTags, toast, IS_WIN, DEFAULT_SETTINGS, sys, onMain, debounce } from './core.js';
import { icon } from './icons.js';
import { modal, confirm, prompt } from './dialogs.js';
import { showMenu } from './menu.js';
import { commands, keysFor, comboFromEvent, rebuildKeymap } from './commands.js';
import { renderAll } from './pane.js';
import { COLOR_PARTS, PRESETS, DEFAULT_COLORS, currentColor } from './theme.js';

export async function openSettings(section = 'general', opts = {}) {
  const nav = h('div', { class: 'set-nav' });
  const content = h('div', { class: 'set-content' });
  const S = state.settings;
  const changed = () => { saveSettings(); bus.emit('settings'); renderAll(); };

  const _append = (el, ...xs) => el.append(...xs.filter(Boolean));
  const group = (title) => h('div', { class: 'set-group' }, title);
  const row = (label, control, hint) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('div', {}, label), hint ? h('div', { class: 'hint' }, hint) : null), h('div', { class: 'set-ctl' }, control));
  const toggle = (key, after) => { const i = h('input', { type: 'checkbox', class: 'switch' }); i.checked = !!S[key]; i.addEventListener('change', () => { S[key] = i.checked; changed(); after?.(i.checked); }); return i; };
  const select = (key, opts, after) => { const s = h('select', { class: 'input' }, ...opts.map(([v, l]) => h('option', { value: v }, l))); s.value = String(S[key]); s.addEventListener('change', () => { S[key] = isNaN(+s.value) || s.value === '' ? s.value : +s.value; changed(); after?.(s.value); }); return s; };
  const text = (key, ph) => { const i = h('input', { class: 'input', value: S[key] || '', placeholder: ph || '' }); i.addEventListener('change', () => { S[key] = i.value; changed(); }); return i; };
  const seg = (key, opts) => { const w = h('div', { class: 'seg' }); for (const [v, l, ic] of opts) { const b = h('button', { class: 'seg-btn' + (S[key] === v ? ' on' : ''), html: (ic ? icon(ic) : '') + `<span>${l}</span>` }); b.addEventListener('click', () => { S[key] = v; w.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); changed(); if (key === 'theme') bus.emit('theme'); }); w.append(b); } return w; };

  const sections = {
    general: ['General', 'settings', async (el) => {
      const isDef = IS_WIN() ? await api('default:get').catch(() => false) : false;
      const defBtn = h('button', { class: 'btn' + (isDef ? '' : ' primary') }, isDef ? 'Restore Windows File Explorer' : 'Make Dogfile the default');
      const defState = h('div', { class: 'hint' + (isDef ? ' ok' : '') }, isDef ? '✓ Folders open in Dogfile, including Win+E.' : 'File Explorer is the default right now.');
      defBtn.addEventListener('click', async () => {
        const want = !isDef;
        if (want && !(await confirm('Make Dogfile the default?', 'Folders will open in Dogfile everywhere, including Win+E and the desktop. You can switch back here any time.', { ok: 'Make default' }))) return;
        const r = await api('default:set', want);
        toast(r ? 'Dogfile is now the default file manager' : 'Windows File Explorer restored');
        openSettingsSection('general');
      });
      _append(el,
        group('Basics'),
        row('Interface', seg('uiMode', [['simple', 'Simple'], ['full', 'Full (everything)']]), 'Simple keeps menus short. Nothing is removed, and you can switch any time.'),
        row('Language', (() => {
          const sel = h('select', { class: 'input', translate: 'no' });
          import('./i18n.js').then((m) => { for (const [v, l] of m.LANGS) sel.append(h('option', { value: v, 'data-raw': '1' }, l)); sel.value = S.language || 'auto'; });
          sel.onchange = () => { S.language = sel.value; changed(); toast('Restarting the window in the new language…'); setTimeout(() => location.reload(), 700); };
          return sel;
        })(), 'Dates and numbers follow your Windows region.'),
        group('Windows & tabs'),
        row('On startup', select('startupPath', [['restore', 'Restore previous tabs'], ['home', 'Open Home'], [sys.known.desktop, 'Open Desktop'], [sys.known.downloads, 'Open Downloads'], [sys.known.documents, 'Open Documents']])),
        row('New tab opens', select('newTabPath', [['home', 'Home'], ['current', 'Current folder']])),
        row('Keep running in the background', toggle('keepRunning'), 'Stays in the tray so folders open instantly.'),
        row('Updates', h('div', { class: 'row-inline' }, toggle('autoUpdates'), h('button', { class: 'btn small', onclick: () => import('./updates.js').then((m) => m.openUpdates()) }, 'Check now…')), 'Checks for new versions now and then, and asks before installing.'),
        IS_WIN() && row('Open and Save dialogs', h('div', { class: 'stack' }, h('label', { class: 'check' }, toggle('dialogJump'), ' Ctrl+G jumps to the folder open in Dogfile'), h('label', { class: 'check' }, toggle('dialogJumpAuto'), ' Jump there by itself when the window opens')), 'Works in the Open and Save windows of any program. Restart Dogfile after changing this.'),
        row('Your settings on other PCs', (() => {
          const box = h('div', { class: 'row-inline', style: { flexWrap: 'wrap', gap: '6px' } });
          const st = h('div', { class: 'hint', style: { width: '100%' } });
          const draw = async () => {
            const S = await import('./settingsync.js');
            box.innerHTML = '';
            st.textContent = S.syncStatus();
            box.append(h('button', { class: 'btn small', onclick: () => S.exportSettings() }, 'Export…'), h('button', { class: 'btn small', onclick: () => S.importSettings() }, 'Import…'),
              state.settings.settingsSync?.folder ? h('button', { class: 'btn small', onclick: () => { S.stopSync(); draw(); } }, 'Stop syncing') : h('button', { class: 'btn small primary', onclick: async () => { await S.chooseSyncFolder(); draw(); } }, 'Sync through a folder…'), st);
          };
          draw();
          return box;
        })(), 'Keep them in a synced folder like OneDrive or Dropbox and every PC shares your settings, pins and tags.'),
        row('Sidebar sections', (() => {
          const box = h('div', { class: 'row-inline', style: { flexWrap: 'wrap', gap: '6px 14px' } });
          for (const [k, l] of [['tags', 'Tags'], ['collections', 'Collections'], ['drives', 'Drives'], ['cloud', 'Cloud folders'], ['network', 'Network']]) {
            const c = h('input', { type: 'checkbox' });
            c.checked = (S.sidebarSections || {})[k] !== false;
            c.addEventListener('change', () => { S.sidebarSections = { ...(S.sidebarSections || {}), [k]: c.checked }; changed(); bus.emit('sidebar'); });
            box.append(h('label', { class: 'check' }, c, ' ' + l));
          }
          return box;
        })(), null),
        row('Sidebar shows actions for selected items', toggle('sidebarActions', () => bus.emit('sidebarMode')), 'Selecting files turns the sidebar into a menu of actions. Right-click still works.'),
        group('Built-in apps'),
        row('Open text files in Dogfile Notepad', toggle('useAtlasEditor'), 'Code, notes and logs open in the built-in editor.'),
        row('Play audio & video in Dogfile Player', toggle('useAtlasPlayer'), 'Plays almost anything, including MKV, 4K and FLAC.'),
        row('Open photos in Dogfile Photos', toggle('useAtlasViewer'), 'A viewer with slideshows, full screen and simple editing.'),
        row('Open 3D models in Dogfile 3D', toggle('useAtlas3D'), 'FBX, OBJ, STL, STEP and more. Turn them around, check textures, play animations.'),
        row('Player and Photos look', select('mediaTheme', [['app', 'Same as Dogfile'], ['dark', 'Always dark'], ['light', 'Always light']])),
        row('Open built-in apps as tabs', toggle('toolsInTabs'), 'Notepad, Player, Photos and 3D open as tabs here instead of separate windows.'),
        IS_WIN() ? group('Windows') : null,
        IS_WIN() ? row('Default file manager', h('div', { class: 'stack' }, defBtn, defState), 'Use Dogfile instead of File Explorer. You can switch back any time.') : null,
        IS_WIN() ? row('Windows right-click menu', h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: async () => { await api('shellverbs:set', true); toast('Added to the File Explorer right-click menu'); } }, 'Add'), h('button', { class: 'btn small', onclick: async () => { await api('shellverbs:set', false); toast('Removed'); } }, 'Remove')), 'Adds Dogfile options to the right-click menu in File Explorer.') : null,
        group('Demo'),
        row('Demo mode', (() => { const i = h('input', { type: 'checkbox', class: 'switch' }); i.checked = !!sys.demo; i.addEventListener('change', async () => { const ok = await import('./demo.js').then((m) => m.setDemo(i.checked)); if (!ok) i.checked = !i.checked; }); return i; })(), 'Shows a pretend PC so you can record or present without showing your own files.'),
      );
    }],
    appearance: ['Appearance', 'sun', (el) => {
      const scale = h('input', { type: 'range', min: '0.85', max: '1.3', step: '0.05', value: String(S.fontScale) });
      scale.addEventListener('change', () => { S.fontScale = +scale.value; changed(); bus.emit('theme'); });
      _append(el,
        row('Theme', seg('theme', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']])),
        row('Density', seg('density', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['touch', 'Touch'], ['auto', 'Automatic']]), 'Touch makes everything bigger for fingers. Automatic picks it on touch screens.'),
        row('Text size', scale),
        row('Names under thumbnails', select('gridLabels', [['smart', 'Hide on photos until you point at them'], ['always', 'Always show'], ['hover', 'Only when you point at them']])),
        row('Use Windows file icons', toggle('useWindowsIcons'), 'Uses the icons from your installed apps.'),
        row('Show thumbnails', toggle('showThumbnails')),
        row('Full breadcrumb path', toggle('fullCrumbs'), 'Shows every folder in the path, starting from the drive.'),
        row('Show status bar', toggle('showStatusBar')),
        row('Panel animations', (() => {
          // each panel that comes out of an edge: fold (turned to its edge), slide, or none
          const grid = h('div', { class: 'pa-set' });
          const draw = async () => {
            const P = await import('./panelanim.js');
            grid.innerHTML = '';
            const cur = state.settings.panelAnims || {};
            const all = h('select', { class: 'input small' }, h('option', { value: '' }, 'Set all…'), ...P.MODES.map(([v, l]) => h('option', { value: v }, l)));
            all.onchange = () => { if (!all.value) return; state.settings.panelAnims = Object.fromEntries(Object.keys(P.PANELS).map((k) => [k, all.value])); changed(); draw(); };
            for (const [k, [label]] of Object.entries(P.PANELS)) {
              const sel = h('select', { class: 'input small' }, ...P.MODES.map(([v, l]) => h('option', { value: v }, l)));
              sel.value = cur[k] || (k === 'sidebar' && state.settings.foldAnimation === false ? 'slide' : 'fold');
              sel.onchange = () => { state.settings.panelAnims = { ...(state.settings.panelAnims || {}), [k]: sel.value }; changed(); };
              grid.append(h('span', {}, label), sel);
            }
            grid.append(h('span', { class: 'hint' }, 'All panels'), all);
          };
          draw();
          return grid;
        })(), 'Fold, slide or no animation, for each panel.'),
        row('Folder animation', h('div', { class: 'row-inline' }, select('folderAnimation', FOLDER_ANIMS.map(([v, l]) => [v, l])), h('button', { class: 'btn small', title: 'Play it on the folder that’s open', onclick: async () => {
          const { playFolderAnim } = await import('./folderanim.js');
          const { paneEls } = await import('./pane.js');
          const el = paneEls[state.activePane];
          if (!el) return;
          await playFolderAnim(el, 'open', state.settings.folderAnimation || 'fade');
          await new Promise((r) => setTimeout(r, 250));
          playFolderAnim(el, 'close', state.settings.folderAnimation || 'fade');
        } }, 'Preview')), 'How a folder appears when you open it or go back.'),
        row('Glass sidebar', toggle('sidebarGlass'), 'A see-through sidebar that blurs what is behind the window.'),
        row('Colors', h('button', { class: 'btn small', onclick: () => show('colors') }, 'Customize colors…'), 'Accent color, presets and more.'),
      );
      // ---- rounded corners ----
      S.corners = { ...DEFAULT_SETTINGS.corners, ...(S.corners || {}) };
      const C = S.corners;
      const applyC = () => { saveSettings(); bus.emit('theme'); api('win:corners', C.window ? (C.radius >= 6 ? 'round' : 'small') : 'square'); };
      const rad = h('input', { type: 'range', min: '0', max: '20', step: '1', value: String(C.radius) });
      const radTxt = h('span', { class: 'hint', style: { width: '40px', textAlign: 'right' } }, C.radius + ' px');
      rad.addEventListener('input', () => { C.radius = +rad.value; radTxt.textContent = C.radius + ' px'; applyC(); });
      const targets = h('div', { class: 'corner-targets' });
      for (const [k, label] of [['tabs', 'Tabs'], ['tiles', 'Thumbnails'], ['controls', 'Buttons & fields'], ['menus', 'Menus & popups'], ['dialogs', 'Dialogs'], ['panels', 'Panels & cards'], ['items', 'Sidebar & list highlights'], ['window', 'Window corners (Windows 11)']]) {
        const cb = h('input', { type: 'checkbox' }); cb.checked = !!C[k];
        cb.addEventListener('change', () => { C[k] = cb.checked; applyC(); });
        targets.append(h('label', { class: 'check' }, cb, ' ' + label));
      }
      el.append(h('h3', { class: 'set-h3' }, 'Rounded corners'));
      _append(el,
        row('Roundness', h('div', { class: 'row-inline' }, rad, radTxt), '0 is square.'),
        row('Round these', targets),
        row('', h('button', { class: 'btn small', onclick: () => { S.corners = { ...DEFAULT_SETTINGS.corners }; applyC(); show('appearance'); } }, 'Reset corners')));
    }],
    colors: ['Colors', 'palette', (el) => {
      S.colors = S.colors || { light: {}, dark: {} };
      S.colors.light = S.colors.light || {}; S.colors.dark = S.colors.dark || {};
      const apply = () => { saveSettings(); bus.emit('theme'); };
      const presets = h('div', { class: 'chips' });
      S.colorPresets = S.colorPresets || {};
      const chip = (name, pr, custom) => {
        const b = h('button', { class: 'chip preset' + (custom ? ' custom' : ''), title: custom ? 'Your preset (right-click to rename or delete)' : 'Built-in preset', onclick: () => { S.colors = { light: { ...(pr.light || {}) }, dark: { ...(pr.dark || {}) } }; S.accent = pr.accent || (pr.light && pr.light['--accent']) || '#3b82f6'; if (pr.shadowStrength != null) S.shadowStrength = pr.shadowStrength; apply(); show('colors'); toast(`Applied “${name}”`); } },
          h('span', { class: 'pv-sw', style: { background: (pr.light || {})['--side-bg'] || DEFAULT_COLORS.light['--side-bg'] } }), h('span', { class: 'pv-sw', style: { background: pr.accent || (pr.light || {})['--accent'] || DEFAULT_COLORS.light['--accent'] } }), name);
        if (custom) b.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu([
          { label: 'Rename…', icon: 'rename', run: async () => { const n = await prompt('Rename preset', name); if (n && n !== name) { S.colorPresets[n] = S.colorPresets[name]; delete S.colorPresets[name]; saveSettings(); show('colors'); } } },
          { label: 'Update with current colors', run: () => { S.colorPresets[name] = currentTheme(); saveSettings(); toast('Preset updated'); } },
          { label: 'Export to file', icon: 'downloadArrow', run: () => exportColors(name, pr) },
          { label: 'Delete', icon: 'trash', danger: true, run: () => { delete S.colorPresets[name]; saveSettings(); show('colors'); } },
        ], e.clientX, e.clientY); });
        return b;
      };
      for (const [name, pr] of Object.entries(PRESETS)) presets.append(chip(name, pr, false));
      for (const [name, pr] of Object.entries(S.colorPresets)) presets.append(chip(name, pr, true));
      const currentTheme = () => ({ light: { ...S.colors.light }, dark: { ...S.colors.dark }, accent: S.accent, shadowStrength: S.shadowStrength ?? 1 });
      const exportColors = async (name, data) => {
        const dir = sys.known.downloads || sys.known.home;
        const file = await api('fs:uniqueName', dir, `Dogfile Colors - ${String(name).replace(/[<>:"/\\|?*]/g, '')}.json`, 'number');
        await api('fs:writeText', file, JSON.stringify({ type: 'atlas-colors', version: 1, name, ...data }, null, 2));
        toast(`Exported to ${file}`, { ms: 6000, action: { label: 'Show', run: () => api('win:new', { path: dir, select: file }) } });
      };
      _append(el,
        h('p', { class: 'hint' }, 'Pick a preset or change any color. Light and dark each have their own.'),
        presets,
        h('div', { class: 'row-inline', style: { margin: '10px 0 4px' } },
          h('button', { class: 'btn small', onclick: () => { S.colors = { light: {}, dark: {} }; S.accent = '#3b82f6'; S.shadowStrength = 1; apply(); show('colors'); } }, 'Reset all to default'),
          h('button', { class: 'btn small primary', onclick: async () => { const n = await prompt('Save preset', '', { label: 'Preset name', placeholder: 'e.g. My Midnight', validate: (v) => (!v.trim() ? 'Enter a name' : PRESETS[v.trim()] ? 'That name is used by a built-in preset' : null) }); if (!n) return; S.colorPresets[n.trim()] = currentTheme(); saveSettings(); show('colors'); toast(`Saved preset “${n.trim()}”`); } }, 'Save as preset…'),
          h('button', { class: 'btn small', onclick: async () => { const n = await prompt('Export colors', 'My colors', { label: 'Name for the file' }); if (n) exportColors(n, currentTheme()); } }, 'Export to file'),
          h('button', { class: 'btn small', onclick: async () => {
            const [f] = await api('dialog:openFiles', { title: 'Import colors', defaultPath: sys.known.downloads, filters: [{ name: 'Dogfile colors', extensions: ['json'] }] });
            if (!f) return;
            try {
              const c = JSON.parse((await api('fs:readText', f, 1024 * 1024)).text);
              if (!(c.light || c.dark)) throw new Error('bad');
              const name = (c.name || f.split(/[\\/]/).pop().replace(/\.json$/i, '').replace(/^Dogfile Colors - /, '')).trim() || 'Imported';
              S.colorPresets[name] = { light: c.light || {}, dark: c.dark || {}, accent: c.accent, shadowStrength: c.shadowStrength };
              S.colors = { light: { ...(c.light || {}) }, dark: { ...(c.dark || {}) } }; if (c.accent) S.accent = c.accent; if (c.shadowStrength != null) S.shadowStrength = c.shadowStrength;
              apply(); show('colors'); toast(`Imported “${name}” and added it to your presets`);
            } catch { toast('That isn’t a Dogfile colors file', { error: true }); }
          } }, 'Import from file…')));
      const grid = h('div', { class: 'color-grid' }, h('div', { class: 'cg-head' }, ''), h('div', { class: 'cg-head' }, 'Light'), h('div', { class: 'cg-head' }, 'Dark'), h('div', { class: 'cg-head' }, ''));
      for (const g of COLOR_PARTS) {
        grid.append(h('div', { class: 'cg-group' }, g.group));
        for (const [key, label] of g.items) {
          const mk = (theme) => {
            const inp = h('input', { type: 'color', value: currentColor(S, theme, key), title: `${label} (${theme})` });
            const isSet = () => !!S.colors[theme][key] || (key === '--accent' && S.accent && S.accent !== '#3b82f6');
            inp.classList.toggle('changed', isSet());
            inp.addEventListener('input', () => { S.colors[theme][key] = inp.value; inp.classList.add('changed'); apply(); });
            return inp;
          };
          const li = mk('light'), dk = mk('dark');
          const reset = h('button', { class: 'icon-btn small', title: 'Reset to default', html: icon('undo'), onclick: () => { delete S.colors.light[key]; delete S.colors.dark[key]; if (key === '--accent') S.accent = '#3b82f6'; li.value = DEFAULT_COLORS.light[key]; dk.value = DEFAULT_COLORS.dark[key]; li.classList.remove('changed'); dk.classList.remove('changed'); apply(); } });
          grid.append(h('div', { class: 'cg-label' }, label), li, dk, reset);
        }
      }
      const shadow = h('input', { type: 'range', min: '0', max: '2.5', step: '0.1', value: String(S.shadowStrength ?? 1) });
      shadow.addEventListener('input', () => { S.shadowStrength = +shadow.value; apply(); });
      _append(el, grid, row('Sidebar shadow strength', shadow, 'How much shadow the sidebar casts.'));
      // color-coding rules
      el.append(h('h3', { class: 'set-h3' }, 'Color-coding rules'), h('p', { class: 'hint' }, 'Tint file names that match a rule. The first match wins.'));
      const rules = h('div', { class: 'stack' });
      const drawRules = () => {
        rules.innerHTML = '';
        S.highlightRules = S.highlightRules || [];
        S.highlightRules.forEach((r, i) => {
          const on = h('input', { type: 'checkbox', class: 'switch' }); on.checked = r.on !== false; on.onchange = () => { r.on = on.checked; changed(); };
          const name = h('input', { class: 'input', value: r.name || '', placeholder: 'Rule name' }); name.onchange = () => { r.name = name.value; changed(); };
          const type = h('select', { class: 'input' }, h('option', { value: 'pattern' }, 'Name matches'), h('option', { value: 'recent' }, 'Modified within (minutes)'), h('option', { value: 'size' }, 'Larger than (MB)'), h('option', { value: 'hidden' }, 'Is hidden'));
          type.value = r.type; type.onchange = () => { r.type = type.value; changed(); drawRules(); };
          const val = h('input', { class: 'input', value: r.type === 'pattern' ? r.pattern || '' : r.type === 'recent' ? r.minutes ?? 10 : r.type === 'size' ? r.mb ?? 500 : '', placeholder: r.type === 'pattern' ? '*.exe;*.bat' : '', disabled: r.type === 'hidden' });
          val.onchange = () => { if (r.type === 'pattern') r.pattern = val.value; else if (r.type === 'recent') r.minutes = +val.value || 10; else if (r.type === 'size') r.mb = +val.value || 500; changed(); };
          const col = h('input', { type: 'color', value: r.color || '#30a46c' }); col.oninput = () => { r.color = col.value; changed(); };
          const del = h('button', { class: 'icon-btn small', title: 'Delete rule', html: icon('trash'), onclick: () => { S.highlightRules.splice(i, 1); changed(); drawRules(); } });
          rules.append(h('div', { class: 'rule-row' }, on, name, type, val, col, del));
        });
        rules.append(h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: () => { S.highlightRules.push({ name: 'New rule', type: 'pattern', pattern: '*.psd', color: '#8e4ec6', on: true }); changed(); drawRules(); } }, 'Add rule'),
          h('button', { class: 'btn small', onclick: () => { S.highlightRules = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.highlightRules)); changed(); drawRules(); } }, 'Restore default rules')));
      };
      drawRules();
      el.append(rules);
    }],
    behavior: ['Behavior', 'keyboard', (el) => {
      _append(el,
        row('Progress window for copies and moves', toggle('opsPopup'), 'Shows speed and time left. Minimize it to keep working.'),
        row('Single-click to open', toggle('singleClick')),
        row('Double-click empty space goes up', toggle('doubleClickUp')),
        row('Use Windows dialogs for Open / Save / Choose folder', toggle('nativeDialogs', (v) => setNativeDialogs(v)), 'When off, Dogfile uses its own pickers.'),
        row('Typing in a folder', select('typeAhead', [['select', 'Jumps to matching item'], ['filter', 'Filters the folder']])),
        row('Delete moves to Recycle Bin', toggle('deleteToRecycle')),
        row('Confirm before deleting', toggle('confirmDelete')),
        row('Ask what to do on drag & drop', toggle('askOnDrop'), 'Otherwise the same drive moves and another drive copies. Hold Ctrl to copy or Shift to move.'),
        row('Open archives like folders', toggle('browseArchives')),
        row('Run file operations one at a time', toggle('sequentialOps'), 'Better for older hard drives.'),
        row('Smart drop', select('smartDrop', [['smart', 'When it helps'], ['ask', 'Always ask'], ['off', 'Off']]), 'Offers to extract, sort or file things into matching folders when you drop them.'),
        row('Transfer speed limit', (() => { const i = h('input', { class: 'input small', type: 'number', min: '0', step: '1', value: String(S.throttleMBps || 0) }); i.addEventListener('change', () => { S.throttleMBps = Math.max(0, +i.value || 0); changed(); }); return h('div', { class: 'row-inline' }, i, h('span', { class: 'hint' }, 'MB/s (0 means no limit)')); })(), 'Keeps big copies from slowing everything else down.'),
      );
    }],
    views: ['Files & views', 'viewGrid', (el) => {
      _append(el,
        row('Default view', select('defaultView', [['grid', 'Grid'], ['details', 'Details'], ['list', 'List'], ['columns', 'Columns']])),
        row('Remember view per folder', toggle('rememberFolderViews')),
        row('Folders first', toggle('foldersFirst')),
        row('Show hidden items', toggle('showHidden')),
        row('Show protected system files', toggle('showSystem')),
        row('Show file extensions', toggle('showExtensions')),
        row('Item check boxes', toggle('showCheckboxes')),
        row('Calculate folder sizes', toggle('folderSizes'), 'Shows how big each folder is. Uses a little more disk activity.'),
        row('Names under pictures in Gallery view', toggle('galleryNames')),
        row('Date format', select('dateFormat', [['locale', 'System format'], ['relative', 'Relative (5 min ago)'], ['iso', 'ISO 2026-10-16 14:30']])),
        row('Size units', select('sizeUnits', [['binary', 'Binary (KB = 1024)'], ['decimal', 'Decimal (kB = 1000)']])),
      );
    }],
    tools: ['Tools & apps', 'terminal', (el) => {
      const apps = h('div', { class: 'stack' });
      const drawApps = () => {
        apps.innerHTML = '';
        for (const [i, a] of (S.openWithApps || []).entries()) apps.append(h('div', { class: 'row-inline' }, h('span', { class: 'grow' }, `${a.name}: ${a.command}`), h('button', { class: 'icon-btn', html: icon('close'), onclick: () => { S.openWithApps.splice(i, 1); changed(); drawApps(); } })));
        apps.append(h('button', { class: 'btn small', onclick: async () => { const n = await prompt('Add “Open with” app', '', { label: 'Name' }); if (!n) return; const c = await prompt('Add “Open with” app', '', { label: 'Program path or command', placeholder: 'C:\\Program Files\\GIMP 2\\bin\\gimp.exe' }); if (!c) return; S.openWithApps = [...(S.openWithApps || []), { name: n, command: c }]; changed(); drawApps(); } }, 'Add app'));
      };
      drawApps();
      // instant index: live status per drive, which drives, rebuild, faster build with administrator rights
      const indexBox = h('div', { class: 'stack idx-box' });
      const drawIndex = async () => {
        const st = await api('index:status').catch(() => null);
        indexBox.innerHTML = '';
        if (!st?.available) { indexBox.append(h('div', { class: 'hint' }, 'The fast search engine isn’t available, so Dogfile searches folder by folder.')); return; }
        if (S.indexEnabled === false) return;
        const drives = (state.drives || []).filter((d) => d.type !== 'network' && d.type !== 'optical' && d.type !== 'portable');
        const chosen = Array.isArray(S.indexRoots) && S.indexRoots.length ? S.indexRoots : null;
        for (const r of st.roots) {
          const label = r.state === 'ready' ? `${(r.count || 0).toLocaleString()} files and folders · ${r.method === 'mft' ? 'read from the file table' : 'read from folders'}${r.ms ? ` in ${(r.ms / 1000).toFixed(1)} s` : ''}` : r.state === 'loading' ? 'Loading…' : `${r.state === 'refreshing' ? 'Updating' : 'Building'}… ${(r.scanned || 0).toLocaleString()} found`;
          indexBox.append(h('div', { class: 'idx-row' }, h('span', { class: 'idx-dot ' + (r.state === 'ready' ? 'ok' : 'busy') }), h('b', {}, r.root), h('span', { class: 'hint' }, label)));
        }
        if (drives.length > 1 && IS_WIN()) {
          const pick = h('div', { class: 'row-inline wrap' }, h('span', { class: 'hint' }, 'Drives:'), ...drives.map((d) => {
            const cb = h('input', { type: 'checkbox' }); cb.checked = chosen ? chosen.some((x) => x.toLowerCase() === d.path.toLowerCase()) : d.type === 'fixed';
            cb.onchange = () => { const cur = new Set((chosen || drives.filter((x) => x.type === 'fixed').map((x) => x.path))); if (cb.checked) cur.add(d.path); else cur.delete(d.path); S.indexRoots = [...cur]; changed(); setTimeout(drawIndex, 300); };
            return h('label', { class: 'check' }, cb, ' ' + (d.name || d.path));
          }));
          indexBox.append(pick);
        }
        indexBox.append(h('div', { class: 'row-inline' },
          h('button', { class: 'btn small', onclick: async () => { await api('index:refresh'); drawIndex(); } }, 'Rebuild now'),
          IS_WIN() && !st.admin ? h('button', { class: 'btn small', title: 'Windows asks for administrator permission once', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Building…'; const r = await api('index:fastBuild'); toast(r.ok ? 'Index rebuilt from the file table' : r.error, { error: !r.ok }); drawIndex(); } }, 'Faster build (administrator)…') : null));
        if (IS_WIN() && !st.admin) indexBox.append(h('div', { class: 'hint' }, 'With administrator rights the first build takes seconds instead of a few minutes.'));
      };
      drawIndex();
      const offIdx = onMain('index:status', () => { if (document.body.contains(indexBox)) drawIndexSoon(); else offIdx?.(); });
      const drawIndexSoon = debounce(drawIndex, 400);
      const cmds = h('div', { class: 'stack' });
      const drawCmds = () => {
        cmds.innerHTML = '';
        for (const [i, c] of (S.customCommands || []).entries()) cmds.append(h('div', { class: 'row-inline' }, h('span', { class: 'grow' }, h('b', {}, c.name), ` ${c.command}`), (() => { const cb = h('input', { type: 'checkbox' }); cb.checked = !c.detached; cb.onchange = () => { c.detached = !cb.checked; changed(); }; return h('label', { class: 'check', title: 'Run in the built-in terminal so you see the output' }, cb, ' Show output'); })(), h('button', { class: 'icon-btn', html: icon('close'), onclick: () => { S.customCommands.splice(i, 1); changed(); drawCmds(); } })));
        cmds.append(h('button', { class: 'btn small', onclick: async () => { const n = await prompt('Custom command', '', { label: 'Name (shown in the right-click menu → More)' }); if (!n) return; const c = await prompt('Custom command', '', { label: 'Command line', placeholder: 'ffmpeg -i {file} {file}.mp3', hint: 'Tokens: {file} {files} {names} {dir} {other} (other pane)' }); if (!c) return; S.customCommands = [...(S.customCommands || []), { name: n, command: c }]; changed(); drawCmds(); } }, 'Add command'));
      };
      drawCmds();
      _append(el,
        group('Programs'),
        row('Terminal', select('terminal', [['auto', 'Windows Terminal (if installed)'], ['powershell', 'Windows PowerShell'], ['pwsh', 'PowerShell 7'], ['cmd', 'Command Prompt']])),
        row('Code editor command', text('editor', 'Automatic'), 'For Open in code editor. Leave it empty and Dogfile finds one.'),
        row('File types', h('button', { class: 'btn small', onclick: () => import('./assoc.js').then((m) => m.fileTypesDialog()) }, 'Choose what opens each file type…'), 'Choose what opens each kind of file.'),
        row('“Open with” apps', apps),
        row('Custom commands', cmds),
        group('Search'),
        row('Instant search index', h('div', { class: 'stack' }, toggle('indexEnabled'), indexBox), 'Keeps a list of your files so search and folder sizes are instant.'),
        row('Index Windows and program folders', toggle('indexSystem'), 'Also lists system and program folders. Uses more memory and is rarely needed.'),
        row('Assistant’s language model', (() => {
          const box = h('div', { class: 'stack' });
          const draw = async () => {
            const [ai, st] = await Promise.all([api('ai:status'), api('llm:status').catch(() => ({}))]);
            box.innerHTML = '';
            const dl = (k, label) => (ai[k]?.ready ? h('button', { class: 'btn small', onclick: async () => { await api('llm:stop'); await api('ai:remove', k); draw(); } }, `Remove ${label}`) : h('button', { class: 'btn small primary', onclick: async () => { const { ensureModels } = await import('./ai.js'); await ensureModels([k]); draw(); } }, `Download ${label}`));
            box.append(
              h('label', { class: 'check' }, toggle('assistantBrain'), ' Use it to understand requests'),
              select('assistantModel', [['auto', 'Best one downloaded'], ['brain', '4B: understands most (2.7 GB, 8 GB+ memory)'], ['brain-small', '2B: faster, less memory (1.3 GB)']], () => api('llm:stop')),
              h('div', { class: 'row-inline', style: { flexWrap: 'wrap', gap: '6px' } }, dl('brain', '4B'), dl('brain-small', '2B')),
              h('div', { class: 'hint' }, st.available ? `In use: ${st.model === 'brain' ? 'Qwen3.5 4B' : 'Qwen3.5 2B'} · ${{ ready: 'loaded', loading: 'loading…', reading: 'getting ready…', off: 'loads when you ask something' }[st.state] || st.state}` : 'Not downloaded: the assistant uses its built-in rules.'));
          };
          draw();
          return box;
        })(), 'Runs privately on this PC, even offline. You always see the plan before anything changes.'),
        row('AI search', h('div', { class: 'row-inline' }, toggle('aiSearch'), h('button', { class: 'btn small', onclick: () => import('./ai.js').then((m) => m.modelsDialog()) }, 'Models…')), 'Find photos, videos and songs by describing them. Runs privately on this PC.'),
        (() => {
          const st = h('div', { class: 'hint' }, 'Uses Everything for instant results across your PC. Needs Everything and its es.exe tool.');
          if (IS_WIN()) api('everything:status').then((r) => {
            st.textContent = r?.es ? 'Ready.' : r?.running ? 'Everything is running but es.exe is missing. You can get it from voidtools.com.' : 'Everything isn’t running. Dogfile’s own index works fine without it.';
          }).catch(() => {});
          return row('Use Everything for search', toggle('useEverything'), st);
        })(),
        group('Connections & automation'),
        row('Server connections', h('button', { class: 'btn small', onclick: () => import('./network.js').then((m) => m.connectionsDialog()) }, 'Manage…'), 'NAS, shared folders, SFTP, FTP and WebDAV. Passwords stay encrypted on this PC.'),
        row('Folder automations', h('button', { class: 'btn small', onclick: () => import('./rules.js').then((m) => m.automationsManager()) }, 'Manage…'), 'Rules that tidy new files in a folder.'),
        row('Document reminders', h('button', { class: 'btn small', onclick: () => import('./reminders.js').then((m) => m.openReminders()) }, 'Open…'), 'Finds expiry and due dates in your documents and reminds you in time.'),
        group('Music'),
        row('AcoustID key (song identification)', text('acoustidKey', 'paste your free key'), 'Lets the tag editor recognize songs by sound. Get a free key at acoustid.org.'),
      );
    }],
    features: ['Features', 'puzzle', async (el) => {
      const FS = await import('./featurestore.js');
      const acct = h('div', { class: 'row-inline' });
      const drawAcct = async () => {
        acct.innerHTML = '';
        const has = await api('secret:has', 'github');
        if (has && S.githubUser) acct.append(h('span', { class: 'hint' }, `Signed in as ${S.githubUser}`), h('button', { class: 'btn small', onclick: () => FS.uploadDialog() }, 'Upload a feature…'), h('button', { class: 'btn small', onclick: async () => { await FS.signOut(); drawAcct(); } }, 'Sign out'));
        else acct.append(h('button', { class: 'btn small', onclick: async () => { if (await FS.signIn()) drawAcct(); } }, 'Sign in with GitHub…'));
      };
      drawAcct();
      const n = (S.extensions || []).length;
      _append(el,
        row('Your features', h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: () => bus.emit('featuresManager') }, 'Manage…'), h('button', { class: 'btn small', onclick: () => import('./features.js').then((m) => m.createFeature()) }, 'Add a feature…')), n ? `${n} installed.` : 'Small add-ons for Dogfile, Notepad, Photos and Player.'),
        row('Feature browser', h('button', { class: 'btn small', onclick: () => FS.featureBrowser() }, 'Browse features…'), 'Find features other people shared. No account needed.'),
        row('Account for sharing', acct, 'Only needed to share your own. Kept encrypted on this PC.'),
        row('Making features', h('div', { class: 'row-inline' }, h('button', { class: 'btn small', onclick: async () => { const p = await api('docs:featureGuide'); (await import('./apptabs.js')).openTool('editor', [p]); } }, 'Read the guide')), 'In Notepad, press F1 for the reference and examples.'),
      );
    }],
    safety: ['History & safety', 'history', (el) => {
      _append(el,
        row('Keep a file history', h('div', { class: 'row-inline' }, select('historyLimit', [[200, 'Last 200 actions'], [1000, 'Last 1,000 actions'], [5000, 'Last 5,000 actions']]), h('button', { class: 'btn small', onclick: () => import('./history.js').then((m) => m.historyDialog()) }, 'Open history…')), 'Copies, moves, renames and deletes, with Undo when possible.'),
        row('Versions kept per file', select('versionsKeep', [[5, '5'], [10, '10'], [20, '20'], [50, '50']]), 'For files you keep versions of.'),
        row('Space for versions', select('versionsMaxMB', [[1000, '1 GB'], [5000, '5 GB'], [20000, '20 GB']]), 'The oldest go first when it fills up.'),
        row('Saved versions', h('button', { class: 'btn small', onclick: () => import('./history.js').then((m) => m.versionsOverview()) }, 'Show all…')),
      );
    }],
    privacy: ['Privacy', 'lock', (el) => {
      _append(el,
        row('Clipboard history', select('clipHistory', [['paths', 'Files and paths only'], ['all', 'Files, paths and text'], ['off', 'Off']]), 'Ctrl+Shift+V shows what you copied recently. Passwords are never kept.'),
        row('Keep clipboard history after closing', toggle('clipRemember')),
        row('Clear clipboard history', h('button', { class: 'btn small', onclick: () => { api('store:set', 'cliphistory', []); toast('Cleared'); } }, 'Clear')),
        row('Recently opened', h('button', { class: 'btn small', onclick: async () => { state.recent = []; state.recentFiles = []; (await import('./core.js')).saveLibrary(); toast('Recent lists cleared'); } }, 'Clear recent folders & files')),
      );
    }],
    access: ['Accessibility', 'eye', (el) => {
      _append(el,
        row('Focus rings', select('focusRings', [['auto', 'When using the keyboard'], ['always', 'Always']]), 'Shows which item has the keyboard focus.'),
        row('Screen reader announcements', toggle('a11yAnnounce'), 'Reads out folders, items and finished tasks.'),
        row('High contrast', toggle('highContrast'), 'Darker text and stronger lines.'),
        row('Reduce motion', select('reduceMotion', [['', 'Follow Windows'], [true, 'On'], [false, 'Off']]), 'Turns off animations.'),
        row('Bigger click targets', toggle('bigTargets')),
        row('Keyboard', h('div', { class: 'hint' }, 'Ctrl+F6 moves between areas. Shift+F10 opens the right-click menu. Ctrl+Shift+P lists every command.')),
      );
    }],
    keys: ['Keyboard shortcuts', 'keyboard', (el) => {
      const filter = h('input', { class: 'input', placeholder: 'Filter shortcuts…' });
      const list = h('div', { class: 'keys-list' });
      const draw = () => {
        const q = filter.value.toLowerCase();
        list.innerHTML = '';
        const cats = {};
        for (const c of commands.values()) { if (c.hidden && !/^tab\d|^tag\d/.test(c.id)) continue; if (q && !(c.title + keysFor(c.id).join(' ')).toLowerCase().includes(q)) continue; (cats[c.cat || 'Other'] ||= []).push(c); }
        for (const [cat, cs] of Object.entries(cats)) {
          list.append(h('div', { class: 'keys-cat' }, cat));
          for (const c of cs) {
            const ks = keysFor(c.id);
            const kb = h('div', { class: 'keys-keys' }, ...ks.map((k) => h('kbd', {}, k)));
            const edit = h('button', { class: 'link' }, 'Change');
            edit.addEventListener('click', () => {
              kb.innerHTML = '<span class="hint">Press keys… (Esc to cancel, Backspace to clear)</span>';
              const onKey = (e) => {
                e.preventDefault(); e.stopPropagation();
                const combo = comboFromEvent(e);
                if (['Control', 'Shift', 'Alt', 'Meta'].includes(combo)) return;
                window.removeEventListener('keydown', onKey, true);
                if (combo === 'Escape') return draw();
                S.keybindings = { ...(S.keybindings || {}) };
                S.keybindings[c.id] = combo === 'Backspace' ? [] : [combo];
                saveSettings(); rebuildKeymap(); draw();
              };
              window.addEventListener('keydown', onKey, true);
            });
            const reset = S.keybindings?.[c.id] ? h('button', { class: 'link', onclick: () => { delete S.keybindings[c.id]; saveSettings(); rebuildKeymap(); draw(); } }, 'Reset') : null;
            list.append(h('div', { class: 'keys-row' }, h('span', { class: 'grow' }, c.title), kb, edit, reset));
          }
        }
      };
      filter.addEventListener('input', draw);
      draw();
      el.append(h('div', { class: 'row-inline' }, filter, h('button', { class: 'btn small', onclick: () => { S.keybindings = {}; saveSettings(); rebuildKeymap(); draw(); } }, 'Reset all')), list);
    }],
    tags: ['Tags', 'tag', (el) => {
      const list = h('div', { class: 'stack' });
      const draw = () => {
        list.innerHTML = '';
        state.tags.defs.forEach((d, i) => {
          const name = h('input', { class: 'input', value: d.name });
          name.addEventListener('change', () => { d.name = name.value; saveTags(); bus.emit('tags'); });
          const col = h('input', { type: 'color', value: d.color });
          col.addEventListener('input', () => { d.color = col.value; saveTags(); bus.emit('tags'); });
          list.append(h('div', { class: 'row-inline' }, col, name, h('kbd', {}, `Alt+${i + 1}`), h('button', { class: 'icon-btn', title: 'Delete tag', html: icon('trash'), onclick: async () => { if (await confirm('Delete tag?', `Remove “${d.name}” from all files?`)) { state.tags.defs.splice(i, 1); for (const k of Object.keys(state.tags.map)) { state.tags.map[k] = state.tags.map[k].filter((x) => x !== d.id); if (!state.tags.map[k].length) delete state.tags.map[k]; } saveTags(); bus.emit('tags'); draw(); } } })));
        });
        list.append(h('button', { class: 'btn small', onclick: () => { state.tags.defs.push({ id: 't' + Date.now().toString(36), name: 'New tag', color: '#12a594' }); saveTags(); bus.emit('tags'); draw(); } }, 'Add tag'));
      };
      draw();
      el.append(h('p', { class: 'hint' }, 'Tags follow files when you move or rename them in Dogfile. Drag files onto a tag in the sidebar to tag them.'), list,
        row('Also write tags into the files', toggle('tagsInFiles'), 'Saves tags inside photos, music, Office files and PDFs, so Windows and other PCs see them too.'));
    }],
    data: ['Data & reset', 'workspace', async (el) => {
      const dir = await api('store:path');
      _append(el,
        row('Settings folder', h('div', { class: 'stack' }, h('code', {}, dir), h('button', { class: 'btn small', onclick: () => api('shell:open', dir) }, 'Open folder')), 'Copy this folder to back up your setup. Add portable.txt next to Dogfile.exe to run it portable.'),
        row('Export settings', h('button', { class: 'btn small', onclick: () => import('./settingsync.js').then((m) => m.exportSettings()) }, 'Export…'), 'Saves your settings, colors, tags and pins to a file.'),
        row('Import settings', h('button', { class: 'btn small', onclick: () => import('./settingsync.js').then((m) => m.importSettings()) }, 'Import from file…')),
        row('Forget per-folder views', h('button', { class: 'btn small', onclick: async () => { state.folderViews = {}; (await import('./core.js')).saveLibrary(); toast('Folder views reset'); } }, 'Reset')),
        row('Reset all settings', h('button', { class: 'btn small danger', onclick: async () => { if (await confirm('Reset settings?', 'Put every setting back to how it started?', { danger: true, ok: 'Reset' })) { Object.assign(S, DEFAULT_SETTINGS); saveSettings(); bus.emit('theme'); renderAll(); toast('Settings reset'); openSettingsSection('data'); } } }, 'Reset')),
      );
    }],
    license: ['Licence', 'star', async (el) => (await import('./license.js')).licenseSettings(el, row)],
    about: ['About', 'info', async (el) => {
      const info = await api('sys:info');
      el.append(h('div', { class: 'about' }, h('div', { class: 'about-name' }, 'Dogfile'), h('div', { class: 'hint' }, `Version ${info.version} · ${info.platform} · ${info.has7z ? '7-Zip detected' : 'Using Windows tar for archives'}${state.startupMs ? ` · started in ${state.startupMs} ms` : ''}`),
        h('p', {}, 'A fast file manager with tabs, split panes, previews, tags and a lot more.')));
    }],
  };

  if (opts.index) { const out = []; for (const [id, [label, , fn]] of Object.entries(sections)) { if (id === 'about') continue; const sec = h('div'); try { await fn(sec); } catch { continue; } for (const r of sec.querySelectorAll('.set-row')) { const l = r.querySelector('.set-label > div')?.textContent?.trim(); if (l) out.push({ section: id, sectionLabel: label, label: l, hint: r.querySelector('.set-label .hint')?.textContent || '' }); } } return out; }
  for (const [id, [label, ic]] of Object.entries(sections)) {
    if (['behavior', 'safety', 'keys', 'data'].includes(id)) nav.append(h('div', { class: 'set-nav-sep', role: 'separator' }));
    const b = h('button', { class: 'set-tab', 'data-id': id, html: `${icon(ic)}<span>${label}</span>` });
    b.addEventListener('click', () => show(id));
    nav.append(b);
  }
  // search every setting at once
  const search = h('input', { class: 'input set-search', placeholder: 'Search settings', spellcheck: 'false' });
  let searchSeq = 0;
  search.addEventListener('input', async () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return show(lastShown);
    const my = ++searchSeq;
    nav.querySelectorAll('.set-tab').forEach((b) => b.classList.remove('on'));
    const out = h('div', {});
    for (const [id, [label, , fn]] of Object.entries(sections)) {
      if (id === 'about') continue;
      const sec = h('div', { class: 'set-sec' });
      try { await fn(sec); } catch { continue; }
      if (my !== searchSeq) return;
      let any = false;
      for (const r of [...sec.children]) {
        const hit = r.classList.contains('set-row') && r.textContent.toLowerCase().includes(q);
        if (hit) any = true; else r.remove();
      }
      if (any) out.append(h('h3', { class: 'set-sec-h' }, label), ...sec.children);
    }
    content.innerHTML = '';
    content.append(h('h2', {}, `Results for “${search.value.trim()}”`));
    if (!out.children.length) content.append(h('div', { class: 'hint' }, 'No settings match. Try another word, like “theme”, “delete” or “thumbnails”.'));
    content.append(...out.children);
    tidyRows(content);
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  nav.prepend(search);
  let lastShown = section;
  const show = async (id) => {
    lastShown = id;
    nav.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    content.innerHTML = '';
    content.append(h('h2', {}, sections[id][0]));
    await sections[id][2](content);
    tidyRows(content);
  };
  openSettingsSection = (id) => show(id);
  show(sections[section] ? section : 'general');
  if (opts.search) setTimeout(() => { search.value = opts.search; search.dispatchEvent(new Event('input')); }, 50);
  await modal({ title: 'Settings', body: h('div', { class: 'settings' }, nav, content), width: 860, className: 'settings-modal', noPadding: true });
}
// rows whose control is a block of several lines (the panel animations list, a group of check boxes) put it
// under the title at full width, instead of leaving empty space beside a tall column
function tidyRows(content) {
  const run = () => content.querySelectorAll('.set-row').forEach((r) => {
    const c = r.querySelector('.set-ctl');
    if (!c || r.classList.contains('stacked')) return;
    if (c.offsetHeight > 64) r.classList.add('stacked');
  });
  // some controls fill in a moment later (lists read from other modules)
  for (const ms of [0, 120, 400]) setTimeout(run, ms);
}
let settingsIdx = null;
export async function settingsIndex() { if (!settingsIdx) settingsIdx = await openSettings('general', { index: true }); return settingsIdx; }
let openSettingsSection = () => {};
