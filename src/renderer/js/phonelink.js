// Phone transfer: pair a phone once with a QR code, then send files both ways over Wi-Fi. The page the phone
// opens, the pairing and the transfers are in the back end (backend/src/phonelink.rs); this is the window onto
// them, "Send to phone" on files, and the notes when something arrives.
import { api, state, h, toast, saveSettings, onMain, fmtSize, basename } from './core.js';
import { modal, prompt } from './dialogs.js';
import { icon } from './icons.js';
import { navigate, activeTab } from './pane.js';

let dlg = null; // { body, render }
const ago = (ms) => { if (!ms) return ''; const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ms).toLocaleDateString(); };

/** the Phone transfer window */
export async function openPhoneTransfer() {
  if (dlg) return;
  const body = h('div', { class: 'ph-wrap' });
  let pairing = null, timer = 0;
  const render = async () => {
    const st = await api('phone:status').catch((e) => ({ error: e.message }));
    if (!dlg) return;
    body.innerHTML = '';
    if (st.error) { body.append(h('div', { class: 'ph-note bad' }, st.error)); return; }
    const on = st.running;
    // on / off
    body.append(h('div', { class: 'ph-top' },
      h('div', { class: 'ph-state' }, h('span', { class: 'ph-dot' + (on ? ' on' : '') }), h('div', {}, h('b', {}, on ? 'On: phones on your Wi-Fi can connect' : 'Off'), h('div', { class: 'sub' }, on ? (st.url || 'This PC isn’t on a network right now') : 'Turn it on to pair a phone or to let paired phones connect.'))),
      h('button', { class: 'btn' + (on ? '' : ' primary'), onclick: async () => { if (on) { await api('phone:stop'); pairing = null; } else await api('phone:start').catch((e) => toast(e.message, { error: true })); render(); } }, on ? 'Turn off' : 'Turn on')));
    if (on) {
      // pairing: the QR code
      if (!pairing) pairing = await api('phone:pair').catch((e) => ({ error: e.message }));
      const qr = h('div', { class: 'ph-qr' });
      if (pairing.svg) qr.innerHTML = pairing.svg;
      body.append(h('div', { class: 'ph-pair' }, qr,
        h('div', { class: 'ph-pair-txt' },
          h('b', {}, st.devices.length ? 'Add another phone' : 'Connect your phone'),
          h('ol', {}, h('li', {}, 'Make sure the phone is on the same Wi-Fi as this PC.'), h('li', {}, 'Point the phone’s camera at the code and open the link.'), h('li', {}, 'On iPhone, tap Share, then Add to Home Screen, to reconnect with one tap.')),
          pairing.error ? h('div', { class: 'ph-note bad' }, pairing.error) : h('div', { class: 'sub' }, 'The code works once, for 10 minutes. ', h('a', { href: '#', onclick: async (e) => { e.preventDefault(); pairing = await api('phone:pair', true).catch((er) => ({ error: er.message })); render(); } }, 'New code')))));
    }
    // paired phones
    const devs = h('div', { class: 'ph-list' });
    if (!st.devices.length) devs.append(h('div', { class: 'ph-empty' }, 'No phones yet.'));
    for (const d of st.devices) {
      devs.append(h('div', { class: 'ph-row' }, h('span', { class: 'ph-ic', html: icon('phone') }),
        h('div', { class: 'ph-main' }, h('div', {}, d.name, d.online ? h('span', { class: 'ph-pill' }, 'Connected') : null), h('div', { class: 'sub' }, d.online ? 'Open on the phone now' : `Last seen ${ago(d.lastSeen)}`)),
        h('button', { class: 'icon-btn small', title: 'Rename', html: icon('rename'), onclick: async () => { const n = await prompt('Rename phone', d.name, { label: 'Name' }); if (n) { await api('phone:rename', d.id, n); render(); } } }),
        h('button', { class: 'btn small', onclick: async () => { await api('phone:forget', d.id); render(); } }, 'Forget')));
    }
    body.append(h('h4', {}, 'Your phones'), devs);
    // waiting for the phone
    const out = h('div', { class: 'ph-list' });
    if (!st.outbox.length) out.append(h('div', { class: 'ph-empty' }, 'Right-click files and choose Send to phone. They wait here until your phone picks them up.'));
    for (const x of st.outbox.slice().reverse().slice(0, 200)) {
      out.append(h('div', { class: 'ph-row' }, h('span', { class: 'ph-ic', html: icon(x.kind === 'text' ? 'note' : 'page') }),
        h('div', { class: 'ph-main' }, h('div', { class: 'ell' }, x.kind === 'text' ? x.text : x.name), h('div', { class: 'sub' }, x.kind === 'text' ? 'Text' : fmtSize(x.size || 0))),
        h('button', { class: 'icon-btn small', title: 'Remove', html: icon('close'), onclick: async () => { await api('phone:unsend', x.id); render(); } })));
    }
    body.append(h('div', { class: 'ph-h' }, h('h4', {}, `Waiting for the phone (${st.outbox.length})`),
      h('button', { class: 'btn small', onclick: sendTextDialog }, 'Send text…'),
      st.outbox.length ? h('button', { class: 'btn small', onclick: async () => { await api('phone:unsend'); render(); } }, 'Clear') : null), out);
    // settings
    const always = h('input', { type: 'checkbox', checked: !!state.settings.phoneAlwaysOn });
    always.onchange = () => { state.settings.phoneAlwaysOn = always.checked; saveSettings(); };
    const shared = h('div', { class: 'ph-list' });
    for (const p of state.settings.phoneShared || []) shared.append(h('div', { class: 'ph-row' }, h('span', { class: 'ph-ic', html: icon('folder') }), h('div', { class: 'ph-main ell', title: p }, p), h('button', { class: 'icon-btn small', title: 'Stop sharing', html: icon('close'), onclick: () => { state.settings.phoneShared = state.settings.phoneShared.filter((x) => x !== p); saveSettings(); render(); } })));
    if (!(state.settings.phoneShared || []).length) shared.append(h('div', { class: 'ph-empty' }, 'None yet. Your phone can look through these and save files, but can’t change anything.'));
    body.append(h('h4', {}, 'Settings'), h('div', { class: 'ph-set' },
      h('label', { class: 'ph-check' }, always, h('span', {}, 'Keep it on so paired phones connect by themselves')),
      h('div', { class: 'ph-line' }, h('span', { class: 'lbl' }, 'Files from phones go to'), h('span', { class: 'ell path', title: st.inbox }, st.inbox),
        h('button', { class: 'btn small', onclick: () => { dlg?.close(); navigate(activeTab(), st.inbox); } }, 'Open'),
        h('button', { class: 'btn small', onclick: async () => { const f = await api('dialog:pickFolder', 'Where should files from phones go?'); if (f) { state.settings.phoneInbox = f; saveSettings(); setTimeout(render, 200); } } }, 'Change…')),
      h('div', { class: 'ph-h' }, h('span', { class: 'lbl' }, 'Folders the phone can browse'), h('button', { class: 'btn small', onclick: async () => { const f = await api('dialog:pickFolder', 'Choose a folder the phone can browse'); if (f) { state.settings.phoneShared = [...new Set([...(state.settings.phoneShared || []), f])]; saveSettings(); setTimeout(render, 200); } } }, 'Add folder…')), shared,
      h('div', { class: 'sub' }, 'Only your paired phones can connect, and only on your own Wi-Fi. If Windows asks about private networks, choose Allow.')));
  };
  // opening it means connecting a phone: it turns on
  await api('phone:start').catch((e) => toast(e.message, { error: true }));
  dlg = { body, render, close: null };
  clearInterval(timer);
  timer = setInterval(() => { if (dlg && document.body.contains(body)) render(); }, 10000);
  modal({ title: 'Phone transfer', body, width: 640, className: 'ph-modal', buttons: [{ label: 'Done', primary: true }], onClose: () => { clearInterval(timer); dlg = null; } });
  dlg.close = () => document.querySelector('.ph-modal .modal-head .icon-btn')?.click();
  render();
}

