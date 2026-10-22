// Network & cloud: saved server connections (Windows shares, SFTP, FTP/FTPS, WebDAV) with status lights,
// reconnecting shares that dropped, and cloud storage folders (OneDrive, Google Drive, Dropbox, iCloud, Box…)
// that are synced to this PC, all in the sidebar.
import { api, state, sys, bus, h, esc, toast, saveSettings, uid, IS_WIN, basename } from './core.js';
import { modal, confirm } from './dialogs.js';
import { icon } from './icons.js';
import { activeTab, navigate } from './pane.js';
import { requirePro } from './license.js';

export const conns = () => (state.settings.connections ||= []);
const TYPES = [['smb', 'Windows share (SMB)'], ['sftp', 'SFTP (SSH)'], ['ftp', 'FTP'], ['ftps', 'FTPS (FTP over TLS)'], ['webdav', 'WebDAV (https)'],
  ['gdrive', 'Google Drive (sign in)'], ['dropbox', 'Dropbox (sign in)'], ['onedrive', 'OneDrive (sign in)'], ['s3', 'Amazon S3 or compatible (R2, B2, MinIO, Wasabi)']];
const OAUTH = { gdrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive' };
const BROWSED = new Set(['sftp', 'ftp', 'ftps', 's3', 'gdrive', 'dropbox', 'onedrive']);
// where to register Dogfile once so it can sign in to each cloud (until the official app IDs are built in)
const APP_HELP = {
  gdrive: ['Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Desktop app. Turn on the Google Drive API. Paste the client ID and client secret.', 'https://console.cloud.google.com/apis/credentials'],
  dropbox: ['Dropbox App Console → Create app → Scoped access, Full Dropbox. Under Permissions tick files.content.read/write; under Settings add the redirect URI http://127.0.0.1:53682/ and copy the App key.', 'https://www.dropbox.com/developers/apps'],
  onedrive: ['Azure portal → App registrations → New registration → “Personal Microsoft accounts and work/school”. Add platform “Mobile and desktop” with redirect http://localhost, allow public client flows, then copy the Application (client) ID.', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'],
};
export const status = new Map(); // id -> true/false/undefined

export async function openConnection(c) {
  const t = activeTab();
  if (BROWSED.has(c.type)) return navigate(t, `atlas:remote|${c.id}|${c.path || '/'}`);
  try { toast(`Connecting to ${c.name || c.host}…`, { ms: 2000 }); const unc = await api('net:connectShare', c.id); status.set(c.id, true); bus.emit('connections'); navigate(t, unc); }
  catch (e) { status.set(c.id, false); bus.emit('connections'); toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { error: true, ms: 8000 }); }
}
export async function reconnect(path) {
  const host = (/^\\\\([^\\@]+)/.exec(path || '') || [])[1]?.toLowerCase();
  const c = conns().find((x) => (x.type === 'smb' || x.type === 'webdav') && host && x.host.replace(/^\\\\/, '').toLowerCase().startsWith(host));
  if (c) { try { await api('net:connectShare', c.id); toast('Reconnected'); return true; } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { error: true }); return false; } }
  const r = await editConnection({ type: 'smb', host: host || '', share: (/^\\\\[^\\]+\\([^\\]+)/.exec(path || '') || [])[1] || '' });
  return !!r;
}
export async function refreshStatus() {
  for (const c of conns()) api('net:status', c.id).then((r) => { if (status.get(c.id) !== r.ok) { status.set(c.id, r.ok); bus.emit('connections'); } }).catch(() => {});
}
setInterval(() => { if (conns().length && document.visibilityState === 'visible') refreshStatus(); }, 60000);
setTimeout(refreshStatus, 3000);

