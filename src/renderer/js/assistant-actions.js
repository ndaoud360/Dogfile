// What the assistant does for each action it recognises (assistant-intents.js says which one). Each handler
// writes into the conversation card: what it did, or what it would do with a button to go ahead.
import { api, state, sys, bus, h, esc, toast, fmtSize, fmtDate, basename, dirname, pjoin, IS_WIN, KINDS, isVirtual, saveSettings, saveTags, saveLibrary } from './core.js';
import { icon } from './icons.js';
import { confirm } from './dialogs.js';
import { activeTab, navigate, selectedItems, loadTab, otherPaneTab, recompute, renderTabPanes, setView, renderAll } from './pane.js';
import * as A from './actions.js';
import { parseRequest } from './assistant-parse.js';
import { openTool, appAsk, activeAppTab } from './apptabs.js';

const btn = (label, run, cls = '') => h('button', { class: 'btn small ' + cls, onclick: run }, label);
const kindOf = (f) => { const e = (f.ext || (f.name || f.path || '').split('.').pop() || '').toLowerCase(); return KINDS.image.includes(e) ? 'image' : KINDS.video.includes(e) || ['mkv', 'm2ts', 'mts', 'vob'].includes(e) ? 'video' : KINDS.audio.includes(e) ? 'audio' : KINDS.archive.includes(e) ? 'archive' : 'other'; };
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const cmd = (id) => window.__atlas?.commands?.get(id);
const runCmd = (id) => { const c = cmd(id); if (c) return c.run(); };

// "yesterday at 3 PM", "last Tuesday", "2 hours ago", "this morning", "on 12 March" → a time
export function parseWhen(text, now = Date.now()) {
  const s = String(text).toLowerCase();
  const d = new Date(now);
  let day = null;
  if (/\byesterday\b/.test(s)) day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  else if (/\btoday|this (?:morning|afternoon|evening)\b/.test(s)) day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const ago = /\b(\d+|an?|one|two|three)\s*(minute|hour|day|week)s?\s+ago\b/.exec(s);
  if (ago) { const n = { a: 1, an: 1, one: 1, two: 2, three: 3 }[ago[1]] ?? +ago[1]; return now - n * { minute: 60e3, hour: 3600e3, day: 864e5, week: 6048e5 }[ago[2]]; }
  const wd = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].findIndex((w) => s.includes(w));
  if (wd >= 0 && !day) { const back = ((d.getDay() - wd + 7) % 7) || 7; day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back); }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const md = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})/.exec(s);
  if (md && !day) { const mi = months.indexOf(md[2] || md[3]); const dd = +(md[1] || md[4]); day = new Date(d.getFullYear(), mi, dd); if (day > d) day.setFullYear(day.getFullYear() - 1); }
  const tm = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b|\b(noon|midnight|morning|afternoon|evening|night)\b/.exec(s);
  if (!day && !tm) return null;
  day = day || new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (tm) {
    let hh, mm = 0;
    if (tm[10]) hh = { noon: 12, midnight: 0, morning: 9, afternoon: 15, evening: 19, night: 22 }[tm[10]];
    else { hh = +(tm[1] || tm[4] || tm[7]); mm = +(tm[2] || tm[5] || 0); const ap = tm[3] || tm[6] || tm[8] || ''; if (/^p/.test(ap) && hh < 12) hh += 12; if (/^a/.test(ap) && hh === 12) hh = 0; }
    day.setHours(hh, mm, 0, 0);
  } else day.setHours(23, 59, 59, 0);
  return day.getTime();
}

// open a file in Notepad / Photos / the Player in this window and wait until it's showing
export async function openInApp(app, path) {
  const t = openTool(app, [path], { inTab: true });
  const tab = t && typeof t.then !== 'function' ? t : activeAppTab();
  const name = basename(path).toLowerCase();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const cur = activeAppTab() || tab;
    if (!cur) continue;
    const c = await appAsk('context', null, cur, 1500).catch(() => null);
    if (c?.ok !== false && String(c?.name || '').toLowerCase() === name) return cur;
  }
  return activeAppTab();
}

// the files a request is about: the selection, else (when it says "here" / "this folder") the folder's files
async function filesFor(x, { exts = null, kind = null, wantFolderFiles = true } = {}) {
  const t = activeTab();
  let items = selectedItems(t).filter((i) => !i.virtual);
  if (!items.length && wantFolderFiles && t?.path && !isVirtual(t.path)) items = (t.items || []).filter((i) => !i.isDir);
  if (exts?.length) items = items.filter((i) => exts.includes((i.ext || '').toLowerCase()));
  if (kind) items = items.filter((i) => !i.isDir && kindOf(i) === kind);
  return items;
}

