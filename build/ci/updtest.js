// CI: the auto-updater end to end on Windows: check, download, install (Dogfile closes, the files are swapped,
// Dogfile starts again), then the restarted copy reports what it finds.
(async () => {
  const api = (n, ...a) => window.atlas.invoke(n, ...a);
  const log = (s) => api('test:log', s);
  try {
    const info = await api('sys:info');
    const dir = info.exe.replace(/[\\/][^\\/]+$/, '');
    if (await api('fs:exists', dir + '\\updated.txt')) {
      const c = await api('fs:readText', dir + '\\components.json').catch(() => ({ text: 'none' }));
      await log('UPDATE APPLIED: restarted from ' + info.exe + ', components ' + c.text.replace(/\s+/g, ' '));
      return;
    }
    const s = await api('update:check');
    await log('check: available=' + s.available + ' latest=' + s.latest + ' size=' + s.size + ' error=' + s.error);
    const progress = [];
    window.atlas.on('update:progress', (p) => progress.push(p.stage));
    const d = await api('update:download');
    await log('download: ready=' + d.ready + ' stages=' + [...new Set(progress)].join(','));
    const r = await api('update:install');
    await log('install: ' + JSON.stringify(r));
  } catch (e) { await log('ERR ' + (e && e.message || e)); }
})()
