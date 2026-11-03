// Themes in the feature browser: colour themes shared through GitHub like mods. A shared theme is a public repository with the
// topic "dogfile-theme" and a dogtheme.json file. A theme is only colours (no code), cut down to known colour names and
// #rrggbb values before it is used, and a theme that would be hard to read is adjusted (readability.js).
import { api, state, bus, h, toast, saveSettings, errText } from './core.js';
import { modal, prompt } from './dialogs.js';
import { icon } from './icons.js';
import { DEFAULT_COLORS, PRESETS } from './theme.js';
import { sanitizeTheme } from './contrast.js';
import { gh, b64, signIn } from './featurestore.js';

export const THEME_TOPIC = 'dogfile-theme';
const FILE = 'dogtheme.json';
const unb64 = (s) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ''))));

/** the theme file of a repository, cut down to what is safe */
export async function themeOf(repo) {
  let raw = (await gh('GET', `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${FILE}`, null, false)).json;
  if (!raw?.light && !raw?.dark && !raw?.accent) {
    const c = await gh('GET', `/repos/${repo.full_name}/contents/${FILE}`);
    if (c.ok && c.json?.content) { try { raw = JSON.parse(unb64(c.json.content)); } catch { raw = null; } }
  }
  return sanitizeTheme(raw);
}

const nameOfRepo = (repo) => (repo.name || '').replace(/^dogtheme-/, '').replace(/-/g, ' ');
const currentTheme = () => { const S = state.settings; return { light: { ...(S.colors?.light || {}) }, dark: { ...(S.colors?.dark || {}) }, accent: S.accent, shadowStrength: S.shadowStrength ?? 1 }; };
const hasCustom = () => { const c = currentTheme(); return Object.keys(c.light).length + Object.keys(c.dark).length > 0 || (c.accent && c.accent !== '#3b82f6'); };

/** adds a theme to the person's presets under a free name and returns the name */
function addPreset(t, name) {
  const S = state.settings;
  S.colorPresets = S.colorPresets || {};
  let n = (name || t.name || 'Shared theme').trim(), i = 2;
  const base = n;
  while (PRESETS[n] || (S.colorPresets[n] && JSON.stringify(S.colorPresets[n]) !== JSON.stringify({ light: t.light, dark: t.dark, accent: t.accent, shadowStrength: t.shadowStrength }))) n = `${base} ${i++}`;
  S.colorPresets[n] = { light: t.light, dark: t.dark, accent: t.accent, shadowStrength: t.shadowStrength };
  return n;
}
/** uses a theme now. The colours that were in use are kept as a preset, so nothing is lost */
export async function applyTheme(t, name) {
  const S = state.settings;
  const kept = hasCustom();
  if (kept) { S.colorPresets = S.colorPresets || {}; S.colorPresets['My previous colors'] = currentTheme(); }
  const n = addPreset(t, name);
  S.colors = { light: { ...t.light }, dark: { ...t.dark } };
  S.accent = t.accent || '#3b82f6';
  if (t.shadowStrength != null) S.shadowStrength = t.shadowStrength;
  saveSettings(); bus.emit('theme');
  toast(`Using “${n}”.${kept ? ' Your earlier colors are saved as “My previous colors” in Settings > Colors.' : ''}`, { ms: 7000 });
  const { guardReadability } = await import('./readability.js');
  await guardReadability();
}

// a small picture of the interface in the theme's colours (sidebar, file area, text, accent)
function preview(t, mode) {
  const c = { ...DEFAULT_COLORS[mode], ...(t[mode] || {}) };
  if (t.accent && !t[mode]?.['--accent']) c['--accent'] = t.accent;
  const box = (css, kids = []) => h('div', { style: css }, ...kids);
  const line = (w, col) => box(`height:5px;width:${w}%;border-radius:3px;background:${col}`);
  return h('div', { class: 'th-pv', style: `background:${c['--bg-body']};border-color:${c['--line']}` },
    box(`background:${c['--side-bg']};padding:7px 6px;display:flex;flex-direction:column;gap:5px`, [line(80, c['--side-active']), line(60, c['--side-text']), line(70, c['--side-text'])]),
    box(`flex:1;padding:7px;display:flex;flex-direction:column;gap:5px;background:${c['--bg-body']}`, [
      box(`height:6px;border-radius:3px;background:${c['--tabbar']}`), line(70, c['--text']), box(`background:${c['--bg-sel']};padding:3px;border-radius:3px`, [line(50, c['--text'])]), line(55, c['--text-2']),
      box('display:flex;gap:4px;align-items:center', [box(`width:10px;height:7px;border-radius:2px;background:${c['--folder']}`), box(`width:16px;height:7px;border-radius:3px;background:${c['--accent']}`)])]));
}

