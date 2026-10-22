// CI: downloads the Notepad writing helper and checks it writes, on the processor and (where it works) the graphics card.
(async () => {
  const api = (n, ...a) => window.atlas.invoke(n, ...a);
  const log = (s) => api('test:log', s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const ai = await import(new URL('js/ai.js', location.href).href);
    const kind = await ai.writerKind();
    await log('webgpu adapter: ' + (kind === 'writer-gpu'));
    for (const k of ['writer', kind === 'writer-gpu' ? 'writer-gpu' : null].filter(Boolean)) {
      const t0 = Date.now();
      await api('ai:download', k);
      for (;;) { await wait(2000); const st = (await api('ai:status'))[k]; if (st.ready) break; if (st.progress?.error) throw new Error(st.progress.error); if (Date.now() - t0 > 900000) throw new Error('download timeout'); }
      await log(`downloaded ${k} in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    for (const dev of ['wasm', kind === 'writer-gpu' ? 'webgpu' : null].filter(Boolean)) {
      const t0 = Date.now();
      let parts = 0;
      const out = await ai.call({ type: 'generate', messages: [{ role: 'system', content: 'You are a writing assistant inside a text editor. Reply with only the requested text.' }, { role: 'user', content: 'Fix the grammar:\n<<<\nme and him goes to the store yesterday and buyed three apple.\n>>>' }], opts: { device: dev, maxTokens: 60 } }, null, () => parts++);
      await log(`ok   generate (${dev}) ${Math.round((Date.now() - t0) / 1000)}s, ${parts} partial updates: ${JSON.stringify(out).slice(0, 300)}`);
    }
  } catch (e) { await log('FAIL writer: ' + (e && e.message || e)); }
  await log('DONE');
  api('win:control', 'quit');
})()
