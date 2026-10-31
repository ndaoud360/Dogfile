// Demo mode in the interface: the switch in Settings, the "Demo mode" sign at the top of the window, and every
// window starting over when it's switched (the back end, backend/src/demo.rs, does the pretending).
import { api, sys, h, onMain } from './core.js';
import { confirm } from './dialogs.js';
import { showMenu } from './menu.js';

/** turn demo mode on or off, after saying what it does */
export async function setDemo(on) {
  if (on) {
    const ok = await confirm('Turn on demo mode?', 'Dogfile will show a pretend PC with made-up files, so you can record or present without showing yours.<br><br>Your own files and settings are only hidden. Everything comes back when you turn it off.', { ok: 'Turn on demo mode' });
    if (!ok) return false;
  }
  await api('demo:set', !!on);
  return true;
}

/** the sign at the top of the window while demo mode is on */
export function showDemoSign() {
  document.body.classList.toggle('demo-mode', !!sys.demo);
  document.getElementById('demo-sign')?.remove();
  if (!sys.demo) return;
  const sign = h('button', { id: 'demo-sign', title: 'Demo mode: these are pretend files. Click for options.' }, h('span', { class: 'dot' }), 'DEMO MODE');
  sign.addEventListener('click', (e) => {
    const r = sign.getBoundingClientRect();
    showMenu([
      { header: 'Pretend files: nothing here is yours' },
      { label: 'Turn off demo mode', icon: 'close', run: () => setDemo(false) },
      { label: 'Put the demo files back as they were', icon: 'undo', run: () => api('demo:reset') },
    ], r.left, r.bottom + 4);
    e.stopPropagation();
  });
  const bar = document.getElementById('tabbar');
  const drag = bar?.querySelector('.tab-drag');
  if (drag) drag.after(sign); else bar?.append(sign);
}

// switched (here or in another window): start over on the other side
onMain('demo:changed', () => { setTimeout(() => location.reload(), 150); });
