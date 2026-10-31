// Dogfile's half of build/ci/copybench.ps1: one copy through Dogfile's own engine, timed from start to finished.
// copybench.ps1 fills in the set, the destination and how many small files go at once, and starts Dogfile once per run.
(async () => {
  const api = (n, ...a) => window.atlas.invoke(n, ...a);
  const ev = (ch, ms) => new Promise((res) => { const off = window.atlas.on(ch, (d) => { off(); res(d); }); setTimeout(() => { off(); res(null); }, ms); });
  await api('ops:configure', { workers: __WORKERS__, fast: true });
  const fin = ev('ops:finished', 600000);
  const t0 = performance.now();
  const id = await api('ops:start', { type: 'copy', sources: ['__SRC__'], dest: '__DEST__' });
  const d = await fin;
  const sec = (performance.now() - t0) / 1000;
  const status = d && d.id === id ? d.status + (d.errors?.length ? ' ' + d.errors.length + ' problems: ' + d.errors[0] : '') : 'no event';
  await api('test:log', `BENCH ${sec.toFixed(3)} ${status}`);
  await api('win:control', 'quit').catch(() => {});
  return 'done';
})()