export const HANDLERS = {
  // ---------------- appearance & settings ----------------
  async glass(x, { say }) {
    state.settings.sidebarGlass = !!x.on; saveSettings(); bus.emit('settings');
    say(x.on ? 'Glass sidebar is on. On Windows the window turns see-through behind the sidebar after a new window (Ctrl+N) or a restart; until then the glass shows a soft colour wash. Right-click the sidebar to turn it off.' : 'Glass sidebar is off.');
  },
  async theme(x, { say, text }) {
    state.settings.theme = x.theme;
    const apps = /\b(apps?|notepad|photos|player|everything|all)\b/i.test(text);
    if (apps && state.settings.mediaTheme && state.settings.mediaTheme !== 'app') state.settings.mediaTheme = 'app';
    saveSettings(); bus.emit('settings');
    say(`${{ dark: 'Dark', light: 'Light', system: 'System' }[x.theme]} mode is on${apps ? '. Notepad, Photos and the Player follow it too' : ''}.`);
  },
  async density(x, { say }) { state.settings.density = x.density; saveSettings(); bus.emit('settings'); say(`Density: ${{ touch: 'Touch (bigger rows and buttons)', compact: 'Compact', comfortable: 'Comfortable', auto: 'Automatic (Touch on a touch screen without a mouse)' }[x.density]}.`); },
  async uiMode(x, { say }) { state.settings.uiMode = x.mode; saveSettings(); bus.emit('settings'); say(x.mode === 'simple' ? 'Simple mode is on: the ribbon shows the everyday buttons; the rest are in the command palette (Ctrl+Shift+P) and right-click > More.' : 'Full mode is on: every button is back on the ribbon.'); },
  async layout(x, { say }) {
    const done = [];
    if (x.panes) { const id = x.panes === 1 ? 'layout1' : x.panes === 2 ? (x.stacked ? 'layout2h' : 'layout2v') : x.panes === 3 ? 'layout3' : 'layout4'; runCmd(id); done.push({ layout1: 'one pane', layout2v: 'two panes side by side', layout2h: 'two panes stacked', layout3: 'three panes', layout4: 'four panes (2×2)' }[id]); }
    if (x.view) { await new Promise((r) => setTimeout(r, 100)); setView(activeTab(), x.view); done.push(`${x.view} view`); }
    if (x.sync != null) { const c = cmd('syncNav'); const on = typeof c?.check === 'function' ? !!c.check() : !!state.syncNav; if (on !== x.sync) runCmd('syncNav'); done.push(`synced browsing ${x.sync ? 'on' : 'off'}`); }
    say(done.length ? `Done: ${done.join(', ')}.` : 'Tell me how many panes (one to four), or “sync browsing on”.');
  },
  async view(x, { say }) { setView(activeTab(), x.view); say(`Switched to ${x.view} view.`); },
  async toggles(x, { say }) {
    const map = { showHidden: 'toggleHidden', showExtensions: 'toggleExt', folderSizes: 'toggleFolderSizes', checkboxes: 'toggleCheckboxes', showPreview: 'togglePreview' };
    const names = { showHidden: 'hidden files', showExtensions: 'file extensions', folderSizes: 'folder sizes', checkboxes: 'check boxes', showPreview: 'the preview pane', showStatusBar: 'the status bar', showSystem: 'protected system files', thumbnails: 'thumbnails' };
    const out = [];
    for (const [k, on] of Object.entries(x.set)) {
      const c = map[k] && cmd(map[k]);
      const cur = c?.check ? !!c.check() : !!state.settings[k];
      if (cur !== on) { if (c) c.run(); else { state.settings[k] = on; saveSettings(); bus.emit('settings'); renderAll(); } }
      out.push(`${on ? 'Showing' : 'Hiding'} ${names[k]}`);
    }
    say(out.join('. ') + '.' + (x.set.folderSizes ? ' Folder sizes appear in Details view and as badges under folders in Grid and List.' : ''));
  },
  async profile(x, { say, acts }) {
    const W = await import('./workspaces.js');
    if (!x.name) { W.profilesDialog(); return say('Here are your profiles.'); }
    try { await W.switchProfile(x.name); say(`Switched to the “${x.name}” profile.`); } catch (e) { say(`I couldn’t switch to “${x.name}”: ${e.message}`); }
    if (x.alts?.length) acts(...x.alts.map((n) => btn(`Use “${n}” instead`, async () => { await W.switchProfile(n); toast(`Profile: ${n}`); })), btn('All profiles…', () => W.profilesDialog()));
  },
  async workspace(x, { say, acts }) {
    const W = await import('./workspaces.js');
    if (x.save) {
      const name = x.name || `Workspace ${Object.keys(state.workspaces || {}).length + 1}`;
      state.workspaces[name] = await W.captureWorkspace({ files: state.projectFiles || [] });
      saveLibrary(); bus.emit('sidebar');
      const tabs = state.tabs.length;
      say(`Saved the workspace “${name}”: ${plural(tabs, 'tab')}, the pane layout and the open Notepad files. Open it again from the sidebar’s Workspaces or File > Workspaces.`);
      return;
    }
    const ws = x.name && state.workspaces?.[x.name];
    if (ws) { await W.openWorkspace(ws); say(`Opened the workspace “${x.name}”.`); } else { W.workspacesDialog(); say('Here are your workspaces.'); }
  },
  async exportSettings(x, { say }) { const S = await import('./settingsync.js'); S.exportSettings(); say('Pick where to save the backup file. It holds every setting, tag, colour, preset, pin and workspace; Settings > Data > Import brings it back on any PC.'); },
  async importSettings(x, { say }) { const S = await import('./settingsync.js'); S.importSettings(); say('Choose the settings file to bring in.'); },
  // ---------------- connections, macros, automations, collections ----------------
  async connect(x, { say, acts }) {
    const N = await import('./network.js');
    if (['gdrive', 'onedrive', 'dropbox', 's3'].includes(x.type)) {
      N.editConnection({ type: x.type });
      say(`Adding ${{ gdrive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', s3: 'an S3 bucket' }[x.type]}. No sync app needed: Dogfile signs in in your browser${x.type === 's3' ? ' (S3 uses an access key instead)' : ''} and the account shows in the sidebar under Network.` + (x.cloudOnlyNote ? ' Files from synced folders that are only in the cloud (OneDrive “online-only”) are left alone by searches and duplicate checks. They’re never downloaded just to be looked at.' : ''));
      acts(...['gdrive', 'onedrive', 'dropbox', 's3'].filter((k) => k !== x.type).map((k) => btn(`Add ${{ gdrive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', s3: 'S3' }[k]}`, () => N.editConnection({ type: k }))));
      return;
    }
    N.editConnection({ type: x.type });
    say(`Fill in the ${x.type === 'smb' ? 'NAS / Windows share (SMB)' : x.type.toUpperCase()} details; once saved it’s mounted in the sidebar under Network.`);
    if (x.both) acts(btn(x.type === 'smb' ? 'An SFTP server instead' : 'An SMB share instead', () => N.editConnection({ type: x.type === 'smb' ? 'sftp' : 'smb' })));
  },
  async macro(x, { say, acts }) {
    const M = await import('./macros.js');
    if (x.manage) { M.macrosManager(); return say('Here are your macros.'); }
    let trig = x.trigger;
    let folderTrig = null;
    if (trig?.folder || trig?.folderName) {
      const name = trig.folder || trig.folderName;
      const { resolveNamedFolderPublic } = await import('./assistant.js');
      const p = await resolveNamedFolderPublic(name);
      folderTrig = p ? { type: 'folder', folder: p } : null;
      if (trig.type === 'folder') trig = folderTrig;
    }
    const t0 = trig ? { ...trig } : null; if (t0) { delete t0.folder; delete t0.folderName; }
    await M.startRecording({ trigger: t0 });
    const when = t0?.type === 'schedule' ? (t0.mode === 'weekly' ? `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][t0.day]} at ${t0.at}` : t0.mode === 'daily' ? `every day at ${t0.at}` : `every ${t0.minutes} minutes`) : t0?.type === 'folder' ? `whenever new files land in ${basename(t0.folder)}` : t0?.type === 'startup' ? 'when Dogfile starts' : '';
    say(`Recording. Do the steps now (open folders, select, move, rename, run commands…), then press “Recording · Stop” in the status bar.${when ? ` When you save it, it’s set to run ${when} (while Dogfile is open).` : ''}`);
    if (folderTrig && t0?.type !== 'folder') acts(btn(`Run it when files land in ${basename(folderTrig.folder)} instead`, (e) => { M.setRecordingTrigger(folderTrig); e.target.disabled = true; toast(`It will run when new files land in ${basename(folderTrig.folder)}`); }));
    acts(btn('Stop recording', () => M.stopRecording()));
  },
  async automation(x, { say, acts, text, ctx }) {
    const plan = parseRequest(text, { hasSelection: false });
    const k = sys.known || {};
    let folder = plan.scope && k[plan.scope] ? k[plan.scope] : null;
    if (!folder && plan.folderName) { const { resolveNamedFolderPublic } = await import('./assistant.js'); folder = await resolveNamedFolderPublic(plan.folderName); }
    if (!folder) { const t = activeTab(); folder = t?.path && !isVirtual(t.path) ? t.path : null; }
    if (!folder) return say('Open the folder you want to automate (or name it: “for my Downloads folder”), then ask again.');
    const { describeRule } = await import('./organize.js');
    if (!x.rules.length) { const R = await import('./rules.js'); R.automationDialog(folder); return say(`Opening the automation for “${basename(folder)}”, I couldn’t tell the rules from the request, so add them there.`); }
    say(`For “${basename(folder)}”, whenever new files arrive:`);
    ctx.card.append(h('ul', { class: 'as-steps' }, ...x.rules.map((r) => h('li', { class: 'ok' }, h('span', { class: 'as-step-ic', html: icon('automation') }), h('span', {}, describeRule(r))))));
    const R = await import('./rules.js');
    acts(btn('Review & save…', () => R.automationDialog(folder, { rules: x.rules }), 'primary'));
    R.automationDialog(folder, { rules: x.rules });
  },
  async collection(x, { say, text }) {
    const C = await import('./collections.js');
    // tags named in the request that don't exist yet are created ("Urgent")
    for (const name of x.tags) if (!state.tags.defs.some((d) => d.id === name || d.name.toLowerCase() === String(name).toLowerCase())) { state.tags.defs.push({ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: name[0].toUpperCase() + name.slice(1), color: '#e5484d' }); saveTags(); bus.emit('tags'); }
    const name = (/\b(?:called|named)\s+["“']?([^"”']+)["”']?/i.exec(text) || [])[1] || [x.tags.length ? x.tags.map((t) => t[0].toUpperCase() + t.slice(1)).join(' or ') : '', x.stars ? `${x.stars}★` : ''].filter(Boolean).join(' or ') || 'My collection';
    const c = { id: 'c' + Date.now().toString(36), name, icon: x.stars ? 'star' : 'collection', where: 'personal', kinds: [], tags: x.tags, minRating: x.stars || 0 };
    C.collections().push(c); saveSettings(); bus.emit('collections');
    say(`Made the smart collection “${name}” in the sidebar: ${C.describeCollection(c).replace(/^files · /, 'files ').replace(/ · /g, ', ')}. It updates whenever you tag or rate something (ratings are in the preview pane).`);
    C.openCollection(c);
  },
  // ---------------- tags, ratings, notes, properties ----------------
  async writeTags(x, { say }) {
    const items = await filesFor(x, { wantFolderFiles: false });
    if (!items.length) return say('Select the files first (JPG, PNG, Word, Excel, PowerPoint, PDF, MP3…), then ask again.');
    const { writeTagsIntoFiles } = await import('./core.js');
    const r = await writeTagsIntoFiles(items.filter((i) => !i.isDir).map((i) => i.path));
    if (!state.settings.tagsInFiles) say(`Wrote the tags into ${plural(items.length, 'file')}. To do this every time you tag something, turn on Settings > Files > “Write tags into the files”.`);
    else say(`Wrote the tags into ${plural(items.length, 'file')}. Explorer shows them in Properties > Details > Tags.`);
    if (r && r.failed) say(`${r.failed} couldn’t take tags: ${r.last || 'that kind of file has no place for them'}.`);
  },
  async autoTag(x, { say }) {
    const t = activeTab();
    const items = selectedItems(t);
    const paths = items.length ? items.map((i) => i.path) : t?.path && !isVirtual(t.path) ? [t.path] : [];
    if (!paths.length) return say('Open the folder (or select the files) to tag, then ask again.');
    A.autoTagDialog(paths);
    say(`Choose which ${items.length ? 'selected files' : `files in “${basename(t.path)}”`} get which tag (pictures, videos, music, documents, big or old files). “Song details” fills in artist, album and cover for songs, and “Keep doing this” tags new files automatically.`);
  },
  async rate(x, { say }) {
    const items = await filesFor(x, { wantFolderFiles: false });
    if (!items.length) return say('Select the files to rate first, then ask again.');
    const D = await import('./docpreview.js'); await D.loadNotes();
    for (const it of items) D.setNote(it.path, { ...(x.stars != null ? { rating: x.stars } : {}), ...(x.label ? { label: x.label } : {}) });
    bus.emit('preview');
    say(`${x.stars != null ? `${x.stars ? '★'.repeat(x.stars) + ' ' : 'No stars '}` : ''}${x.label ? `${x.stars != null ? 'and a ' : ''}${x.label} label ` : ''}on ${plural(items.length, 'file')}. You see them in the preview pane; a smart collection can gather them (“make a collection of files rated 5 stars”).`);
  },
  async note(x, { say }) {
    const items = await filesFor(x, { wantFolderFiles: false });
    if (!items.length) return say('Select the file the note is for, then ask again.');
    if (!x.text) return say('What should the note say? For example: add a note saying “Waiting on the signature”.');
    const D = await import('./docpreview.js'); await D.loadNotes();
    for (const it of items) { const cur = D.noteOf(it.path)?.text; D.setNote(it.path, { text: cur ? `${cur}\n${x.text}` : x.text }); }
    bus.emit('preview');
    say(`Added the note “${x.text}” to ${items.length === 1 ? items[0].name : plural(items.length, 'file')}. It shows in the preview pane and follows the file when you move or rename it in Dogfile.`);
  },
  async folderNote(x, { say }) {
    const t = activeTab();
    if (!t?.path || isVirtual(t.path)) return say('Open the folder first, then ask again.');
    const p = pjoin(t.path, '.folder.md');
    const cur = await api('fs:readText', p, 256 * 1024).then((r) => r.text).catch(() => null);
    const add = x.items.length ? x.items.map((i) => `- [ ] ${i}`).join('\n') : x.text;
    if (!add && cur != null) { bus.emit('addFolderNote', t); return say('Here’s the folder note. Edit it at the top of the folder.'); }
    const body = cur != null ? `${cur.replace(/\s+$/, '')}\n\n${add}\n` : `# ${basename(t.path) || 'Notes'}\n\n${add || 'Notes about this folder.'}\n`;
    await api('fs:writeText', p, body);
    bus.emit('refreshPanes');
    say(`${cur != null ? 'Added to' : 'Made'} the note at the top of “${basename(t.path)}”${x.items.length ? ` with a checklist of ${plural(x.items.length, 'item')}` : ''}. Tick the boxes right there; Ctrl+S saves when you edit it.`);
  },
  async docProps(x, { say }) {
    const items = (await filesFor(x, { wantFolderFiles: false })).filter((i) => /^(docx|xlsx|pptx|pdf|docm|xlsm|pptm|odt|ods|odp)$/i.test(i.ext || ''));
    if (!items.length) return say('Select the Word, Excel, PowerPoint or PDF files first, then ask again.');
    const D = await import('./docpreview.js');
    say(`Opening the properties of ${items.length === 1 ? items[0].name : `${items.length} documents, one after another`}. Change ${x.fields.join(' and ')} and press Save. It’s written inside the file, so Office and Windows see it too.`);
    (async () => { for (const it of items.slice(0, 20)) await D.editDocProps(it); })();
  },
  async songDetails(x, { say }) {
    const items = (await filesFor(x, { wantFolderFiles: true })).filter((i) => kindOf(i) === 'audio');
    if (!items.length) return say('Select the songs (or open their folder), then ask again.');
    const T = await import('./tageditor.js');
    T.openTagEditor(items.map((i) => i.path));
    say(x.identify ? `Opened the tag editor for ${plural(items.length, 'song')}. “Identify by sound” listens to the audio and asks AcoustID (a free key in Settings > Tools & apps). It works even when the file has no name or tags.` : `Opened the tag editor for ${plural(items.length, 'song')}. “Look up online” finds artist, album, year and cover art on MusicBrainz and iTunes; pick the right match and save.`);
  },
  async analyzeAudio(x, { say }) {
    const sel = selectedItems(activeTab()).filter((i) => kindOf(i) === 'audio');
    if (sel.length) { const M = await import('./mediatools.js'); M.analyzeDialog(sel.map((i) => i.path)); return say(`Finding the tempo and key of ${plural(sel.length, 'song')}…`); }
    const G = await import('./gallery.js'); G.analyzeFolder(activeTab());
    say('Analysing every song in this folder. BPM and key (with the Camelot code) appear as columns and in the media filter; they’re remembered, so it only happens once per song.');
  },
  // ---------------- archives ----------------
  async archiveDelete(x, { say, acts }) {
    const t = activeTab();
    const arc = selectedItems(t).find((i) => kindOf(i) === 'archive')?.path || A.arcOf(t.path)?.arc;
    if (!arc) return say('Select the archive (or open it), then ask again.');
    const r = await api('archive:list', arc).catch((e) => ({ error: e.message }));
    const list = r.items || r;
    if (!Array.isArray(list)) return say(`I couldn’t read the archive: ${r.error || ''}`);
    const want = x.name.toLowerCase().replace(/^\*\./, '.');
    const hits = list.filter((e) => { const n = (e.path || e.name || '').split('/').pop().toLowerCase(); return n === want || (want.startsWith('.') && n.endsWith(want)) || (e.path || '').toLowerCase() === want; });
    if (!hits.length) return say(`There’s no “${x.name}” in ${basename(arc)}.`);
    say(`${basename(arc)} has ${plural(hits.length, 'entry')} named “${x.name}”${hits.length > 1 ? ' (in different folders)' : ''}. Removing doesn’t unpack the rest.`);
    acts(btn(`Remove ${hits.length === 1 ? 'it' : `all ${hits.length}`}`, async (e) => {
      e.target.disabled = true;
      const j = await A.runJob({ type: 'archiveDelete', sources: [], dest: arc, opts: { entries: hits.map((h2) => h2.path || h2.name) } });
      A.invalidateArchiveCache?.(arc);
      say(j.status === 'done' ? `Removed from ${basename(arc)}.` : `Couldn’t remove it: ${j.errors?.[0] || j.error || ''}`);
    }, 'primary danger'));
  },
  async convertArchive(x, { say }) {
    const items = selectedItems(activeTab()).filter((i) => kindOf(i) === 'archive');
    if (!items.length && !A.arcOf(activeTab()?.path)) return say('Select the archive to convert, then ask again.');
    say(`Converting ${items.length ? items.map((i) => i.name).join(', ') : 'this archive'} to ${x.format.toUpperCase()}. The new file is saved next to it and the original stays.`);
    A.convertArchive(items, x.format);
  },
  async testArchive(x, { say }) {
    const items = selectedItems(activeTab()).filter((i) => kindOf(i) === 'archive');
    const arcs = items.length ? items.map((i) => i.path) : A.arcOf(activeTab()?.path) ? [A.arcOf(activeTab().path).arc] : [];
    if (!arcs.length) return say('Select the archive to test, then ask again.');
    for (const a of arcs) { say(`Testing ${basename(a)}…`); const r = await api('archive:test', a).catch((e) => ({ ok: false, message: e.message })); say(`${basename(a)}: ${r.ok ? '✓ every file inside reads back correctly' : '✗ problems found'}${r.message ? ` (${r.message})` : ''}.`); }
  },
  async extract(x, { say }) {
    const items = selectedItems(activeTab()).filter((i) => kindOf(i) === 'archive');
    if (!items.length) return say('Select the .zip / .rar / .7z / .iso to extract, then ask again.');
    say(`Extracting ${items.length === 1 ? items[0].name : plural(items.length, 'archive')} ${x.ownFolder ? 'into a new folder named after it' : 'here (into a folder only when the archive holds several things at the top)'}.`);
    A.extract(items, x.ownFolder ? 'folder' : x.here ? 'here' : 'smart');
  },
  // ---------------- versions, history, checksums ----------------
  async snapshot(x, { say }) {
    const items = (await filesFor(x, { wantFolderFiles: false }));
    if (!items.length) return say('Select the file to keep a version of, then ask again.');
    for (const it of items) await api('versions:save', it.path, x.note || 'Saved by the assistant');
    bus.emit('history', { kind: 'version', title: `Saved a version of ${items.length === 1 ? items[0].name : plural(items.length, 'file')}`, paths: items.map((i) => [i.path]) });
    say(`Saved a version of ${items.length === 1 ? items[0].name : plural(items.length, 'file')}${x.note ? ` (“${x.note}”)` : ''}. Right-click > Versions of this file… brings it back any time.`);
  },
  async trackVersions(x, { say }) {
    const items = (await filesFor(x, { wantFolderFiles: false })).filter((i) => !i.isDir);
    if (!items.length) return say('Select the file (or files) to keep versions of, then ask again.');
    const s = new Set(state.settings.trackedFiles || []);
    for (const it of items) (x.on ? s.add(it.path) : s.delete(it.path));
    state.settings.trackedFiles = [...s]; saveSettings(); api('versions:track', state.settings.trackedFiles).catch(() => {});
    say(x.on ? `Automatic versions are on for ${items.length === 1 ? items[0].name : plural(items.length, 'file')}: every time it’s saved, the previous state is kept (up to ${state.settings.versionsKeep || 20}). Right-click > Versions of this file… shows them.` : `Automatic versions are off for ${items.length === 1 ? items[0].name : plural(items.length, 'file')}.`);
  },
  async restoreVersion(x, { say, acts }) {
    const items = (await filesFor(x, { wantFolderFiles: false })).filter((i) => !i.isDir);
    if (items.length !== 1) return say('Select the one file to restore, then ask again.');
    const p = items[0].path;
    const vs = await api('versions:list', p).catch(() => []);
    if (!vs.length) return say(`There are no saved versions of ${items[0].name}. Turn on automatic versions for it (“keep versions of this file”) so there are next time.`);
    const when = parseWhen(x.when);
    const pick = when ? vs.filter((v) => v.at <= when + 5 * 60e3).sort((a, b) => b.at - a.at)[0] || vs.slice().sort((a, b) => Math.abs(a.at - when) - Math.abs(b.at - when))[0] : vs[0];
    say(`The version closest to ${when ? new Date(when).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : 'what you asked'} is from ${fmtDate(pick.at)} (${fmtSize(pick.size || 0)}${pick.note ? `, “${pick.note}”` : ''}).`);
    acts(btn('Restore it', async (e) => { if (!(await confirm('Restore this version?', `The current ${esc(items[0].name)} is saved as a version first, so you can come back to it.`, { ok: 'Restore' }))) return; e.target.disabled = true; await api('versions:restore', p, pick.id); bus.emit('refreshPanes'); say('Restored.'); }, 'primary'),
      btn('Save it as a copy', async () => { const out = await api('versions:restore', p, pick.id, { asCopy: true }); say(`Saved as “${basename(out)}”.`); bus.emit('refreshPanes'); }),
      btn('All versions…', () => import('./history.js').then((m) => m.versionsDialog(p))));
  },
  async makeChecksums(x, { say }) {
    const t = activeTab();
    let items = selectedItems(t);
    if (!items.length && t?.path && !isVirtual(t.path)) items = (t.items || []).filter((i) => !i.isDir && !/\.(sha256|sha1|md5)$/i.test(i.name));
    if (!items.length) return say('Open the folder (or select the files), then ask again.');
    const H = await import('./history.js');
    say(`Making a checksum file for ${plural(items.length, 'item')}. Keep it with the files; “verify this checksum file” later tells you if anything changed or got corrupted.`);
    H.createChecksums(items);
  },
  async verifyChecksums(x, { say }) {
    const t = activeTab();
    const sel = selectedItems(t).find((i) => /\.(sha256|sha1|md5|sfv)$/i.test(i.name)) || (t.items || []).find((i) => /\.(sha256|sha1|md5|sfv)$/i.test(i.name));
    const H = await import('./history.js');
    if (!sel) { say('Pick the checksum file to check.'); return H.verifyChecksums(); }
    say(`Checking every file listed in ${sel.name}…`);
    H.verifyChecksums(sel.path);
  },
  async history(x, { say, acts }) {
    const H = await import('./history.js');
    if (!x.undo) { H.historyDialog(); return say('Here’s everything that happened to your files, newest first. Anything that can still be undone has an Undo button.'); }
    const all = await H.historyEntries();
    const target = x.minutesAgo ? Date.now() - x.minutesAgo * 60e3 : null;
    let list = all.filter((e) => H.canUndoEntry(e) && (!x.what || e.rec.type === x.what));
    if (x.folder) { const f = list.filter((e) => /folder/i.test(e.title || '') || (e.rec.pairs || []).some(([a]) => !/\.[a-z0-9]{1,6}$/i.test(a))); if (f.length) list = f; }
    if (target) list.sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target));
    const e = list[0];
    H.historyDialog();
    if (!e) return say('I couldn’t find anything like that which can still be undone. The history window is open so you can look.');
    const mins = Math.round((Date.now() - e.at) / 60e3);
    say(`Found it: “${e.title}” ${mins < 1 ? 'just now' : mins < 120 ? `${mins} min ago` : `at ${new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}${e.rec.pairs?.length === 1 ? ` (${basename(e.rec.pairs[0][0])} → ${basename(e.rec.pairs[0][1])})` : ''}.`);
    acts(btn('Undo it', async (ev) => { ev.target.disabled = true; try { await H.undoEntry(e); say('Undone.'); } catch (err) { say(`Couldn’t undo: ${err.message}`); } }, 'primary'));
  },
  async reminders(x, { say }) {
    const R = await import('./reminders.js');
    const items = selectedItems(activeTab()).filter((i) => !i.isDir);
    if (x.about && items.length === 1) { R.remindAbout(items[0]); return say(`Reading ${items[0].name} for its expiry date…`); }
    R.openReminders();
    say(R.remCfg().enabled ? 'Here are your document reminders.' : 'Turn on document reminders here: Dogfile will look through your Downloads and Documents for passports, licences, insurance, warranties and bills, and remind you before they expire.');
  },
  async whoLocks(x, { say }) {
    const items = selectedItems(activeTab());
    if (!items.length) return say('Select the file that won’t delete or move, then ask again.');
    const E = await import('./extras.js');
    E.showLocks(items.map((i) => i.path));
    say(`Checking which programs have ${items.length === 1 ? items[0].name : plural(items.length, 'item')} open. Close the program shown (or end it from the list), then try again.`);
  },
  // ---------------- pictures, songs & videos ----------------
  async similarTo(x, { say }) {
    const t = activeTab();
    const it = selectedItems(t).find((i) => kindOf(i) === 'image');
    if (!it) return say('Select the picture to match, then ask again.');
    const MM = await import('./mediameta.js');
    let hash = MM.metaOf(it)?.hash;
    if (!hash) { const img = await new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = /\.(jpe?g|png|gif|webp|bmp|avif|jfif)$/i.test(it.path) ? `/f/?p=${encodeURIComponent(it.path)}` : `/media/thumb?p=${encodeURIComponent(it.path)}&w=128`; }); hash = img && MM.analyzeImage(img, it)?.hash; }
    if (!hash) return say('I couldn’t read that picture.');
    t.mf = { ...(t.mf || {}), similar: hash };
    setView(t, 'gallery');
    say(`Showing the pictures in this folder that look like ${it.name} (same layout and tones). The media filter’s × clears it.`);
  },
  async similarPics(x, { say, text }) {
    const plan = parseRequest(text);
    const k = sys.known || {};
    if (plan.scope && k[plan.scope]) await navigate(activeTab(), k[plan.scope]);
    const T = await import('./tools.js');
    T.findSimilarImages();
    say('Looking for sets of near-identical pictures (bursts, edits, resized copies). In each set the best copy stays unticked; review, then recycle the rest.');
  },
  async similarMedia(x, { say }) { const G = await import('./gallery.js'); G.findSimilarMedia(activeTab()); say('Looking for videos and songs that are the same recording (same length and frames, or same length, tempo and key).'); },
  async classifyPics(x, { say, ctx }) {
    const t = activeTab();
    const pics = (t.items || []).filter((i) => !i.isDir && kindOf(i) === 'image');
    if (!pics.length) return say('There are no pictures in this folder.');
    const MM = await import('./mediameta.js');
    await MM.ensureMeta(pics, { audio: false });
    const groups = new Map();
    for (const p of pics) { const g = MM.galleryKind(p); groups.set(g, (groups.get(g) || 0) + 1); }
    say(`${plural(pics.length, 'picture')} in “${basename(t.path)}”:`);
    const key = { Screenshots: 'screenshots', 'Camera photos': 'camera', 'Artwork & graphics': 'artwork' };
    ctx.card.append(h('div', { class: 'as-acts' }, ...[...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => btn(`${g} · ${n}`, () => { if (!key[g]) return; t.mf = { ...(t.mf || {}), kind: key[g] }; recompute(t); renderTabPanes(t); }, key[g] ? '' : 'disabled'))));
    say('Press one to show only those. Gallery view (Ctrl+Shift+6) groups them the same way.');
  },
  async convertImages(x, { say, acts, text }) {
    const plan = parseRequest(text, { hasSelection: !!selectedItems(activeTab()).length });
    let items = await filesFor(x, { wantFolderFiles: true });
    const exts = plan.exts.filter((e) => e !== x.format && !(x.format === 'jpg' && e === 'jpeg'));
    items = items.filter((i) => kindOf(i) === 'image' && (exts.length ? exts.includes((i.ext || '').toLowerCase()) : (i.ext || '').toLowerCase() !== x.format));
    if (!items.length) return say(`There are no ${exts.length ? exts.map((e) => '.' + e).join(' / ') : ''} pictures here to convert.`);
    say(`${plural(items.length, 'picture')} to save as ${x.format.toUpperCase()}${x.maxSide ? ` (at most ${x.maxSide} px)` : ''}. Copies next to the originals, which stay.`);
    const M = await import('./mediatools.js');
    acts(btn(`Convert ${items.length}`, async (e) => { e.target.disabled = true; await M.convertImages(items.map((i) => i.path), x.format, { maxSide: x.maxSide }); say('Done.'); }, 'primary'));
  },
  async convertMedia(x, { say, acts, text }) {
    const plan = parseRequest(text, { hasSelection: !!selectedItems(activeTab()).length });
    let items = await filesFor(x, { wantFolderFiles: true });
    const exts = plan.exts.filter((e) => e !== x.format);
    items = items.filter((i) => ['audio', 'video'].includes(kindOf(i)) && (exts.length ? exts.includes((i.ext || '').toLowerCase()) : (i.ext || '').toLowerCase() !== x.format));
    if (!items.length) return say('There are no matching songs or videos here to convert.');
    say(`${plural(items.length, 'file')} to convert to ${x.format.toUpperCase()}${x.bitrate ? ` at ${x.bitrate} kbps` : ''}. New files next to the originals.`);
    const M = await import('./mediatools.js');
    acts(btn(`Convert ${items.length}`, async (e) => { e.target.disabled = true; const made = await M.convertMedia(items.map((i) => i.path), x.format, { bitrate: x.bitrate }); say(`Done: ${plural(made?.length || 0, 'file')}.`); }, 'primary'));
  },
  async transformPics(x, { say, acts }) {
    const items = (await filesFor(x, { wantFolderFiles: false })).filter((i) => kindOf(i) === 'image');
    if (!items.length) return say('Select the photos to turn, then ask again.');
    const what = [x.rotate ? `rotate ${Math.abs(x.rotate)}° ${x.rotate < 0 ? 'anticlockwise' : 'clockwise'}` : '', x.flipH ? 'flip horizontally' : '', x.flipV ? 'flip vertically' : ''].filter(Boolean).join(' and ');
    say(`I’ll ${what} ${plural(items.length, 'photo')}, in place. A version of each is saved first (right-click > Versions… to go back).`);
    const M = await import('./mediatools.js');
    acts(btn('Do it', async (e) => { e.target.disabled = true; const n = await M.transformImages(items.map((i) => i.path), x); say(`Done: ${plural(n, 'photo')}.`); }, 'primary'));
  },
  async contactSheet(x, { say }) {
    let items = selectedItems(activeTab()).filter((i) => kindOf(i) === 'video');
    const app = activeAppTab();
    if (!items.length && app?.app === 'player') { const c = await appAsk('context', null, app); if (c?.path) items = [{ path: c.path, name: c.name, ext: c.path.split('.').pop() }]; }
    if (!items.length) return say('Select the video (or play it in the Player), then ask again.');
    const G = await import('./gallery.js');
    say(`Making a contact sheet (a grid of frames with the times) for ${items.length === 1 ? items[0].name : plural(items.length, 'video')}; it’s saved as a JPG next to the video.`);
    G.contactSheets(items);
  },
  // ---------------- disk space ----------------
  async analyze(x, { say, text }) {
    const plan = parseRequest(text);
    const t = activeTab();
    const path = plan.scope?.startsWith('drive:') ? `${plan.scope.slice(6)}:\\` : plan.scope && sys.known?.[plan.scope] ? sys.known[plan.scope] : t?.path && !isVirtual(t.path) ? t.path : undefined;
    const T = await import('./tools.js');
    T.analyzeSpace(path);
    say(`Opening the disk space treemap${path ? ` for ${path}` : ''}. Bigger boxes are bigger folders; click into one, right-click to act on it.`);
  },
  async selSize(x, { say }) {
    const items = selectedItems(activeTab());
    if (!items.length) return say('Select something first.');
    const T = await import('./tools.js');
    T.analyzeSelection();
    const files = items.filter((i) => !i.isDir);
    say(`${plural(items.length, 'item')} selected${files.length ? ` · the files alone are ${fmtSize(files.reduce((a, f) => a + (f.size || 0), 0))}` : ''}. The exact total including everything inside the folders is being added up now.`);
  },
  async cleanup(x, { say, text }) {
    const plan = parseRequest(text);
    const t = activeTab();
    const root = plan.scope === 'here' && t?.path && !isVirtual(t.path) ? t.path : plan.scope?.startsWith('drive:') ? `${plan.scope.slice(6)}:\\` : plan.scope && sys.known?.[plan.scope] ? sys.known[plan.scope] : undefined;
    const C = await import('./cleanup.js');
    C.openCleanup(root);
    say(`Opening Storage cleanup${root ? ` for “${basename(root) || root}”` : ''}: the space by folder, by type and by age, plus duplicates, old installers and temporary files. Nothing is deleted until you review it.`);
  },
  async emptyRecycle(x, { say, acts }) {
    const list = await api('recycle:list').catch(() => []);
    const total = list.reduce((a, i) => a + (i.size || 0), 0);
    if (!list.length) return say('The Recycle Bin is already empty.');
    say(`The Recycle Bin holds ${plural(list.length, 'item')} (${fmtSize(total)}).`);
    acts(btn(`Empty it and free ${fmtSize(total)}`, async (e) => {
      if (!(await confirm('Empty the Recycle Bin?', `${plural(list.length, 'item')} (${fmtSize(total)}) will be deleted for good. This can’t be undone.`, { ok: 'Empty', danger: true }))) return;
      e.target.disabled = true;
      await api('recycle:empty');
      const after = await api('recycle:list').catch(() => []);
      say(`Done. Recovered ${fmtSize(total - after.reduce((a, i) => a + (i.size || 0), 0))}.`);
      bus.emit('refreshPanes');
    }, 'primary danger'));
  },
  // ---------------- moving & linking ----------------
  async toOtherPane(x, { say }) {
    const t = activeTab(); const o = otherPaneTab();
    const items = selectedItems(t);
    if (!o || isVirtual(o.path)) return say('Open a second pane on the folder to copy into (F3 or Ctrl+Alt+2), then ask again.');
    if (!items.length) return say('Select the files to copy first.');
    const how = { newer: 'skipping identical files and replacing only older ones', skipIdentical: 'skipping identical files and replacing the rest', keepBoth: 'keeping both when a name is taken', skip: 'skipping files already there', replace: 'replacing what’s there' }[x.conflict] || '';
    say(`${x.mode === 'move' ? 'Moving' : 'Copying'} ${plural(items.length, 'item')} to “${basename(o.path) || o.path}”${how ? `, ${how}` : ''}.`);
    A.transfer(items.map((i) => i.path), o.path, x.mode, x.conflict ? { conflict: x.conflict } : {}).then((j) => { if (j?.status) say(j.status === 'done' ? `Done${j.skipped ? ` (${j.skipped} skipped)` : ''}. Ctrl+Z undoes it.` : `Finished: ${j.status}${j.errors?.[0] ? `, ${j.errors[0]}` : ''}`); });
  },
  async symlink(x, { say }) {
    const t = activeTab();
    const it = selectedItems(t)[0] || (t?.path && !isVirtual(t.path) ? { path: t.path, name: basename(t.path), isDir: true } : null);
    if (!it) return say('Select the file or folder to link to, then ask again.');
    const k = sys.known || {};
    const destDir = x.where === 'desktop' ? k.desktop : x.where === 'documents' ? k.documents : x.where === 'other' ? otherPaneTab()?.path : null;
    if (!destDir) { A.createSymlink([it]); return say('Choose where the link goes.'); }
    try {
      const lp = await api('fs:uniqueName', destDir, it.name, 'number');
      await api('fs:symlink', it.path, lp, it.isDir ? 'junction' : 'file');
      A.pushUndo({ type: 'created', paths: [lp] }, 'Create link');
      say(`Made a ${it.isDir ? 'folder link (junction)' : 'symbolic link'} to “${it.name}” on your ${x.where === 'other' ? 'other pane' : x.where}: ${lp}. Opening it opens the real ${it.isDir ? 'folder' : 'file'}; deleting the link leaves the original alone.`);
    } catch (e) { say(`Couldn’t make the link: ${e.message}${it.isDir ? '' : ' (file links need Developer Mode or administrator rights on Windows)'}`); }
  },
  async declutter(x, { say }) { const D = await import('./declutter.js'); D.declutter(activeTab()); say('Here’s the plan for this folder: where each file would go and why. Change any destination, untick what should stay, then apply, Ctrl+Z puts everything back.'); },
  async viewGroup(x, { say }) {
    const id = x.by === 'none' ? 'groupNone' : 'group_' + x.by;
    runCmd(id);
    say(x.by === 'none' ? 'Grouping is off.' : `Grouped this view by ${{ type: 'file type', date: 'date', size: 'size', tag: 'tag', name: 'name' }[x.by]}.${x.alsoTag ? ' To group by tag instead, say “group by tag”.' : ''}`);
  },
  async flatten(x, { say }) { runCmd('flatten'); say('Showing every file from all the subfolders in one list. Going back (Alt+←) returns to the normal folder.'); },
  // ---------------- terminal, scripts, git, editors ----------------
  async adminShell(x, { say }) { const t = activeTab(); await A.openTerminal(t, x.kind, true); say(`Opening ${x.kind === 'cmd' ? 'Command Prompt' : 'PowerShell'} as administrator in “${basename(t?.path || '') || 'this folder'}”, Windows asks for permission first.`); },
  async runScript(x, { say }) {
    const t = activeTab();
    const scripts = selectedItems(t).filter((i) => /\.(ps1|py|bat|cmd|sh|js|mjs|rb|pl)$/i.test(i.name));
    if (!scripts.length) return say('Select the script (.ps1, .py, .bat, .cmd, .sh, .js), then ask again.');
    const E = await import('./extras.js');
    for (const s of scripts) await E.runInTerminal({ command: E.scriptCommand(s.path), cwd: dirname(s.path) });
    say(`Running ${scripts.map((s) => s.name).join(', ')} in the terminal below. You see everything it prints, and Ctrl+C stops it.`);
  },
  async terminal(x, { say }) {
    const t = activeTab();
    const cwd = t?.path && !isVirtual(t.path) ? t.path : sys.known?.home;
    if (x.drawer) { const E = await import('./extras.js'); await E.openTerminalAt(cwd); say(`The terminal is open in “${basename(cwd) || cwd}”. Ctrl+\` hides it; it follows the folder you browse to (Settings > Tools).`); }
    else { await A.openTerminal(t, x.kind); say(`Opened a terminal window in “${basename(cwd) || cwd}”.`); }
  },
  async copyPaths(x, { say, acts }) {
    const items = selectedItems(activeTab());
    if (!items.length) return say('Select the files first.');
    const fmt = (f) => { const ps = items.map((i) => i.path); if (f === 'json') return JSON.stringify(ps.map((p) => p.replace(/\\/g, '/')), null, 2); if (f === 'quoted') return ps.map((p) => `"${p}"`).join(' '); if (f === 'forward') return ps.map((p) => p.replace(/\\/g, '/')).join('\n'); if (f === 'names') return items.map((i) => i.name).join('\n'); return ps.join('\n'); };
    await api('clip:writeText', fmt(x.fmt));
    say(`Copied ${plural(items.length, 'path')} ${{ json: 'as a JSON array', quoted: 'in quotes', forward: 'with forward slashes', names: '(names only)', path: '' }[x.fmt]}.`);
    const others = ['path', 'forward', 'json', 'quoted'].filter((f) => f !== x.fmt);
    acts(...others.map((f) => btn({ path: 'As Windows paths', forward: 'Forward slashes', json: 'JSON array', quoted: 'Quoted list' }[f], async () => { await api('clip:writeText', fmt(f)); toast('Copied'); })));
  },
  async gitStatus(x, { say, ctx, showInTab }) {
    const t = activeTab();
    if (!t?.path || isVirtual(t.path)) return say('Open a folder inside the repository first.');
    const r = await api('git:status', t.path).catch((e) => ({ error: e.message }));
    if (!r || r.error || !r.branch && !r.files) return say(`This folder isn’t in a Git repository${r?.error ? ` (${r.error})` : ''}.`);
    const files = Object.entries(r.files || {});
    if (!files.length) return say(`Branch ${r.branch}: nothing uncommitted. The working tree is clean.`);
    const label = { M: 'changed', A: 'added', D: 'deleted', '?': 'new, not tracked', R: 'renamed', U: 'conflict' };
    say(`Branch ${r.branch}: ${plural(files.length, 'file')} with uncommitted changes:`);
    ctx.card.append(h('div', { class: 'as-files' }, ...files.slice(0, 60).map(([p, st]) => h('div', { class: 'as-file', title: p, onclick: () => navigate(activeTab(), dirname(p), { select: p }) }, h('span', { class: 'as-chip' }, st), h('div', { class: 'as-fn' }, h('b', {}, basename(p)), h('span', { class: 'hint' }, `${label[st[0]] || st} · ${basename(dirname(p))}`))))));
    if (files.length > 60) say(`…and ${files.length - 60} more.`);
  },
  async codeEditor(x, { say }) {
    const t = activeTab();
    const sel = selectedItems(t);
    const items = sel.length ? sel : t?.path && !isVirtual(t.path) ? [{ path: t.path, name: basename(t.path), isDir: true }] : [];
    if (!items.length) return say('Open the folder first.');
    await A.openInEditor(items, t);
    say(`Opening ${items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item')} in your code editor (VS Code, Cursor, Sublime or Notepad++. Whichever is installed, or the one set in Settings > Tools).`);
  },
  async hex(x, { say, ctx }) {
    const it = selectedItems(activeTab()).find((i) => !i.isDir);
    if (!it) return say('Select the file to look inside, then ask again.');
    const bytes = await api('fs:readBytes', it.path, 512).catch(() => null);
    if (!bytes) return say('I couldn’t read that file.');
    const lines = [];
    for (let o = 0; o < bytes.length; o += 16) { const row = bytes.slice(o, o + 16); lines.push(`${o.toString(16).padStart(8, '0')}  ${row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')}  ${row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`); }
    say(`The first ${bytes.length} bytes of ${it.name}${/^4d5a/.test(bytes.slice(0, 2).map((b) => b.toString(16).padStart(2, '0')).join('')) ? ' (“MZ”: a Windows program)' : ''}:`);
    ctx.card.append(h('pre', { class: 'pv-hex as-hex' }, lines.join('\n')));
    say('The preview pane (Alt+P) shows the same view for any binary file; open it in Notepad to see more.');
  },
  async compare(x, { say }) {
    const T = await import('./tools.js');
    T.compareFolders();
    say(`Opening Compare / sync. Put your build folder on the left and the backup on the right (or pick them there), compare, then ${x.mirror ? `choose “Mirror ${x.rightToLeft ? 'right → left' : 'left → right'}”: the backup becomes an exact copy (extra files there are removed. You’ll see the list first)` : 'copy the differences either way'}.`);
  },
  async renamePreset(x, { say }) {
    const t = activeTab();
    let items = selectedItems(t).filter((i) => !i.virtual);
    if (!items.length) items = (t?.items || []).filter((i) => !i.isDir).slice(0, 500);
    if (!items.length) return say('Select some files, open Rename Studio (F2), set up the pattern, then use Presets… > Save.');
    const { renameStudio } = await import('./renamestudio.js');
    renameStudio(items, {});
    say('Rename Studio is open. Set up the pattern, then choose Presets… > “Save current as preset” and give it a name. It’s in that list (and in the assistant: “rename these with my <name> preset”) from then on.');
  },
  // ---------------- your own features ----------------
  async checkFeature(x, { say, ctx }) {
    const X = await import('./extensions.js');
    const app = activeAppTab();
    let code = null, name = '';
    if (app?.app === 'editor') { const c = await appAsk('context', null, app); if (/\.dogmod\.js$|dogmod|@dogmod/i.test((c?.name || '') + (c?.text || '').slice(0, 300))) { code = c.text; name = c.name; } }
    if (!code) { const sel = selectedItems(activeTab()).find((i) => /\.(dogmod\.)?js$/i.test(i.name)); if (sel) { code = (await api('fs:readText', sel.path, 2e6)).text; name = sel.name; } }
    const explain = 'Each dogfile.* call needs its permission on the // @permissions line at the top: files.list / stat / readText → read; files.writeText / rename / copy / move / mkdir / trash → write; net.fetch → network (and only to the sites the description mentions); run → run.';
    if (!code) { const list = (state.settings.extensions || []); const bad = list.map((f) => ({ f, c: X.checkCode(f.code, f) })).filter((r) => r.c.missing.length); say(bad.length ? `${plural(bad.length, 'installed feature')} use things their header doesn’t ask for:` : `${list.length ? `All ${plural(list.length, 'installed feature')} ask for every permission they use.` : 'No features are installed.'} Open a .dogmod.js file in Notepad (or select it) to check that one.`); for (const r of bad) say(`• ${r.f.name}: ${r.c.missing.map((m) => `${m.fn}() needs “${m.perm}”`).join(', ')}`); say(explain); return; }
    const meta = X.parseFeature(code);
    const c = X.checkCode(code, meta);
    say(c.missing.length ? `${name}: these calls need a permission the header doesn’t ask for, Dogfile would refuse them:` : `${name}: the header asks for every permission the code uses (${(meta.permissions || []).join(', ') || 'none needed'}).`);
    if (c.missing.length) { ctx.card.append(h('ul', { class: 'as-steps' }, ...c.missing.map((m) => h('li', { class: 'bad' }, h('span', { class: 'as-step-ic', html: icon('close') }), h('span', {}, `${m.fn}() → add “${m.perm}” to // @permissions`))))); say(`Fixed header line: // @permissions ${[...new Set([...(meta.permissions || []), ...c.missing.map((m) => m.perm)])].join(' ')}`); }
    if (x.api) say(/net\.fetch/i.test(x.api) ? `${x.api.replace(/^atlas\./, 'dogfile.')}(url, options) needs “network” in // @permissions, an https address, and the site named in // @description (people see it before installing). It returns { status, ok, headers, text }; call .json() yourself with JSON.parse(text).` : explain);
    else say(explain);
  },
  async writeFeature(x, { say, acts, text }) {
    const { featureFromRequest } = await import('./assistant-feature.js');
    const f = featureFromRequest(text);
    const base = (await api('store:path')) + (sys.platform === 'win32' ? '\\Features' : '/Features');
    await api('fs:mkdir', base).catch(() => {});
    const file = await api('fs:uniqueName', base, `${f.name.replace(/[\\/:*?"<>|]/g, '_')}.dogmod.js`, 'number');
    await api('fs:writeText', file, f.code);
    openTool('editor', [file], { inTab: true });
    say(`${f.known ? 'Wrote' : 'Started'} the feature “${f.name}” and opened it in Notepad. ${f.known ? 'It adds' : 'It has the outline for'} ${f.summary}. Press Features > Install in Notepad to try it (F1 there lists the whole dogfile.* API. Atlas.* works too).${f.known ? '' : ' Fill in the part marked TODO, or describe it in more detail and I’ll try again.'}`);
  },
};
