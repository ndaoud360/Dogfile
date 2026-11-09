// The Git and Docker tabs of the terminal section. Git: what changed, stage / unstage / discard, diff, commit, push, pull,
// fetch, branches, stash, history. Docker: containers (start, stop, logs, shell), images, volumes, networks, Compose, clean-up.
// The work is done by backend/src/gitx.rs and backend/src/docker.rs, which run the git and docker programs.
import { api, h, esc, toast, bus, basename, errText, isVirtual } from './core.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { modal, confirm, prompt } from './dialogs.js';
import { runInTerminal } from './extras.js';

const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const btn = (label, onclick, opts = {}) => h('button', { class: 'btn small' + (opts.primary ? ' primary' : '') + (opts.danger ? ' danger' : ''), title: opts.title || '', ...(opts.disabled ? { disabled: '' } : {}), onclick }, ...(opts.icon ? [h('span', { html: icon(opts.icon) }), ' '] : []), label);
const timers = new Set();
const every = (fn, ms, alive) => { const t = setInterval(() => { if (!alive()) { clearInterval(t); timers.delete(t); return; } fn(); }, ms); timers.add(t); };

// =============================================================== Git
const STATUS = { M: 'changed', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict', '?': 'new' };
let gitSeq = 0;

export function mountGit(el, ctx) {
  const my = ++gitSeq;
  const alive = () => my === gitSeq && el.isConnected && el.dataset.on === 'git';
  el.innerHTML = '';
  let view = 'changes'; // or 'history'
  let sel = null; // { path, staged }
  let dir = ctx.dir();
  const head = h('div', { class: 'dv-head' });
  const body = h('div', { class: 'dv-body git' });
  el.append(head, body);
  const msgBox = h('textarea', { class: 'input dv-msg', rows: '2', placeholder: 'Commit message (what and why)', spellcheck: 'true' });
  const amend = h('input', { type: 'checkbox' });
  let O = null;

  const call = async (name, ...a) => { try { return await api(name, dir, ...a); } catch (e) { toast(errText(e), { error: true, ms: 8000 }); throw e; } };
  const refresh = async (keepSel) => {
    dir = ctx.dir();
    if (!dir || isVirtual(dir)) { O = null; draw(); return; }
    try { O = await api('git:overview', dir); } catch (e) { O = { error: errText(e) }; }
    if (!keepSel) sel = null;
    if (alive()) draw();
  };

  const branchMenu = async (ev) => {
    const [branches] = await Promise.all([api('git:branches', dir).catch(() => [])]);
    showMenu([
      ...branches.slice(0, 20).map((b) => ({ label: b.name, checked: b.current, keys: b.when, run: async () => { if (b.current) return; try { await api('git:checkout', dir, b.name); await refresh(); bus.emit('refreshPanes'); } catch (e) { toast(errText(e), { error: true }); } } })),
      { separator: true },
      { label: 'New branch…', icon: 'plus', run: async () => { const n = await prompt('New branch', '', { label: 'Branch name' }); if (n) { try { await api('git:checkout', dir, n.trim(), true); await refresh(); } catch (e) { toast(errText(e), { error: true }); } } } },
      { label: 'Merge a branch into this one…', icon: 'swap', disabled: branches.length < 2, submenu: branches.filter((b) => !b.current).slice(0, 20).map((b) => ({ label: b.name, run: async () => { if (await confirm('Merge?', `Merge “${esc(b.name)}” into “${esc(O.branch)}”?`, { ok: 'Merge' })) { try { toast(await call('git:merge', b.name)); refresh(); bus.emit('refreshPanes'); } catch { /* shown */ } } } })) },
      { label: 'Delete a branch…', icon: 'trash', disabled: branches.length < 2, submenu: branches.filter((b) => !b.current).slice(0, 20).map((b) => ({ label: b.name, run: async () => { if (await confirm('Delete branch?', `Delete “${esc(b.name)}”? Commits only on it can be lost.`, { ok: 'Delete', danger: true })) { try { await api('git:branchDelete', dir, b.name, true); refresh(); } catch (e) { toast(errText(e), { error: true }); } } } })) },
    ], ev.clientX, ev.clientY - 220);
  };

  const run = async (label, fn) => {
    toast(label + '…', { ms: 2000 });
    try { const r = await fn(); toast(typeof r === 'string' && r.trim() ? r.trim().split('\n').slice(-1)[0].slice(0, 160) : `${label}: done`, { ok: true }); } catch (e) { toast(errText(e), { error: true, ms: 9000 }); }
    await refresh(true);
    bus.emit('refreshPanes');
  };

  const commit = async () => {
    const message = msgBox.value;
    const go = async () => api('git:commit', dir, message, amend.checked);
    try {
      toast(await go(), { ok: true });
    } catch (e) {
      if (errText(e) === 'NEED_IDENTITY') {
        const id = await api('git:identity', dir).catch(() => ({ name: '', email: '' }));
        const n = h('input', { class: 'input', value: id.name, placeholder: 'Your name' }), m = h('input', { class: 'input', value: id.email, placeholder: 'you@example.com' });
        const g = h('input', { type: 'checkbox', checked: '' });
        const ok = await modal({ title: 'Who are you?', width: 420, body: h('div', {}, h('div', { class: 'hint' }, 'Git puts a name and email on each commit. Set them once.'), n, m, h('label', { class: 'sd-check' }, g, ' Use for all my repositories')), buttons: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, run: async (close) => { try { await api('git:setIdentity', dir, n.value, m.value, g.checked); close(true); } catch (er) { toast(errText(er), { error: true }); return false; } } }] });
        if (!ok) return;
        try { toast(await go(), { ok: true }); } catch (e2) { toast(errText(e2), { error: true, ms: 9000 }); return; }
      } else { toast(errText(e), { error: true, ms: 9000 }); return; }
    }
    msgBox.value = ''; amend.checked = false;
    await refresh();
    bus.emit('refreshPanes');
  };

  const rowFor = (f, staged) => {
    const letter = staged ? f.x : f.untracked ? '?' : f.conflicted ? 'U' : f.y;
    const full = f.path;
    return h('div', { class: 'git-row' + (sel?.path === full && sel?.staged === staged ? ' sel' : '') + (f.conflicted ? ' conflict' : '') },
      h('span', { class: 'git-st st-' + letter, title: STATUS[letter] || '' }, letter),
      h('span', { class: 'git-path', title: full, onclick: () => { sel = { path: full, staged, untracked: f.untracked }; draw(); showDiff(); } }, f.orig ? `${f.orig} → ${f.path}` : f.path),
      staged
        ? h('button', { class: 'icon-btn small', title: 'Unstage', html: icon('minus'), onclick: () => run('Unstage', () => api('git:unstage', dir, [full])) })
        : h('span', { class: 'git-acts' },
          h('button', { class: 'icon-btn small', title: 'Discard this change (can’t be undone)', html: icon('restore'), onclick: async () => { if (await confirm('Discard changes?', `${f.untracked ? 'Delete the new file' : 'Throw away the changes in'} “${esc(full)}”? This can’t be undone.`, { ok: 'Discard', danger: true })) run('Discard', () => api('git:discard', dir, [full], !!f.untracked)); } }),
          h('button', { class: 'icon-btn small', title: 'Stage', html: icon('plus'), onclick: () => run('Stage', () => api('git:stage', dir, [full])) })));
  };

  const diffBox = h('pre', { class: 'git-diff' }, 'Choose a file to see what changed.');
  async function showDiff() {
    if (!sel) { diffBox.textContent = 'Choose a file to see what changed.'; return; }
    diffBox.textContent = 'Loading…';
    try {
      const r = await api('git:diff', dir, sel.path, sel.staged);
      diffBox.innerHTML = '';
      for (const l of (r.text || 'No changes to show.').split('\n')) diffBox.append(h('div', { class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '' }, l || ' '));
      if (r.truncated) diffBox.append(h('div', { class: 'hint' }, '… (the rest is cut off)'));
    } catch (e) { diffBox.textContent = errText(e); }
  }

  async function drawHistory() {
    body.innerHTML = '';
    const list = h('div', { class: 'git-hist' }, 'Loading…');
    body.append(list);
    try {
      const log = await api('git:log', dir, 60);
      list.innerHTML = '';
      for (const c of log) list.append(h('div', { class: 'git-commit' }, h('code', {}, c.hash), h('span', { class: 'git-subj' }, c.subject), h('span', { class: 'hint' }, `${c.author} · ${c.when || c.date || ''}`)));
      if (!log.length) list.textContent = 'No commits yet.';
    } catch (e) { list.textContent = errText(e); }
  }

  function draw() {
    head.innerHTML = '';
    body.innerHTML = '';
    if (!dir || isVirtual(dir)) { body.append(h('div', { class: 'hint pad' }, 'Open a folder on this PC to use Git.')); return; }
    if (!O) { body.append(h('div', { class: 'hint pad' }, 'Looking…')); return; }
    if (O.error) { body.append(h('div', { class: 'hint pad' }, O.error)); head.append(btn('Refresh', () => refresh(), { icon: 'refresh' })); return; }
    if (!O.repo) {
      body.append(h('div', { class: 'dv-empty' }, h('div', { class: 'confirm-msg' }, `“${basename(dir) || dir}” isn’t a Git repository.`),
        h('div', { class: 'ps-tools', style: { justifyContent: 'center' } },
          btn('Start a repository here', () => run('Start a repository', () => api('git:init', dir)), { primary: true, icon: 'git' }),
          btn('Clone a repository…', async () => {
            const url = await prompt('Clone a repository', '', { label: 'Address (https://… or git@…)' });
            if (!url) return;
            try { toast('Cloning…', { ms: 4000 }); const p = await api('git:clone', url.trim(), dir); toast('Cloned', { ok: true }); bus.emit('navigate', p); } catch (e) { toast(errText(e), { error: true, ms: 9000 }); }
          }, { icon: 'download' }))));
      return;
    }
    const staged = O.files.filter((f) => f.staged), unstaged = O.files.filter((f) => f.unstaged && !f.untracked), untracked = O.files.filter((f) => f.untracked);
    const sync = `${O.ahead ? `↑${O.ahead} ` : ''}${O.behind ? `↓${O.behind}` : ''}`.trim();
    head.append(
      h('button', { class: 'chip', title: 'Branches', onclick: branchMenu }, h('span', { html: icon('git') }), ' ', O.detached ? `detached ${O.oid.slice(0, 7)}` : O.branch, sync ? h('b', { class: 'git-ab' }, ' ' + sync) : null),
      h('span', { class: 'hint' }, O.upstream ? `tracking ${O.upstream}` : 'no upstream'),
      h('span', { class: 'st-spacer' }),
      h('button', { class: 'chip' + (view === 'changes' ? ' on' : ''), onclick: () => { view = 'changes'; draw(); } }, `Changes (${O.files.length})`),
      h('button', { class: 'chip' + (view === 'history' ? ' on' : ''), onclick: () => { view = 'history'; draw(); } }, 'History'),
      btn('Fetch', () => run('Fetch', () => api('git:fetch', dir)), { icon: 'refresh', title: 'Check the remote for new commits' }),
      btn('Pull', (ev) => showMenu([
        { label: 'Pull (only if it can move forward)', run: () => run('Pull', () => api('git:sync', dir, 'ff')) },
        { label: 'Pull and rebase my commits', run: () => run('Pull and rebase', () => api('git:sync', dir, 'rebase')) },
        { label: 'Pull and merge', run: () => run('Pull and merge', () => api('git:sync', dir, 'merge')) },
      ], ev.clientX, ev.clientY - 90), { icon: 'download', title: 'Bring in new commits' }),
      btn(O.ahead ? `Push ${O.ahead}` : 'Push', () => run('Push', () => api('git:push', dir)), { primary: !!O.ahead, icon: 'upload', title: O.upstream ? 'Send your commits' : 'Publish this branch' }),
      btn(O.stashes ? `Stash (${O.stashes})` : 'Stash', async (ev) => {
        const items = await api('git:stash', dir, 'list').catch(() => []);
        showMenu([
          { label: 'Stash my changes…', disabled: !O.files.length, run: async () => { const m = await prompt('Stash changes', '', { label: 'Name (optional)' }); if (m !== null) run('Stash', () => api('git:stash', dir, 'push', m || '')); } },
          { separator: true },
          ...items.map((s) => ({ label: `${s.message || s.ref} · ${s.when}`, submenu: [
            { label: 'Apply and remove (pop)', run: () => run('Pop stash', () => api('git:stash', dir, 'pop', s.ref)) },
            { label: 'Apply and keep', run: () => run('Apply stash', () => api('git:stash', dir, 'apply', s.ref)) },
            { label: 'Delete', danger: true, run: async () => { if (await confirm('Delete this stash?', 'Its changes are lost.', { ok: 'Delete', danger: true })) run('Delete stash', () => api('git:stash', dir, 'drop', s.ref)); } },
          ] })),
          !items.length && { label: 'Nothing stashed', disabled: true },
        ], ev.clientX, ev.clientY - 120);
      }, { icon: 'stack' }),
      btn('', () => refresh(), { icon: 'refresh', title: 'Refresh' }));
    if (view === 'history') { drawHistory(); return; }
    const left = h('div', { class: 'git-left' },
      h('div', { class: 'git-sec' }, h('b', {}, `Staged (${staged.length})`), staged.length ? btn('Unstage all', () => run('Unstage all', () => api('git:unstage', dir, []))) : null),
      ...staged.map((f) => rowFor(f, true)),
      h('div', { class: 'git-sec' }, h('b', {}, `Changes (${unstaged.length + untracked.length})`), unstaged.length + untracked.length ? btn('Stage all', () => run('Stage all', () => api('git:stage', dir, []))) : null),
      ...unstaged.map((f) => rowFor(f, false)), ...untracked.map((f) => rowFor(f, false)),
      !O.files.length ? h('div', { class: 'hint pad' }, 'Nothing to commit. The folder matches the last commit.') : null,
      h('div', { class: 'git-commit-box' }, msgBox,
        h('div', { class: 'git-commit-row' }, h('label', { class: 'sd-check' }, amend, ' Amend the last commit'),
          btn(staged.length ? `Commit ${staged.length}` : 'Commit', commit, { primary: true, disabled: !staged.length && !amend.checked, title: staged.length ? 'Save the staged changes as a commit' : 'Stage something first' }))));
    body.append(left, diffBox);
    if (sel) showDiff();
  }

  every(() => refresh(true), 8000, alive);
  refresh();
  return { refresh };
}