export function themeCard(repo) {
  const title = nameOfRepo(repo);
  const holder = h('div', { class: 'th-pvs' }, h('div', { class: 'hint' }, 'Loading preview…'));
  let theme = null;
  const need = async () => theme || (theme = await themeOf(repo));
  need().then((t) => { holder.innerHTML = ''; if (!t) { holder.append(h('div', { class: 'hint' }, 'No usable colors in this one')); return; } holder.append(preview(t, 'light'), preview(t, 'dark')); }).catch(() => { holder.textContent = 'Couldn’t load the preview'; });
  const run = (fn) => async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const t = await need(); if (!t) throw new Error('This repository has no usable dogtheme.json'); await fn(t); } catch (err) { toast(`Couldn’t get it: ${errText(err)}`, { error: true }); }
    b.disabled = false;
  };
  return h('div', { class: 'fs-card' },
    h('div', { class: 'fs-top' }, h('span', { class: 'ext-ic', html: icon('palette') }), h('div', { class: 'hi-main' }, h('b', {}, title), h('span', { class: 'hint' }, `by ${repo.owner?.login || '?'}${repo.stargazers_count ? ` · ★ ${repo.stargazers_count}` : ''}`))),
    holder,
    h('div', { class: 'fs-desc' }, repo.description || ''),
    h('div', { class: 'fs-acts' },
      h('button', { class: 'btn small primary', onclick: run((t) => applyTheme(t, t.name || title)) }, 'Use this theme'),
      h('button', { class: 'btn small', onclick: run(async (t) => { const n = addPreset(t, t.name || title); saveSettings(); toast(`Added “${n}” to your presets (Settings > Colors)`); }) }, 'Add to presets'),
      h('button', { class: 'btn small', onclick: () => api('shell:openExternal', repo.html_url) }, 'Open on GitHub'),
      h('button', { class: 'btn small with-ic fs-report', title: 'Something wrong with this theme? Tell Dogfile.', html: `${icon('info')}<span>Report</span>`, onclick: () => import('./bugreport.js').then((m) => m.reportBug({ mod: { name: title, author: repo.owner?.login, source: repo.html_url, version: '' } })) })));
}

export async function uploadTheme() {
  const S = state.settings;
  if (!(await api('secret:has', 'github')) && !(await signIn())) return;
  const choices = [['__current', 'The colors I use now'], ...Object.keys(S.colorPresets || {}).map((n) => [n, n])];
  const sel = h('select', { class: 'input' }, ...choices.map(([v, l]) => h('option', { value: v }, l)));
  const name = h('input', { class: 'input', placeholder: 'Theme name, e.g. Midnight Blue', maxlength: '40' });
  const desc = h('input', { class: 'input', placeholder: 'A short description (optional)', maxlength: '200' });
  for (const el of [name, desc]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const ok = await modal({ title: 'Upload a theme', width: 520, body: h('div', { class: 'stack' },
    h('label', { class: 'pp-row' }, h('span', {}, 'Colors'), sel), h('label', { class: 'pp-row' }, h('span', {}, 'Name'), name), h('label', { class: 'pp-row' }, h('span', {}, 'About'), desc),
    h('p', { class: 'hint' }, `It will be published publicly as github.com/${S.githubUser}/dogtheme-<name>, so anyone can find and use it. Upload again with the same name to update it. A theme is only colors: no code is shared.`)),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Upload', primary: true, run: (close) => (name.value.trim() ? close(true) : (toast('Give the theme a name'), false)) }] });
  if (!ok) return;
  const src = sel.value === '__current' ? currentTheme() : S.colorPresets[sel.value];
  const theme = sanitizeTheme({ ...src, name: name.value.trim(), author: S.githubUser, description: desc.value.trim() });
  if (!theme) return toast('Those colors are all the defaults, so there is nothing to share yet', { error: true });
  const slug = 'dogtheme-' + name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const full = `${S.githubUser}/${slug}`;
  try {
    toast('Uploading…');
    let repo = await gh('GET', `/repos/${full}`);
    if (repo.status === 404) {
      repo = await gh('POST', '/user/repos', { name: slug, description: (theme.description || `${theme.name}, a color theme for Dogfile`).slice(0, 300), auto_init: true, has_issues: true, has_wiki: false });
      if (!repo.ok) throw new Error(repo.json?.message || `GitHub said ${repo.status}`);
      await new Promise((r) => setTimeout(r, 1500));
    } else if (!repo.ok) throw new Error(repo.json?.message || `GitHub said ${repo.status}`);
    await gh('PUT', `/repos/${full}/topics`, { names: [THEME_TOPIC] });
    const put = async (path, text, msg) => {
      const cur = await gh('GET', `/repos/${full}/contents/${path}`);
      const r = await gh('PUT', `/repos/${full}/contents/${path}`, { message: msg, content: b64(text), sha: cur.ok ? cur.json.sha : undefined });
      if (!r.ok) throw new Error(r.json?.message || `GitHub said ${r.status}`);
    };
    await put(FILE, JSON.stringify({ type: 'atlas-colors', version: 1, ...theme }, null, 2), theme.name);
    await put('README.md', `# ${theme.name}\n\n${theme.description || ''}\n\nA color theme for **Dogfile**.\n\n**Use it:** in Dogfile, File > Features > Upload / download features…, open the Themes tab, find “${theme.name}” and press Use this theme.\n`, 'Readme');
    toast(`Uploaded to github.com/${full}`, { action: { label: 'Open', run: () => api('shell:openExternal', `https://github.com/${full}`) }, ms: 8000 });
  } catch (e) { toast(`Upload failed: ${errText(e)}`, { error: true, ms: 8000 }); }
}
