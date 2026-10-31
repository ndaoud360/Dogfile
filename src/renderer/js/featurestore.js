// Feature browser: share and download Dogfile features through GitHub (free). Every shared feature is a public
// GitHub repository with the topic "dogfile-mod" and an dogmod.json file. Browsing needs no
// account; sharing needs a GitHub account and a token, which is stored encrypted on this PC and only ever sent to
// GitHub. Before anything installs you see exactly what it may do and its full code.
import { api, state, bus, h, esc, toast, saveSettings, fmtDate } from './core.js';
import { modal, prompt, confirm } from './dialogs.js';
import { icon } from './icons.js';
import * as X from './extensions.js';
import { requirePro } from './license.js';

const TOPIC = 'dogfile-mod';
const gh = async (method, path, body, auth = true) => { const r = await api('gh:request', method, path, body ?? null, auth); return r; };
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ''))));

export async function signIn() {
  const tokenIn = h('input', { class: 'input', type: 'password', placeholder: 'ghp_… or github_pat_…', autocomplete: 'off' });
  tokenIn.addEventListener('keydown', (e) => e.stopPropagation());
  const res = h('div', { class: 'hint' });
  const ok = await modal({ title: 'Sign in to share features', width: 560, body: h('div', { class: 'stack' },
    h('p', {}, 'Dogfile uses GitHub to share features for free. Downloading needs no account. To upload, sign in with a GitHub access token:'),
    h('ol', { class: 'fs-steps' },
      h('li', {}, 'Make a free account at github.com if you don’t have one.'),
      h('li', {}, h('button', { class: 'link', onclick: () => api('shell:openExternal', 'https://github.com/settings/tokens/new?scopes=public_repo&description=Dogfile%20Files%20features') }, 'Create a token'), ' (the “public_repo” box is already ticked: Dogfile can only create and update public repositories for your features).'),
      h('li', {}, 'Paste it here.')),
    tokenIn, res,
    h('div', { class: 'hint' }, 'The token is encrypted with Windows data protection, stays on this PC, and is only sent to GitHub. Sign out any time to delete it.')),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Sign in', primary: true, run: async (close) => {
      const tok = tokenIn.value.trim(); if (!tok) return false;
      res.textContent = 'Checking…';
      try { await api('secret:set', 'github', tok); } catch (e) { res.textContent = `The token couldn’t be saved: ${String(e?.message || e).replace(/^Error:\s*/, '')}`; return false; }
      const r = await gh('GET', '/user');
      if (!r.ok) { await api('secret:set', 'github', ''); res.textContent = r.status === 401 ? 'GitHub didn’t accept that token.' : `GitHub said: ${r.json?.message || r.status}`; return false; }
      state.settings.githubUser = r.json.login; saveSettings();
      close(true);
    } }] });
  if (ok) toast(`Signed in as ${state.settings.githubUser}`);
  return ok;
}
export async function signOut() {
  try { await api('secret:set', 'github', ''); } catch (e) { return toast(`Couldn’t delete the token from this PC: ${String(e?.message || e).replace(/^Error:\s*/, '')}`, { error: true }); }
  state.settings.githubUser = null; saveSettings(); toast('Signed out. The token was deleted from this PC.');
}

async function manifestOf(repo) {
  const r = await gh('GET', `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/dogmod.json`, null, false);
  if (r.json?.code) return r.json;
  // fall back to the API (private mirrors, renamed branches)
  const c = await gh('GET', `/repos/${repo.full_name}/contents/dogmod.json`);
  if (c.ok && c.json?.content) { try { return JSON.parse(unb64(c.json.content)); } catch {} }
  return null;
}

