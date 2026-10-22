// Theme + color customizer shared by the explorer, Dogfile Notepad and Dogfile Player.
export const DEFAULT_COLORS = {
  light: {
    '--side-bg': '#2f3033', '--side-bg2': '#2a2b2e', '--side-text': '#c4c5c7', '--side-icon': '#8d8e91', '--side-active': '#ffffff', '--side-hover': '#38393c',
    '--tabbar': '#efeff0', '--bg': '#ffffff', '--bg-body': '#f7f7f7', '--bg-elev': '#ffffff', '--line': '#ececec',
    '--text': '#2b2b2b', '--text-2': '#5f6062', '--text-3': '#9a9b9d',
    '--accent': '#3b82f6', '--bg-sel': '#e9eaec', '--tile-sel': '#3a3b3d', '--bg-hover': '#f0f0f1',
    '--folder': '#c9ccd1', '--fold-back': '#f7f7f7', '--ripple': '#e4e4e6',
  },
  dark: {
    '--side-bg': '#18191b', '--side-bg2': '#141517', '--side-text': '#b9babd', '--side-icon': '#7d7e82', '--side-active': '#ffffff', '--side-hover': '#222326',
    '--tabbar': '#151618', '--bg': '#1f2023', '--bg-body': '#1b1c1f', '--bg-elev': '#26272b', '--line': '#2b2c30',
    '--text': '#e6e6e7', '--text-2': '#b4b5b8', '--text-3': '#85878c',
    '--accent': '#3b82f6', '--bg-sel': '#2f3136', '--tile-sel': '#3a3c41', '--bg-hover': '#26272b',
    '--folder': '#5c6068', '--fold-back': '#1b1c1f', '--ripple': '#4a4b50',
  },
};

export const COLOR_PARTS = [
  { group: 'Sidebar', items: [['--side-bg', 'Background'], ['--side-bg2', 'Background (bottom fade)'], ['--side-text', 'Text'], ['--side-icon', 'Icons'], ['--side-active', 'Active item'], ['--side-hover', 'Hover']] },
  { group: 'Window', items: [['--tabbar', 'Tab bar'], ['--bg', 'Menu & address bar'], ['--bg-body', 'File area'], ['--bg-elev', 'Menus, dialogs & panels'], ['--line', 'Borders & dividers']] },
  { group: 'Text', items: [['--text', 'Primary text'], ['--text-2', 'Secondary text'], ['--text-3', 'Muted text & labels']] },
  { group: 'Selection & highlights', items: [['--accent', 'Accent'], ['--bg-sel', 'Selected row'], ['--tile-sel', 'Selected thumbnail'], ['--bg-hover', 'Hover']] },
  { group: 'Icons', items: [['--folder', 'Folder icons']] },
  { group: 'Sidebar animation', items: [['--fold-back', 'Fold backing'], ['--ripple', 'Menu button ripple']] },
];

