// Readability of a colour theme: finds text, icons and borders that would be hard to see on the colour behind them
// and works out nearby colours that are readable. Plain functions, no window: readability.js shows the result.
import { DEFAULT_COLORS, COLOR_PARTS } from './theme.js';

const HEX = /^#[0-9a-f]{6}$/i;
export const isColor = (v) => typeof v === 'string' && HEX.test(v);
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** how bright a colour looks, 0 (black) to 1 (white) */
export function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio: 1 (the same) to 21 (black on white) */
export function ratio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** [colour that has to be seen, colour it is seen on, least contrast it needs]. Reading text needs about 4.5 (a little
 * less on selected rows, which themes like Solarized keep soft), icons and large shapes 3; borders and highlights only have to be told apart from what is under them. */
export const PAIRS = [
  ['--text', '--bg-body', 4.5], ['--text', '--bg', 4.5], ['--text', '--bg-elev', 4.5], ['--text', '--bg-sel', 3.8], ['--text', '--bg-hover', 3.8], ['--text', '--tabbar', 3.8],
  ['--text-2', '--bg-body', 3.5], ['--text-2', '--bg-elev', 3.5],
  ['--text-3', '--bg-body', 2.2],
  ['--side-text', '--side-bg', 4.5], ['--side-text', '--side-bg2', 4.5], ['--side-text', '--side-hover', 4.5],
  ['--side-icon', '--side-bg', 3], ['--side-active', '--side-bg', 4.5], ['--side-active', '--side-hover', 4.5],
  ['--accent', '--bg-body', 2.5], ['--accent', '--bg-elev', 2.5],
  ['--line', '--bg-body', 1.05], ['--line', '--bg-elev', 1.05],
  ['--folder', '--bg-body', 1.3],
  ['--bg-sel', '--bg-body', 1.04],
];
const NAMES = Object.fromEntries(COLOR_PARTS.flatMap((g) => g.items.map(([k, l]) => [k, g.group === 'Sidebar' ? `Sidebar ${l.toLowerCase()}` : l])));
export const nameOf = (key) => NAMES[key] || key;

/** the colour in effect: the one picked, else the default */
function effective(theme, mode, accent) {
  const over = theme?.[mode] || {};
  const out = {};
  for (const k of Object.keys(DEFAULT_COLORS[mode])) out[k] = isColor(over[k]) ? over[k] : DEFAULT_COLORS[mode][k];
  if (!isColor(over['--accent']) && isColor(accent)) out['--accent'] = accent;
  return out;
}

/** every colour pair that is too hard to see, for light and dark: [{ mode, fg, bg, ratio, min }] */
export function findProblems(theme, accent) {
  const out = [];
  for (const mode of ['light', 'dark']) {
    const c = effective(theme, mode, accent);
    for (const [fg, bg, min] of PAIRS) {
      const r = ratio(c[fg], c[bg]);
      if (r < min) out.push({ mode, fg, bg, ratio: Math.round(r * 100) / 100, min });
    }
  }
  return out;
}

