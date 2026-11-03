// Keeps a colour theme readable. When the colours someone picked (or imported, or downloaded) make text, icons or borders hard
// to see, Dogfile moves them to the nearest readable colours at once, says so, and asks whether to keep the adjusted
// colours or the person's own.
import { state, bus, h, saveSettings } from './core.js';
import { modal } from './dialogs.js';
import { findProblems, adjust, describe, nameOf } from './contrast.js';

const clone = (c) => ({ light: { ...(c?.light || {}) }, dark: { ...(c?.dark || {}) } });
let asking = false, timer = 0;
const sigOf = (S) => JSON.stringify([S.colors, S.accent]);

/** checks the colours in use now; `after` runs when the person has answered (the settings page redraws its pickers) */
export async function guardReadability(after) {
  const S = state.settings;
  if (asking || !findProblems(S.colors, S.accent).length) return false;
  if (S.readabilityKept === sigOf(S)) return false; // they already said "use mine" for exactly these colours
  const mine = { colors: clone(S.colors), accent: S.accent };
  const fix = adjust(mine.colors, mine.accent);
  if (!fix.changes.length) return false;
  const was = findProblems(mine.colors, mine.accent);
  asking = true;
  S.colors = fix.colors; saveSettings(); bus.emit('theme'); after?.(); // the adjusted colours are on screen while the question is asked
  const swatch = (c) => h('span', { class: 'rdy-sw', style: { background: c } });
  const eff = (c, mode, k) => c[mode]?.[k];
  const rows = [];
  for (const mode of ['light', 'dark']) {
    for (const k of new Set(fix.changes.filter((c) => c.mode === mode && c.key !== 'all').map((c) => c.key))) {
      rows.push(h('div', { class: 'rdy-row' }, h('span', {}, `${nameOf(k)} (${mode})`), eff(mine.colors, mode, k) ? swatch(eff(mine.colors, mode, k)) : h('span', { class: 'hint' }, 'default'), h('span', { class: 'hint' }, '→'), eff(fix.colors, mode, k) ? swatch(eff(fix.colors, mode, k)) : h('span', { class: 'hint' }, 'default')));
    }
    if (fix.changes.some((c) => c.mode === mode && c.key === 'all')) rows.push(h('div', { class: 'rdy-row' }, h('span', {}, `All ${mode} colors went back to the defaults`)));
  }
  const choice = await modal({ title: 'Your colors were adjusted so you can read them', width: 520, closeOnBackdrop: false,
    body: h('div', { class: 'stack' },
      h('p', {}, `Some colors were hard to see against what is behind them: ${describe(was).slice(0, 6).join(', ')}${describe(was).length > 6 ? '…' : ''}. Dogfile moved them to the nearest colors that are easy to read, and that is what you see now.`),
      h('div', { class: 'rdy-list' }, ...rows),
      h('p', { class: 'hint' }, 'Keep the adjusted colors, or go back to exactly the colors you chose? Your colors may leave some text hard to read; Colors > Reset all brings the defaults back.')),
    buttons: [{ label: 'Use my colors', value: 'mine' }, { label: 'Keep adjusted colors', primary: true, value: 'adjusted' }] });
  asking = false;
  if (choice === 'mine') {
    S.colors = mine.colors; S.accent = mine.accent;
    S.readabilityKept = sigOf(S);
    saveSettings(); bus.emit('theme');
  }
  after?.();
  return true;
}

/** after the person stops changing colours for a moment (a colour picker fires on every move) */
export function scheduleReadabilityCheck(after) {
  clearTimeout(timer);
  timer = setTimeout(() => guardReadability(after), 1500);
}