export async function featureBrowser() {
  if (!requirePro('features')) return;
  const q = h('input', { class: 'input', placeholder: 'Search features (e.g. screenplay, rename, photos)…', spellcheck: 'false' });
  q.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') load(); });
  let target = '';
  const tchips = h('div', { class: 'row-inline wrap' }, ...[['', 'All'], ...Object.entries(X.TARGETS)].map(([k, l]) => { const b = h('button', { class: 'chip' + (k === target ? ' on' : '') }, l); b.onclick = () => { target = k; tchips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); load(); }; return b; }));
  const grid = h('div', { class: 'fs-grid' });
  const status = h('div', { class: 'hint' });
  const account = h('div', { class: 'fs-acct' });
  const drawAccount = async () => {
    account.innerHTML = '';
    const has = await api('secret:has', 'github');
    if (has && state.settings.githubUser) account.append(h('span', { class: 'hint' }, `Signed in as ${state.settings.githubUser}`), h('button', { class: 'btn small primary', onclick: () => uploadDialog() }, 'Upload a feature…'), h('button', { class: 'btn small', onclick: async () => { await signOut(); drawAccount(); } }, 'Sign out'));
    else account.append(h('span', { class: 'hint' }, 'Sign in to upload your own features'), h('button', { class: 'btn small', onclick: async () => { if (await signIn()) drawAccount(); } }, 'Sign in with GitHub…'));
  };
  const card = (repo) => {
    const el = h('div', { class: 'fs-card' }, h('div', { class: 'fs-top' }, h('span', { class: 'ext-ic', html: icon('puzzle') }), h('div', { class: 'hi-main' }, h('b', {}, (repo.name || '').replace(/^atlas-feature-/, '').replace(/-/g, ' ')), h('span', { class: 'hint' }, `by ${repo.owner?.login} · ★ ${repo.stargazers_count} · updated ${fmtDate(Date.parse(repo.pushed_at || repo.updated_at))}`))),
      h('div', { class: 'fs-desc' }, repo.description || ''), h('div', { class: 'fs-tags' }, ...(repo.topics || []).filter((t) => t.startsWith('dogfile-target-')).map((t) => h('span', { class: 'as-chip' }, X.TARGETS[t.slice(13)] || t.slice(13)))));
    const acts = h('div', { class: 'fs-acts' });
    const installed = (state.settings.extensions || []).find((f) => f.storeRef?.repo === repo.full_name);
    acts.append(h('button', { class: 'btn small primary', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Getting it…';
      try {
        const m = await manifestOf(repo);
        if (!m?.code) throw new Error('This repository has no dogmod.json');
        const F = await import('./features.js');
        await F.install(m.code, { source: `github.com/${repo.full_name}`, meta: { ...m, author: m.author || repo.owner?.login, storeRef: { repo: repo.full_name, branch: repo.default_branch, version: m.version || '' } } });
      } catch (err) { toast(`Couldn’t get it: ${err.message}`, { error: true }); }
      e.target.disabled = false; e.target.textContent = installed ? 'Reinstall' : 'Install';
    } }, installed ? 'Reinstall' : 'Install'), h('button', { class: 'btn small', onclick: () => api('shell:openExternal', repo.html_url) }, 'Open on GitHub'), h('button', { class: 'btn small with-ic fs-report', title: 'Something wrong with this mod (it breaks things, does something it shouldn’t, or is harmful)? Tell Dogfile.', html: `${icon('info')}<span>Report</span>`, onclick: () => import('./bugreport.js').then((m) => m.reportBug({ mod: { name: (repo.name || '').replace(/^atlas-feature-/, '').replace(/-/g, ' '), author: repo.owner?.login, source: repo.html_url, version: installed?.version || installed?.storeRef?.version || '' } })) }));
    el.append(acts);
    return el;
  };
  const load = async () => {
    grid.innerHTML = ''; status.textContent = 'Loading…';
    const terms = [`topic:${TOPIC}`, target ? `topic:dogfile-target-${target}` : '', q.value.trim()].filter(Boolean).join(' ');
    const r = await gh('GET', `/search/repositories?q=${encodeURIComponent(terms)}&sort=stars&order=desc&per_page=40`, null, true).catch((e) => ({ ok: false, json: { message: e.message } }));
    if (!r.ok) { status.textContent = r.status === 403 ? 'GitHub is limiting searches right now. Wait a minute (or sign in) and try again.' : `Couldn’t reach GitHub: ${r.json?.message || r.status || 'offline?'}`; return; }
    const items = r.json.items || [];
    status.textContent = items.length ? `${r.json.total_count} feature${r.json.total_count === 1 ? '' : 's'}` : 'No features found yet. Be the first to share one!';
    for (const repo of items) grid.append(card(repo));
  };
  drawAccount();
  load();
  await modal({ title: 'Feature browser', width: 900, className: 'fs-modal', body: h('div', { class: 'stack' }, h('div', { class: 'fs-bar' }, q, h('button', { class: 'btn small', onclick: load }, 'Search')), tchips, account, status, grid,
    h('div', { class: 'hint' }, 'Features are shared by other people and aren’t checked by Dogfile. You’ll see what each one can do before you install it.')),
    buttons: [{ label: 'Close', primary: true, value: true }] });
}