async function sendTextDialog() {
  const t = await prompt('Send text to phone', '', { label: 'Text or a link', placeholder: 'https://… or any text' });
  if (t && t.trim()) { await api('phone:sendText', t); dlg?.render(); toast('It’s waiting on the phone’s page'); }
}

/** "Send to phone" on files and folders */
export async function sendToPhone(paths) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  const st = await api('phone:status');
  const n = await api('phone:send', paths);
  if (!st.running) await api('phone:start').catch(() => {});
  if (!st.devices.length) { toast('Connect your phone first: scan the code'); return openPhoneTransfer(); }
  const on = st.devices.filter((d) => d.online).map((d) => d.name);
  toast(`${n} file${n === 1 ? '' : 's'} ${on.length ? `sent to ${on[0]}` : 'waiting: open Dogfile on your phone to get them'}`, { action: { label: 'Phone transfer', run: openPhoneTransfer } });
}

// what arrives from phones: one note per batch
let batch = null;
onMain('phone:received', (r) => {
  if (!batch) batch = { n: 0, size: 0, from: r.from, dir: r.path.replace(/[\\/][^\\/]*$/, ''), last: r.path, t: 0 };
  batch.n++; batch.size += r.size || 0; batch.last = r.path;
  clearTimeout(batch.t);
  batch.t = setTimeout(() => {
    const b = batch; batch = null;
    toast(b.n === 1 ? `${basename(b.last)} from ${b.from}` : `${b.n} files from ${b.from} (${fmtSize(b.size)})`, { action: { label: 'Show', run: () => navigate(activeTab(), b.dir, { select: b.last }) }, ms: 9000 });
  }, 1200);
});
onMain('phone:text', (r) => {
  const t = String(r.text || '').trim();
  const link = /^https?:\/\/\S+$/i.test(t);
  toast(`${r.from}: ${t.length > 90 ? t.slice(0, 90) + '…' : t}`, { ms: 15000, action: link ? { label: 'Open', run: () => api('shell:openExternal', t) } : { label: 'Copy', run: () => navigator.clipboard.writeText(t).then(() => toast('Copied')) } });
});
onMain('phone:changed', (r) => {
  if (r?.paired) {
    toast(`${r.paired} is connected`);
    // from now on paired phones connect by themselves (unless that was switched off)
    if (state.settings.phoneAlwaysOn == null) { state.settings.phoneAlwaysOn = true; saveSettings(); }
  }
  dlg?.render();
});