// =============================================================== Docker
let dockSeq = 0;
const STATE_DOT = { running: 'ok', paused: 'warn', restarting: 'warn', exited: 'off', created: 'off', dead: 'bad' };

export function mountDocker(el, ctx) {
  const my = ++dockSeq;
  const alive = () => my === dockSeq && el.isConnected && el.dataset.on === 'docker';
  el.innerHTML = '';
  let tab = 'containers';
  let S = null, C = [], ST = {}, I = [], V = [], N = [], composeFile = null, composeOut = '';
  const head = h('div', { class: 'dv-head' });
  const body = h('div', { class: 'dv-body' });
  el.append(head, body);

  const ctl = async (label, fn) => {
    try { toast(label + '…', { ms: 1800 }); const r = await fn(); toast(typeof r === 'string' && r.trim() ? r.trim().split('\n').slice(-1)[0].slice(0, 160) : `${label}: done`, { ok: true }); } catch (e) { toast(errText(e), { error: true, ms: 9000 }); }
    await load();
  };
  const act = (kind, op, ids, label) => ctl(label || `${op} ${plural(ids.length, kind)}`, () => api('docker:action', kind, op, ids));

  async function load() {
    try { S = await api('docker:status'); } catch (e) { S = { installed: false, error: errText(e) }; }
    if (!alive()) return;
    if (S.running) {
      try {
        const dir = ctx.dir();
        [C, I, V, N] = await Promise.all([api('docker:containers'), api('docker:images'), api('docker:volumes'), api('docker:networks')]);
        composeFile = dir && !isVirtual(dir) ? await api('docker:composeFile', dir).catch(() => null) : null;
        ST = C.some((c) => c.state === 'running') ? await api('docker:stats').catch(() => ({})) : {};
      } catch (e) { toast(errText(e), { error: true }); }
    }
    if (alive()) draw();
  }

  async function showLogs(c) {
    const pre = h('pre', { class: 'git-diff dv-logs' }, 'Loading…');
    const fill = async () => { try { pre.textContent = (await api('docker:logs', c.id, 400)) || '(no output)'; pre.scrollTop = pre.scrollHeight; } catch (e) { pre.textContent = errText(e); } };
    fill();
    await modal({ title: `Logs: ${c.name}`, width: 860, body: pre, buttons: [{ label: 'Refresh', left: true, run: () => { fill(); return false; } }, { label: 'Follow in the terminal', run: (close) => { close(null); runInTerminal({ command: `docker logs -f --tail 100 ${c.id}` }); } }, { label: 'Close', primary: true, value: null }] });
  }
  async function showText(title, text) { await modal({ title, width: 860, body: h('pre', { class: 'git-diff dv-logs' }, text), buttons: [{ label: 'Close', primary: true, value: null }] }); }

  const containerRow = (c) => {
    const st = ST[c.id] || ST[c.shortId] || null;
    const on = c.state === 'running';
    return h('div', { class: 'dv-row' },
      h('span', { class: 'dv-dot ' + (STATE_DOT[c.state] || 'off'), title: c.state }),
      h('div', { class: 'dv-main' }, h('b', {}, c.name), h('span', { class: 'hint' }, ` ${c.image}`), h('div', { class: 'hint' }, `${c.status}${c.ports ? ' · ' + c.ports : ''}${st ? ` · CPU ${st.cpu} · ${String(st.mem).split(' / ')[0]}` : ''}`)),
      h('div', { class: 'dv-acts' },
        on ? btn('Stop', () => act('container', 'stop', [c.id], `Stopping ${c.name}`), { icon: 'stop' }) : btn('Start', () => act('container', 'start', [c.id], `Starting ${c.name}`), { icon: 'pplay', primary: true }),
        btn('', () => act('container', 'restart', [c.id], `Restarting ${c.name}`), { icon: 'refresh', title: 'Restart', disabled: !on }),
        btn('Logs', () => showLogs(c), { icon: 'page' }),
        btn('Shell', () => runInTerminal({ command: `docker exec -it ${c.id} sh -c "command -v bash >/dev/null && exec bash || exec sh"` }), { icon: 'terminal', title: 'Open a shell inside the container', disabled: !on }),
        btn('', (ev) => showMenu([
          { label: 'Inspect (details)', run: async () => showText(`Inspect: ${c.name}`, await api('docker:inspect', c.id).catch(errText)) },
          { label: on ? 'Pause' : 'Resume', disabled: !on && c.state !== 'paused', run: () => act('container', c.state === 'paused' ? 'unpause' : 'pause', [c.id]) },
          { label: 'Kill', disabled: !on, run: () => act('container', 'kill', [c.id]) },
          { separator: true },
          { label: 'Remove', icon: 'trash', danger: true, run: async () => { if (await confirm('Remove container?', `Remove “${esc(c.name)}”${on ? ' (it is running and will be stopped first)' : ''}? Its own data is lost unless it uses a volume.`, { ok: 'Remove', danger: true })) act('container', on ? 'rmf' : 'rm', [c.id], `Removing ${c.name}`); } },
        ], ev.clientX, ev.clientY - 160), { icon: 'more', title: 'More' })));
  };

  function draw() {
    head.innerHTML = ''; body.innerHTML = '';
    if (!S) { body.append(h('div', { class: 'hint pad' }, 'Looking for Docker…')); return; }
    if (!S.installed) { body.append(h('div', { class: 'dv-empty' }, h('div', { class: 'confirm-msg' }, 'Docker isn’t installed on this PC.'), h('div', { class: 'hint' }, 'Install Docker Desktop, then reopen this tab.'), btn('Get Docker Desktop', () => api('shell:openExternal', 'https://www.docker.com/products/docker-desktop/'), { primary: true, icon: 'link' }))); return; }
    if (!S.running) { body.append(h('div', { class: 'dv-empty' }, h('div', { class: 'confirm-msg' }, 'Docker is installed but its engine isn’t running.'), S.error ? h('div', { class: 'hint' }, S.error) : null, h('div', { class: 'ps-tools', style: { justifyContent: 'center' } }, btn('Start Docker Desktop', async () => { try { await api('docker:startEngine'); toast('Starting Docker… this takes a moment', { ms: 5000 }); } catch (e) { toast(errText(e), { error: true }); } }, { primary: true, icon: 'pplay' }), btn('Check again', () => load(), { icon: 'refresh' })))); return; }
    const tabBtn = (id, label, n) => h('button', { class: 'chip' + (tab === id ? ' on' : ''), onclick: () => { tab = id; draw(); } }, label + (n != null ? ` (${n})` : ''));
    head.append(h('span', { class: 'hint' }, `Docker ${S.version || ''} · ${S.running_count ?? 0} running of ${S.containers ?? 0}`),
      h('span', { class: 'st-spacer' }),
      tabBtn('containers', 'Containers', C.length), tabBtn('images', 'Images', I.length), tabBtn('volumes', 'Volumes', V.length), tabBtn('networks', 'Networks', N.length), tabBtn('compose', 'Compose', composeFile ? 1 : null),
      btn('Clean up', (ev) => showMenu([
        { label: 'Remove stopped containers', run: () => pruneAsk('containers', 'all stopped containers') },
        { label: 'Remove unused images', run: () => pruneAsk('images', 'images that nothing uses (untagged)') },
        { label: 'Remove unused volumes', run: () => pruneAsk('volumes', 'volumes no container uses. Their data is lost') },
        { label: 'Remove unused networks', run: () => pruneAsk('networks', 'networks no container uses') },
      ], ev.clientX, ev.clientY - 120), { icon: 'broom', title: 'Free space' }),
      btn('', () => load(), { icon: 'refresh', title: 'Refresh' }));
    if (tab === 'containers') {
      if (!C.length) body.append(h('div', { class: 'hint pad' }, 'No containers yet. Start one from an image, or use Compose.'));
      const groups = new Map();
      for (const c of C) { const k = c.compose || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
      for (const [proj, list] of [...groups].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))) {
        if (proj) body.append(h('div', { class: 'dv-group' }, h('b', {}, `Compose: ${proj}`), h('span', { class: 'hint' }, ` ${plural(list.length, 'container')}`)));
        else if (groups.size > 1) body.append(h('div', { class: 'dv-group' }, h('b', {}, 'Other containers')));
        for (const c of list) body.append(containerRow(c));
      }
    } else if (tab === 'images') {
      if (!I.length) body.append(h('div', { class: 'hint pad' }, 'No images.'));
      for (const i of I) body.append(h('div', { class: 'dv-row' }, h('div', { class: 'dv-main' }, h('b', {}, i.dangling ? '(untagged)' : i.ref), h('div', { class: 'hint' }, `${i.shortId} · ${i.size} · ${i.created}`)),
        h('div', { class: 'dv-acts' }, btn('Run…', async () => { const extra = await prompt('Run an image', '', { label: `docker run -it --rm ${i.ref} …` }); if (extra !== null) runInTerminal({ command: `docker run -it --rm ${i.ref} ${extra}`.trim() }); }, { icon: 'pplay' }),
          btn('', async () => { if (await confirm('Remove image?', `Remove “${esc(i.dangling ? i.shortId : i.ref)}”?`, { ok: 'Remove', danger: true })) act('image', 'rm', [i.ref], 'Removing the image'); }, { icon: 'trash', title: 'Remove' }))));
      body.append(h('div', { class: 'dv-foot' }, btn('Pull an image…', async () => { const n = await prompt('Pull an image', '', { label: 'e.g. nginx:latest' }); if (n) ctl(`Pulling ${n}`, () => api('docker:pull', n.trim())); }, { icon: 'download' })));
    } else if (tab === 'volumes') {
      if (!V.length) body.append(h('div', { class: 'hint pad' }, 'No volumes.'));
      for (const v of V) body.append(h('div', { class: 'dv-row' }, h('div', { class: 'dv-main' }, h('b', {}, v.name), h('div', { class: 'hint' }, `${v.driver} · ${v.scope}`)), h('div', { class: 'dv-acts' }, btn('', async () => { if (await confirm('Remove volume?', `Remove “${esc(v.name)}”? Its data is lost.`, { ok: 'Remove', danger: true })) act('volume', 'rm', [v.name], 'Removing the volume'); }, { icon: 'trash', title: 'Remove' }))));
    } else if (tab === 'networks') {
      for (const n of N) body.append(h('div', { class: 'dv-row' }, h('div', { class: 'dv-main' }, h('b', {}, n.name), h('div', { class: 'hint' }, `${n.driver} · ${n.scope}`)), h('div', { class: 'dv-acts' }, ['bridge', 'host', 'none'].includes(n.name) ? null : btn('', async () => { if (await confirm('Remove network?', `Remove “${esc(n.name)}”?`, { ok: 'Remove', danger: true })) act('network', 'rm', [n.id], 'Removing the network'); }, { icon: 'trash', title: 'Remove' }))));
    } else {
      const dir = ctx.dir();
      if (!composeFile) body.append(h('div', { class: 'hint pad' }, `No Compose file (compose.yaml or docker-compose.yml) in ${dir ? '“' + basename(dir) + '”' : 'this folder'}. Open a folder that has one.`));
      else {
        const run = (op, label) => ctl(label, async () => { composeOut = await api('docker:compose', dir, op); return `${label}: done`; });
        body.append(h('div', { class: 'dv-compose' },
          h('div', {}, h('b', {}, composeFile), h('span', { class: 'hint' }, ` in ${dir}`)),
          h('div', { class: 'ps-tools' }, btn('Up', () => run('up', 'Starting the project'), { primary: true, icon: 'pplay' }), btn('Down', () => run('down', 'Stopping and removing the project'), { icon: 'stop' }), btn('Restart', () => run('restart', 'Restarting'), { icon: 'refresh' }), btn('Pull', () => run('pull', 'Pulling images'), { icon: 'download' }), btn('Build', () => run('build', 'Building'), { icon: 'wand' }), btn('Status', () => run('ps', 'Status')), btn('Logs', () => run('logs', 'Reading logs'))),
          composeOut ? h('pre', { class: 'git-diff' }, composeOut) : null));
      }
    }
  }
  async function pruneAsk(what, text) {
    if (await confirm('Clean up Docker?', `This removes ${esc(text)}. It can’t be undone.`, { ok: 'Remove', danger: true })) ctl('Cleaning up', () => api('docker:prune', what));
  }

  every(load, 6000, alive);
  load();
  return { refresh: load };
}

/** a Compose action from a file's right-click menu: show the Docker tab on that folder */
export function composeHere(op, dir) { bus.emit('termTab', 'docker'); if (op) api('docker:compose', dir, op).then((o) => toast(String(o).trim().split('\n').slice(-1)[0] || 'Done', { ok: true }), (e) => toast(errText(e), { error: true, ms: 9000 })); }