export async function uploadDialog() {
  const mine = state.settings.extensions || [];
  if (!mine.length) return toast('Install or create a feature first (Features > Create…)');
  if (!(await api('secret:has', 'github')) && !(await signIn())) return;
  const sel = h('select', { class: 'input' }, ...mine.map((f) => h('option', { value: f.id }, `${f.name} (${X.TARGETS[f.target] || f.target})`)));
  const rulesOk = h('input', { type: 'checkbox' });
  const ok = await modal({ title: 'Upload a feature', width: 560, body: h('div', { class: 'stack' }, h('label', { class: 'pp-row' }, h('span', {}, 'Feature'), sel),
    h('p', { class: 'hint' }, `It will be published publicly as github.com/${state.settings.githubUser}/dogmod-<name>, so anyone can find and install it. Upload again to update it.`),
    h('div', { class: 'ext-rules' }, h('b', {}, 'Before you share, check that your feature:'), h('ul', {},
      h('li', {}, 'does what its name and description say'),
      h('li', {}, 'asks only for the permissions it needs'),
      h('li', {}, 'doesn’t change files the person didn’t choose, and confirms before changing many'),
      h('li', {}, 'only uses the internet for what the description says, and never sends file contents or personal data elsewhere'),
      h('li', {}, 'is readable code (not minified or hidden) that you have the right to share')),
      h('button', { class: 'link', onclick: async () => { const p = await api('docs:featureGuide'); (await import('./apptabs.js')).openTool('editor', [p]); } }, 'Read the feature guide')),
    h('label', { class: 'check-row' }, rulesOk, h('span', {}, 'My feature follows these rules'))),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Upload', primary: true, run: (close) => (rulesOk.checked ? close(true) : (toast('Tick the box to confirm your feature follows the rules'), false)) }] });
  if (!ok) return;
  const f = mine.find((x) => x.id === sel.value);
  const user = state.settings.githubUser;
  const slug = 'dogmod-' + (f.id || f.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const full = `${user}/${slug}`;
  try {
    toast('Uploading…');
    let repo = await gh('GET', `/repos/${full}`);
    if (repo.status === 404) {
      repo = await gh('POST', '/user/repos', { name: slug, description: (f.description || f.name).slice(0, 300), auto_init: true, has_issues: true, has_wiki: false, homepage: '' });
      if (!repo.ok) throw new Error(repo.json?.message || `GitHub said ${repo.status}`);
      await new Promise((r) => setTimeout(r, 1500));
    } else if (!repo.ok) throw new Error(repo.json?.message || `GitHub said ${repo.status}`);
    await gh('PUT', `/repos/${full}/topics`, { names: [TOPIC, `dogfile-target-${f.target || 'files'}`] });
    const put = async (path, text, msg) => {
      const cur = await gh('GET', `/repos/${full}/contents/${path}`);
      const r = await gh('PUT', `/repos/${full}/contents/${path}`, { message: msg, content: b64(text), sha: cur.ok ? cur.json.sha : undefined });
      if (!r.ok) throw new Error(r.json?.message || `GitHub said ${r.status}`);
    };
    const manifest = { ...JSON.parse(X.featureFile(f)), author: f.author || user };
    await put('dogmod.json', JSON.stringify(manifest, null, 2), `${f.name} ${f.version || ''}`.trim());
    await put('README.md', `# ${f.name}\n\n${f.description || ''}\n\nA feature for **Dogfile** (${X.TARGETS[f.target] || f.target}).\n\n**Install:** in Dogfile, File > Features > Upload / download features…, search for “${f.name}”, press Install.\n\n**It may:** ${(f.permissions || []).length ? f.permissions.map((p) => X.PERMS[p]?.[0]).join(', ') : 'only work inside its own app (no file, internet or command access)'}.\n`, 'Readme');
    f.storeRef = { repo: full, branch: repo.json?.default_branch || 'main', version: f.version || '' };
    saveSettings();
    toast(`Uploaded to github.com/${full}`, { action: { label: 'Open', run: () => api('shell:openExternal', `https://github.com/${full}`) }, ms: 8000 });
  } catch (e) { toast(`Upload failed: ${e.message}`, { error: true, ms: 8000 }); }
}

export async function checkUpdate(f) {
  if (!f.storeRef) return;
  const repo = await gh('GET', `/repos/${f.storeRef.repo}`);
  if (!repo.ok) return toast('Couldn’t reach that feature on GitHub', { error: true });
  const m = await manifestOf(repo.json);
  if (!m?.code) return toast('No feature file found there', { error: true });
  if (m.code === f.code) return toast(`“${f.name}” is up to date`);
  const F = await import('./features.js');
  await F.install(m.code, { source: `github.com/${f.storeRef.repo} (update)`, meta: { ...m, storeRef: { ...f.storeRef, version: m.version || '' } } });
}
bus.on('featureStore', featureBrowser);