// ---- colour moved along its lightness, keeping its hue ----
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function fromHsl([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
/** the colour nearest to `fg` (same hue) that has at least `min` contrast against every colour in `bgs` */
function nearestReadable(fg, bgs, min) {
  const ok = (c) => bgs.every((b) => ratio(c, b) >= min);
  if (ok(fg)) return fg;
  const hsl = toHsl(rgbOf(fg));
  const lightBg = bgs.reduce((a, b) => a + luminance(b), 0) / bgs.length > 0.18;
  for (const dir of lightBg ? [-1, 1] : [1, -1]) {
    for (let l = hsl[2]; l >= 0 && l <= 1; l += dir * 0.01) {
      const c = fromHsl([hsl[0], hsl[1], l]);
      if (ok(c)) return c;
    }
  }
  return null;
}

/**
 * A copy of the theme with the hard-to-see colours moved to the nearest readable ones.
 * Returns { colors: { light, dark }, accent, changes: [{ mode, key }] } (a changed accent goes into colors, which win over `accent`).
 */
export function adjust(theme, accent) {
  const colors = { light: { ...(theme?.light || {}) }, dark: { ...(theme?.dark || {}) } };
  const changes = [];
  for (const mode of ['light', 'dark']) {
    for (let pass = 0; pass < 4; pass++) {
      const c = effective(colors, mode, accent);
      let moved = false;
      // every colour that has to be seen, against all the colours it is seen on
      const keys = [...new Set(PAIRS.map((p) => p[0]))];
      for (const fg of keys) {
        const rules = PAIRS.filter((p) => p[0] === fg);
        let cur = c[fg];
        for (const min of [...new Set(rules.map((r) => r[2]))].sort((a, b) => b - a)) {
          const bgs = rules.filter((r) => r[2] === min).map((r) => c[r[1]]);
          const next = nearestReadable(cur, bgs, min < 2 ? min : min * 1.25); // a little past the line, so the result is comfortable and not just barely readable
          if (next && next !== cur) cur = next;
        }
        // all rules together; if one colour can't satisfy every background (they are on both sides of it), the backgrounds give way
        if (PAIRS.some(([f, b, min]) => f === fg && ratio(cur, c[b]) < min)) {
          for (const [, b, min] of PAIRS.filter((p) => p[0] === fg)) if (ratio(cur, c[b]) < min && colors[mode][b]) { delete colors[mode][b]; c[b] = DEFAULT_COLORS[mode][b]; moved = true; changes.push({ mode, key: b }); }
        }
        if (cur !== c[fg]) { colors[mode][fg] = cur; c[fg] = cur; moved = true; if (!changes.some((x) => x.mode === mode && x.key === fg)) changes.push({ mode, key: fg }); }
      }
      if (!moved) break;
    }
    // some mixes can't be saved by moving one colour (text between a light and a dark background): the colours in the
    // clash go back to the defaults, and if that isn't enough, the whole mode does
    let left = findProblems(colors, accent).filter((p) => p.mode === mode);
    if (left.length) {
      for (const p of left) for (const k of [p.fg, p.bg]) if (colors[mode][k]) { delete colors[mode][k]; changes.push({ mode, key: k }); }
      if (findProblems(colors, accent).some((p) => p.mode === mode)) { colors[mode] = {}; if (!isColor(accent) || findProblems(colors, accent).some((p) => p.mode === mode)) colors[mode]['--accent'] = DEFAULT_COLORS[mode]['--accent']; changes.push({ mode, key: 'all' }); }
    }
  }
  return { colors, accent, changes };
}

/** a short description of what was hard to see, for the person: ["Primary text (dark)", …] */
export function describe(problems) {
  const seen = new Set(), out = [];
  for (const p of problems) {
    const k = `${p.fg}|${p.mode}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`${nameOf(p.fg)} (${p.mode})`);
  }
  return out;
}

/** a theme from a file or from GitHub, cut down to what is safe to use: known colour names with #rrggbb values, an accent, a shadow strength.
 * Returns null when nothing usable is in it. */
export function sanitizeTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const clean = (o, mode) => {
    const out = {};
    for (const k of Object.keys(DEFAULT_COLORS[mode])) if (isColor(o?.[k])) out[k] = o[k].toLowerCase();
    return out;
  };
  const light = clean(t.light, 'light'), dark = clean(t.dark, 'dark');
  const accent = isColor(t.accent) ? t.accent.toLowerCase() : undefined;
  const shadow = Number(t.shadowStrength);
  if (!Object.keys(light).length && !Object.keys(dark).length && !accent) return null;
  return {
    name: String(t.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40),
    author: String(t.author || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40),
    description: String(t.description || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 200),
    light, dark, accent, shadowStrength: Number.isFinite(shadow) && t.shadowStrength != null ? Math.max(0, Math.min(2.5, shadow)) : undefined,
  };
}