export async function editConnection(c0) {
  if (!requirePro('remote')) return;
  const isNew = !c0?.id;
  const c = { id: uid(), type: 'sftp', name: '', host: '', port: '', share: '', path: '', user: '', ...(c0 || {}) };
  let pw = '';
  const f = {};
  const body = h('div', { class: 'cn' });
  const draw = () => {
    body.innerHTML = '';
    const row = (label, el, hint) => h('label', { class: 'pp-row' }, h('span', {}, label), h('div', {}, el, hint ? h('div', { class: 'hint' }, hint) : null));
    const inp = (k, ph, type = 'text') => { const x = h('input', { class: 'input', type, placeholder: ph, spellcheck: 'false' }); x.value = c[k] ?? ''; x.oninput = () => { c[k] = x.value; }; x.addEventListener('keydown', (e) => e.stopPropagation()); f[k] = x; return x; };
    const type = h('select', { class: 'input' }, ...TYPES.map(([v, l]) => h('option', { value: v }, l))); type.value = c.type; type.onchange = () => { c.type = type.value; draw(); };
    const pass = h('input', { class: 'input', type: 'password', placeholder: isNew ? '' : '(unchanged)', autocomplete: 'off' }); pass.oninput = () => { pw = pass.value; }; pass.addEventListener('keydown', (e) => e.stopPropagation());
    body.append(row('Type', type), row('Name', inp('name', OAUTH[c.type] ? `e.g. My ${OAUTH[c.type]}` : 'e.g. Home NAS')));
    if (OAUTH[c.type]) {
      const who = h('div', { class: 'hint' }, c.who ? `Signed in as ${c.who}` : 'Not signed in yet');
      body.append(row('Account', h('div', { class: 'stack' }, h('button', { class: 'btn small primary', onclick: () => signIn(c, who) }, c.who ? 'Sign in again…' : `Sign in to ${OAUTH[c.type]}…`), who), 'Your browser opens to sign in. Dogfile keeps a sign-in token encrypted on this PC — never your password.'));
      body.append(h('div', { class: 'hint cn-res' }));
      return;
    }
    if (c.type === 's3') {
      body.append(row('Bucket', inp('bucket', 'my-bucket')), row('Region', inp('region', 'us-east-1')), row('Endpoint (optional)', inp('host', 'blank for Amazon; e.g. https://<account>.r2.cloudflarestorage.com'), 'For Cloudflare R2, Backblaze B2, MinIO, Wasabi and other S3-compatible storage'),
        row('Access key ID', inp('user', 'AKIA…')), row('Secret access key', pass, 'Stored encrypted on this PC'), h('div', { class: 'hint cn-res' }));
      return;
    }
    if (c.type === 'smb') body.append(row('Server', inp('host', 'e.g. nas or 192.168.1.20'), 'The computer or NAS name, or its IP address'), row('Shared folder', inp('share', 'e.g. Media')));
    else if (c.type === 'webdav') body.append(row('Address', inp('host', 'https://cloud.example.com/remote.php/dav/files/me')));
    else body.append(row('Server', inp('host', 'e.g. sftp.example.com')), row('Port', inp('port', c.type === 'sftp' ? '22' : '21')), row('Start in folder', inp('path', '/')));
    body.append(row('User name', inp('user', c.type === 'smb' ? 'optional (e.g. NAS\\me)' : c.type === 'ftp' ? 'blank for anonymous' : '')), row('Password', pass, 'Stored encrypted on this PC with Windows data protection'));
    if (c.type === 'sftp') body.append(row('Private key (optional)', h('div', { class: 'row-inline' }, inp('keyFile', 'path to a key file'), h('button', { class: 'btn small', onclick: async () => { const r = await api('dialog:openFiles', { title: 'Choose a private key' }); if (r?.[0]) { c.keyFile = r[0]; f.keyFile.value = r[0]; } } }, 'Browse…'))));
    if (c.type === 'ftps') { const cb = h('input', { type: 'checkbox' }); cb.checked = !!c.allowSelfSigned; cb.onchange = () => { c.allowSelfSigned = cb.checked; }; body.append(h('label', { class: 'check' }, cb, ' Allow self-signed certificates (only for servers you trust)')); }
    body.append(h('div', { class: 'hint cn-res' }));
  };
  draw();
  const res = () => body.querySelector('.cn-res');
  const ok = await modal({ title: isNew ? 'Add a server connection' : `Edit “${c.name || c.host}”`, width: 560, body, buttons: [
    { label: 'Test', left: true, run: async () => {
      if (OAUTH[c.type]) { if (!c.who) { res().textContent = 'Sign in first'; return false; } }
      else if (c.type === 's3') { if (!c.bucket) { res().textContent = 'Enter the bucket first'; return false; } }
      else if (!c.host) { res().textContent = 'Enter the server first'; return false; }
      res().textContent = 'Testing…';

      if (c.type === 'smb' || c.type === 'webdav') { const unc = await api('net:unc', c); const r2 = await api('net:reachable', unc, 6000); res().textContent = r2 ? `✓ ${unc} answers` : `✗ ${unc} isn’t answering (it may need you to sign in: save and press Connect)`; return false; }
      const r = await api('remote:test', c, pw); res().textContent = r.ok ? `✓ Connected. ${r.count} items in ${c.path || '/'}` : `✗ ${r.error}`; return false;
    } },
    { label: 'Cancel', value: null }, { label: isNew ? 'Add' : 'Save', primary: true, value: true }] });
  if (!ok) return null;
  if (OAUTH[c.type] && !c.who) return toast(`Sign in to ${OAUTH[c.type]} first`, { error: true });
  if (c.type === 's3' && !c.bucket) return toast('A bucket name is needed', { error: true });
  if (!c.host && !OAUTH[c.type] && c.type !== 's3') return toast('A server address is needed', { error: true });
  if (!c.name) c.name = OAUTH[c.type] ? `${OAUTH[c.type]}${c.who ? ` (${c.who})` : ''}` : c.type === 's3' ? `S3 – ${c.bucket}` : c.type === 'smb' ? `${c.host}${c.share ? ' – ' + c.share : ''}` : c.host;
  const list = conns().filter((x) => x.id !== c.id); list.push(c);
  state.settings.connections = list; saveSettings();
  if (!OAUTH[c.type] && (pw || isNew)) await api('remote:setSecret', c.id, pw);
  bus.emit('connections');
  refreshStatus();
  openConnection(c);
  return c;
}
// sign in through the browser; without an app registration yet, explain how to make one
async function signIn(c, who) {
  who.textContent = 'Waiting for the browser… (finish signing in there)';
  const r = await api('remote:signIn', c.type, c.id).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) { c.who = r.who || 'your account'; who.textContent = `Signed in as ${c.who}`; return; }
  if (r.needsApp) { who.textContent = ''; if (await cloudAppDialog(c.type)) return signIn(c, who); return; }
  who.textContent = `✗ ${r.error}`;
}
export async function cloudAppDialog(kind) {
  const apps = (state.settings.cloudApps ||= {});
  const cur = apps[kind] || {};
  const id = h('input', { class: 'input', placeholder: 'Client ID / App key', spellcheck: 'false' }); id.value = cur.clientId || '';
  const sec = h('input', { class: 'input', placeholder: 'Client secret (Google only)', spellcheck: 'false' }); sec.value = cur.clientSecret || '';
  for (const x of [id, sec]) x.addEventListener('keydown', (e) => e.stopPropagation());
  const [text, url] = APP_HELP[kind];
  const ok = await modal({ title: `Connect Dogfile to ${OAUTH[kind]}`, width: 560, body: h('div', { class: 'stack' },
    h('p', {}, `To sign in to ${OAUTH[kind]} directly, Dogfile needs an app registration with ${OAUTH[kind]} (a one-time step; future Dogfile versions come with one built in).`),
    h('p', { class: 'hint' }, text), h('button', { class: 'btn small', onclick: () => api('shell:openExternal', url) }, 'Open the developer page'),
    id, kind === 'gdrive' ? sec : null), buttons: [{ label: 'Cancel', value: false }, { label: 'Save and sign in', primary: true, value: true }] });
  if (!ok || !id.value.trim()) return false;
  apps[kind] = { clientId: id.value.trim(), ...(kind === 'gdrive' ? { clientSecret: sec.value.trim() } : {}) };
  saveSettings();
  await new Promise((r) => setTimeout(r, 300)); // settings reach the engine
  return true;
}
export async function connectionsDialog() {
  if (!requirePro('remote')) return;
  const list = h('div', { class: 'ws-list' });
  const draw = () => {
    list.innerHTML = '';
    if (!conns().length) list.append(h('div', { class: 'hint pad' }, 'No saved connections. Add your NAS, a Windows share, an SFTP or FTP server, a WebDAV folder, or a cloud account (Google Drive, Dropbox, OneDrive, S3) — no sync app needed.'));
    for (const c of conns()) {
      const st = status.get(c.id);
      list.append(h('div', { class: 'ws-row' }, h('span', { class: 'cn-dot ' + (st === true ? 'up' : st === false ? 'down' : ''), title: st === true ? 'Answering' : st === false ? 'Not answering' : 'Checking…' }),
        h('div', { class: 'hi-main' }, h('b', {}, c.name || c.host), h('span', { class: 'hint' }, OAUTH[c.type] ? `${OAUTH[c.type]}${c.who ? ` · ${c.who}` : ''}` : c.type === 's3' ? `S3 · ${c.bucket}${c.host ? ` · ${c.host}` : ''}` : `${TYPES.find((x) => x[0] === c.type)?.[1]} · ${c.host}${c.share ? '\\' + c.share : ''}${c.user ? ` · ${c.user}` : ''}`)),
        h('div', { class: 'hi-acts' }, h('button', { class: 'btn small primary', onclick: () => { closeIt(); openConnection(c); } }, 'Open'), h('button', { class: 'btn small', onclick: async () => { await editConnection(c); draw(); } }, 'Edit'),
          h('button', { class: 'icon-btn small', title: 'Remove', html: icon('trash'), onclick: async () => { if (await confirm('Remove connection?', `“${esc(c.name || c.host)}” and its saved password will be removed.`, { ok: 'Remove', danger: true })) { state.settings.connections = conns().filter((x) => x.id !== c.id); saveSettings(); api('remote:setSecret', c.id, ''); api('remote:disconnect', c.id); bus.emit('connections'); draw(); } } }))));
    }
  };
  draw();
  const off = bus.on('connections', draw);
  let closeIt = () => {};
  const p = modal({ title: 'Server connections', width: 640, className: 'cn-modal', onClose: off, body: h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Copy, move, rename and delete work on servers too. Copies to and from network places run one at a time in the Operations list so a slow connection doesn’t hold up local copies.'), list), buttons: [{ label: 'Add connection…', left: true, run: async () => { await editConnection(null); draw(); return false; } }, { label: 'Check status', left: true, run: () => { refreshStatus(); return false; } }, { label: 'Close', primary: true, value: true }] });
  setTimeout(() => { closeIt = () => document.querySelector('.cn-modal')?._close?.(null); }, 0);
  return p;
}

// ---------------- cloud folders on this PC ----------------
let cloud = null;
export async function cloudFolders() {
  if (cloud) return cloud;
  cloud = await api('cloud:detect').catch(() => []);
  return cloud;
}
bus.on('connections:dialog', connectionsDialog);