export const PRESETS = {
  Default: { light: {}, dark: {} },
  Graphite: { light: { '--side-bg': '#232427', '--side-bg2': '#1f2023', '--accent': '#6b6e78', '--fold-back': '#8b8d98', '--ripple': '#8b8d98' }, dark: { '--accent': '#9a9ca6', '--fold-back': '#8b8d98', '--ripple': '#8b8d98' } },
  Midnight: {
    light: { '--side-bg': '#1e2433', '--side-bg2': '#191e2b', '--accent': '#4f7cff', '--folder': '#9db1d9', '--fold-back': '#4f7cff', '--ripple': '#4f7cff' },
    dark: { '--bg': '#141824', '--bg-body': '#10131c', '--tabbar': '#0c0f16', '--bg-elev': '#1a1f2e', '--side-bg': '#0d1018', '--side-bg2': '#0a0c12', '--line': '#222838', '--bg-sel': '#1f2638', '--bg-hover': '#181d2a', '--accent': '#5b8cff', '--folder': '#42557d', '--fold-back': '#5b8cff', '--ripple': '#5b8cff' },
  },
  Nord: {
    light: { '--side-bg': '#2e3440', '--side-bg2': '#2b303b', '--accent': '#5e81ac', '--folder': '#81a1c1', '--text': '#2e3440', '--fold-back': '#88c0d0', '--ripple': '#88c0d0' },
    dark: { '--bg': '#3b4252', '--bg-body': '#2e3440', '--tabbar': '#272c36', '--bg-elev': '#3b4252', '--side-bg': '#242933', '--side-bg2': '#20242d', '--line': '#434c5e', '--text': '#eceff4', '--text-2': '#d8dee9', '--bg-sel': '#434c5e', '--bg-hover': '#3b4252', '--accent': '#88c0d0', '--folder': '#5e81ac', '--fold-back': '#88c0d0', '--ripple': '#88c0d0' },
  },
  Solarized: {
    light: { '--bg': '#fdf6e3', '--bg-body': '#f7f0dc', '--tabbar': '#eee8d5', '--bg-elev': '#fdf6e3', '--side-bg': '#073642', '--side-bg2': '#002b36', '--text': '#586e75', '--text-2': '#657b83', '--line': '#e6dfc8', '--bg-sel': '#eee8d5', '--accent': '#268bd2', '--folder': '#b58900', '--fold-back': '#b58900', '--ripple': '#b58900' },
    dark: { '--bg': '#073642', '--bg-body': '#002b36', '--tabbar': '#00212b', '--bg-elev': '#073642', '--side-bg': '#001f27', '--side-bg2': '#00171e', '--text': '#93a1a1', '--text-2': '#839496', '--line': '#0b4553', '--bg-sel': '#0b4553', '--accent': '#2aa198', '--folder': '#b58900', '--fold-back': '#b58900', '--ripple': '#b58900' },
  },
  Forest: { light: { '--side-bg': '#1f2b24', '--side-bg2': '#1a241e', '--accent': '#30a46c', '--folder': '#9fbfa8', '--fold-back': '#30a46c', '--ripple': '#30a46c' }, dark: { '--side-bg': '#121a15', '--side-bg2': '#0f1511', '--accent': '#3dd68c', '--folder': '#3f5a48', '--fold-back': '#30a46c', '--ripple': '#30a46c' } },
  Rose: { light: { '--side-bg': '#2d2226', '--side-bg2': '#261c20', '--accent': '#e5487a', '--folder': '#e3b3c2', '--fold-back': '#e5487a', '--ripple': '#e5487a' }, dark: { '--side-bg': '#1c1416', '--side-bg2': '#171012', '--accent': '#f06292', '--folder': '#6e4552', '--fold-back': '#e5487a', '--ripple': '#e5487a' } },
  'High contrast': {
    light: { '--text': '#000000', '--text-2': '#111111', '--text-3': '#3a3a3a', '--line': '#9a9a9a', '--bg-sel': '#cfe0ff', '--accent': '#0050d0', '--side-text': '#ffffff', '--side-icon': '#d0d0d0' },
    dark: { '--text': '#ffffff', '--text-2': '#eeeeee', '--text-3': '#bbbbbb', '--line': '#666666', '--bg-sel': '#26406e', '--accent': '#5aa0ff', '--side-text': '#ffffff', '--side-icon': '#d0d0d0' },
  },
};

export function isDark(settings) {
  return settings.theme === 'dark' || (settings.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}

let applied = [];
// pages that follow the system theme redraw when Windows switches between light and dark
let lastSettings = null;
if (typeof matchMedia !== 'undefined') matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (lastSettings) { applyColors(lastSettings); window.dispatchEvent(new CustomEvent('dogfile:theme')); } });
export function applyColors(settings) {
  lastSettings = settings;
  const dark = isDark(settings);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  for (const v of applied) root.style.removeProperty(v);
  applied = [];
  const over = (settings.colors && settings.colors[dark ? 'dark' : 'light']) || {};
  const accent = over['--accent'] || settings.accent || '#3b82f6';
  root.style.setProperty('--accent', accent); applied.push('--accent');
  for (const [k, v] of Object.entries(over)) { if (k === '--accent' || !v) continue; root.style.setProperty(k, v); applied.push(k); }
  root.style.setProperty('--shadow-k', String(settings.shadowStrength ?? 1)); applied.push('--shadow-k');
  root.style.setProperty('--fs', String(settings.fontScale || 1)); applied.push('--fs');
  // rounded corners: one roundness value, applied only to the element types that are ticked
  const c = { radius: 8, tabs: false, tiles: true, controls: true, menus: true, dialogs: true, panels: true, items: true, ...(settings.corners || {}) };
  const r = (on, k) => (on ? Math.round(c.radius * k * 10) / 10 : 0) + 'px';
  const vars = { '--r-tab': r(c.tabs, 1), '--r-tile': r(c.tiles, 0.45), '--r-ctl': r(c.controls, 1), '--r-menu': r(c.menus, 1.25), '--r-dlg': r(c.dialogs, 1.75), '--r-panel': r(c.panels, 1.4), '--r-item': r(c.items, 0.8) };
  for (const [k, v] of Object.entries(vars)) { root.style.setProperty(k, v); applied.push(k); }
  return dark;
}

export function currentColor(settings, theme, key) {
  return (settings.colors && settings.colors[theme] && settings.colors[theme][key]) || (key === '--accent' && settings.accent) || DEFAULT_COLORS[theme][key];
}

// Dogfile Player / Dogfile Photos: follow the app theme, or always dark / always light
export function mediaSettings(settings) {
  const m = settings.mediaTheme || 'app';
  return { ...settings, theme: m === 'app' ? settings.theme : m };
}
