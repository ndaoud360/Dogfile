// Help > Report a bug: name, email and what happened, sent to the developer (backend/src/bugreport.rs).
import { api, h, toast, sys, state } from './core.js';
import { modal } from './dialogs.js';
import { icon } from './icons.js';

const TO = 'nd640dev@gmail.com';

// opts.mod: report a mod (a feature someone made) instead of a bug in Dogfile: { name, author, source, version }
export async function reportBug(opts = {}) {
  const mod = opts.mod || null;
  const saved = state.settings.bugReporter || {};
  const field = (label, el) => h('label', { class: 'bug-field' }, h('span', {}, label), el);
  const name = h('input', { class: 'input', type: 'text', maxlength: '120', autocomplete: 'name', value: saved.name || '' });
  const email = h('input', { class: 'input', type: 'email', maxlength: '200', autocomplete: 'email', value: saved.email || '' });
  const message = h('textarea', { class: 'input bug-msg', maxlength: '8000', rows: '7', placeholder: mod ? 'What’s wrong with this mod? (It breaks something, does something it shouldn’t, is harmful or offensive…)' : 'What happened, and what were you doing just before?' });
  const about = mod ? h('div', { class: 'bug-about' }, h('span', { html: icon('puzzle') }), h('div', {}, h('b', {}, `Reporting the mod “${mod.name}”`), h('div', { class: 'hint' }, [mod.author ? `by ${mod.author}` : '', mod.version ? `v${mod.version}` : '', mod.source || ''].filter(Boolean).join(' · ')))) : null;
  const incl = h('input', { type: 'checkbox', checked: true });
  const status = h('div', { class: 'bug-status', role: 'status' });
  for (const el of [name, email, message]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const body = h('div', { class: 'stack bug-form' }, about,
    field('Name', name), field('Email', email), field('Message', message),
    h('label', { class: 'row-inline bug-incl' }, incl, h('span', {}, `Include my Dogfile version (${sys.version || ''}), Windows version and recent error messages`)),
    status);
  let sending = false;
  await modal({
    title: mod ? 'Report a mod' : 'Report a bug', width: 520, className: 'bug-modal', body,
    buttons: [{ label: 'Cancel', value: null }, {
      label: 'Send', primary: true,
      run: async (close) => {
        if (sending) return false;
        const v = { name: name.value.trim(), email: email.value.trim(), message: message.value.trim(), includeSystem: incl.checked, mod };
        const bad = !v.name ? [name, 'Please enter your name.'] : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email) ? [email, 'Please enter an email address we can reply to.'] : v.message.length < 5 ? [message, 'Please describe the problem.'] : null;
        if (bad) { status.className = 'bug-status bad'; status.textContent = bad[1]; bad[0].focus(); return false; }
        sending = true;
        status.className = 'bug-status'; status.textContent = 'Sending…';
        try {
          await api('bug:report', v);
        } catch (e) {
          sending = false;
          status.className = 'bug-status bad';
          status.innerHTML = '';
          const copy = h('button', { class: 'btn small with-ic', html: icon('copy') + '<span>Copy the report</span>', onclick: () => { api('clip:writeText', `${mod ? `Mod: ${mod.name} ${mod.author ? `by ${mod.author}` : ''} ${mod.source || ''}\n\n` : ''}${v.message}\n\n${v.name} <${v.email}>`); toast('Copied'); } });
          status.append(h('p', {}, `${e.message || e} You can also email it to ${TO}.`), copy);
          return false;
        }
        state.settings.bugReporter = { name: v.name, email: v.email };
        import('./core.js').then((m) => m.saveSettings());
        toast(mod ? 'Thanks! Your report about this mod was sent.' : 'Thanks! Your report was sent.');
        close(true);
      },
    }],
  });
}
