// More cloud drives: Box, MEGA, pCloud, Proton Drive, Yandex Disk, Backblaze B2, Azure and others, through rclone (a one-time
// download). A drive added here shows up under Network like any other connection and is browsed like a folder.
import { api, state, h, toast, saveSettings, uid, errText, bus } from './core.js';
import { modal, confirm } from './dialogs.js';
import { ensureComponent } from './components.js';
import { activeTab, navigate } from './pane.js';
import { conns } from './network.js';

const slug = (s) => String(s || 'drive').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'drive';

export async function addCloud() {
  if (!(await ensureComponent('rclone', 'Connecting a cloud drive'))) return null;
  let providers;
  try { providers = await api('rclone:providers'); } catch (e) { toast(errText(e), { error: true }); return null; }
  let pick = providers[0];
  const body = h('div', { class: 'cn' });
  const f = { name: '', params: {}, other: '', otherParams: '' };
  const draw = () => {
    body.innerHTML = '';
    const sel = h('select', { class: 'input' }, ...providers.map((p) => h('option', { value: p.type, ...(p === pick ? { selected: '' } : {}) }, p.label)));
    sel.onchange = () => { pick = providers.find((p) => p.type === sel.value); f.params = {}; draw(); };
    body.append(h('label', { class: 'field-label' }, 'Service'), sel);
    if (pick.type === 'other') {
      const t = h('input', { class: 'input', placeholder: 'rclone service name, e.g. jottacloud, sharefile, swift', value: f.other, spellcheck: 'false' });
      t.oninput = () => { f.other = t.value.trim(); };
      const p = h('textarea', { class: 'input', rows: '3', placeholder: 'Settings, one per line: key=value', spellcheck: 'false' }, f.otherParams);
      p.oninput = () => { f.otherParams = p.value; };
      body.append(h('label', { class: 'field-label' }, 'Service name'), t, h('label', { class: 'field-label' }, 'Settings (optional)'), p,
        h('div', { class: 'hint' }, 'Any of the services listed at rclone.org/overview. Services that sign in through a browser open it for you.'));
    } else {
      for (const fd of pick.fields) {
        const i = h('input', { class: 'input', type: fd.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', value: f.params[fd.key] || '' });
        i.oninput = () => { f.params[fd.key] = i.value; };
        body.append(h('label', { class: 'field-label' }, fd.label), i);
      }
      body.append(h('div', { class: 'hint' }, pick.auth === 'browser' ? 'A browser window opens so you can sign in and allow Dogfile. Dogfile never sees your password.' : 'Your details are kept on this PC (the password is scrambled by rclone).'));
      if (pick.note) body.append(h('div', { class: 'hint' }, pick.note));
    }
    const nm = h('input', { class: 'input', value: f.name, placeholder: `Name in the sidebar (default: ${pick.type === 'other' ? 'the service' : pick.label})` });
    nm.oninput = () => { f.name = nm.value.trim(); };
    body.append(h('label', { class: 'field-label' }, 'Name'), nm, h('div', { class: 'hint cn-res' }));
  };
  draw();
  const ok = await modal({ title: 'Add a cloud drive', width: 540, body, buttons: [{ label: 'Cancel', value: false }, { label: 'Sign in and add', primary: true, value: true }] });
  if (!ok) return null;
  const type = pick.type === 'other' ? f.other : (pick.rclone || pick.type);
  if (!type) return toast('Enter the service name', { error: true });
  const params = { ...f.params };
  if (pick.type === 'other') for (const line of f.otherParams.split('\n')) { const i = line.indexOf('='); if (i > 0) params[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const label = f.name || (pick.type === 'other' ? f.other : pick.label);
  const remote = `dog-${slug(label)}-${uid().slice(0, 4)}`;
  toast(pick.auth === 'browser' ? 'Finish signing in in your browser…' : 'Connecting…', { ms: 8000 });
  try { await api('rclone:create', { name: remote, type: pick.rclone ? pick.rclone : type, params }); } catch (e) { toast(errText(e), { error: true, ms: 10000 }); return null; }
  const c = { id: uid(), type: 'rclone', name: label, remote, path: '/', host: '' };
  state.settings.connections = [...conns().filter((x) => x.id !== c.id), c];
  saveSettings();
  bus.emit('connections');
  toast(`“${label}” is connected`, { ok: true });
  navigate(activeTab(), `atlas:remote|${c.id}|/`);
  return c;
}

/** remove a cloud drive added here: its sign-in is deleted from rclone too */
export async function removeCloud(c) {
  if (!(await confirm('Remove this cloud drive?', `“${c.name}” is taken out of Dogfile and its sign-in is forgotten. Nothing in the cloud is deleted.`, { ok: 'Remove' }))) return false;
  try { await api('rclone:delete', c.remote); } catch { /* it may already be gone */ }
  state.settings.connections = conns().filter((x) => x.id !== c.id);
  saveSettings();
  bus.emit('connections');
  return true;
}
