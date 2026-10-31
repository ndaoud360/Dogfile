// Checks Dogfile's Windows-only parts inside the real app on a Windows machine (run by CI, results in a log).
(async () => {
  const api = (n, ...a) => window.atlas.invoke(n, ...a);
  const log = (s) => api('test:log', s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = async (name, fn, ms = 20000) => { const t0 = performance.now(); try { const r = await Promise.race([fn(), wait(ms).then(() => 'TIMEOUT')]); await log(`${r === false || r === 'TIMEOUT' ? 'FAIL' : 'ok  '} ${name} ${Math.round(performance.now() - t0)}ms ${r === true || r === false ? '' : String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 300)}`); } catch (e) { await log(`ERR  ${name}: ${e && e.message || e}`); } };
  const ev = (ch, pred, ms = 15000) => new Promise((res) => { const off = window.atlas.on(ch, (d) => { if (pred(d)) { off(); res(d); } }); setTimeout(() => { off(); res(null); }, ms); });
  const job = async (spec) => { const fin = ev('ops:finished', () => true, 30000); const id = await api('ops:start', spec); let d = await fin; return d && d.id === id ? d.status + (d.errors?.length ? ' ' + d.errors[0] : '') : 'no event ' + JSON.stringify(d); };
  const info = await api('sys:info');
  const D = info.known.temp + '\\dogtest';
  await log('platform ' + info.platform + ' temp ' + info.known.temp + ' 7z ' + info.has7z + ' ffmpeg ' + info.ffmpeg);
  await T('drives', async () => (await api('fs:drives')).map((d) => `${d.path} ${d.type} ${d.label || ''} ${Math.round((d.free || 0) / 1e9)}GB free`).join(' | '));
  await T('list C:\\Windows (attributes)', async () => { const t0 = performance.now(); const r = await api('fs:list', 'C:\\Windows'); return `${r.items.length} items, hidden ${r.items.filter((i) => i.hidden).length}, system ${r.items.filter((i) => i.system).length}, ${Math.round(performance.now() - t0)} ms`; });
  await T('list System32 (big folder)', async () => { const t0 = performance.now(); const r = await api('fs:list', 'C:\\Windows\\System32'); return `${r.items.length} items in ${Math.round(performance.now() - t0)} ms`; });
  await T('mkdir + files', async () => { await api('fs:mkdir', D).catch(() => 0); await api('fs:writeText', D + '\\a.txt', 'hello'); await api('fs:writeText', D + '\\b.txt', 'world'); await api('fs:mkdir', D + '\\out').catch(() => 0); return (await api('fs:list', D)).items.map((i) => i.name).join(','); });
  await T('rename case only', async () => { await api('fs:rename', D + '\\b.txt', D + '\\B.txt'); return (await api('fs:list', D)).items.map((i) => i.name).join(','); });
  await T('hash', async () => (await api('fs:hash', D + '\\a.txt', ['sha256'])).sha256 === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  await T('copy job', async () => job({ type: 'copy', sources: [D + '\\a.txt', D + '\\B.txt'], dest: D + '\\out' }));
  await T('copy again (keep both)', async () => { const r = await job({ type: 'copy', sources: [D + '\\a.txt'], dest: D + '\\out', opts: { conflict: 'keepBoth' } }); return r + ' ' + (await api('fs:list', D + '\\out')).items.map((i) => i.name).join(','); });
  await T('move job', async () => job({ type: 'move', sources: [D + '\\out\\B.txt'], dest: D, opts: { conflict: 'keepBoth' } }).then(async (r) => r + ' ' + (await api('fs:exists', D + '\\B (2).txt') || await api('fs:exists', D + '\\B.txt'))));
  await T('recycle + list + restore', async () => { await api('fs:writeText', D + '\\trashme.txt', 'x'); const r = await job({ type: 'trash', sources: [D + '\\trashme.txt'] }); const l = await api('recycle:list'); const it = l.find((x) => /trashme/.test(x.name)); if (!it) return r + ' not in recycle bin (' + l.length + ')'; await api('recycle:restore', [it.path]); await wait(800); return r + ' restored=' + (await api('fs:exists', D + '\\trashme.txt')); });
  await T('attributes hidden', async () => { await api('fs:setAttributes', [D + '\\a.txt'], { hidden: true }); const a = await api('fs:attributes', D + '\\a.txt'); await api('fs:setAttributes', [D + '\\a.txt'], { hidden: false }); return JSON.stringify(a); });
  await T('shortcut', async () => { await api('fs:shortcut', D + '\\a.lnk', D + '\\a.txt'); return api('fs:readLink', D + '\\a.lnk'); });
  await T('clipboard files', async () => { await api('clip:writeFiles', [D + '\\a.txt'], false); return JSON.stringify(await api('clip:readFiles')); });
  await T('clipboard text', async () => { await api('clip:writeText', 'dogfile ✓'); return (await api('clip:readText')) === 'dogfile ✓'; });
  await T('icon for .txt and notepad.exe', async () => { const a = await api('icon:get', D + '\\a.txt', 'normal'); const b = await api('icon:get', 'C:\\Windows\\notepad.exe', 'large'); return `${String(a).slice(0, 30)} | ${String(b).slice(0, 30)}`; });
  await T('thumbnail (shell)', async () => { const png = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR42u3PMQ0AAAgDsM2/aFCBDZKGBdq0Ixe2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeHoBtIEBtwm8gGcAAAAASUVORK5CYII='; await api('fs:writeDataUrl', D + '\\pic.png', png); const u = await api('thumb:get', D + '\\pic.png', 128); if (!u) return 'no thumbnail'; const r = await fetch(u); return u.slice(0, 40) + ' -> ' + r.status + ' ' + r.headers.get('content-type') + ' ' + (await r.arrayBuffer()).byteLength; });
  await T('shell verbs', async () => (await api('shell:verbs', D + '\\a.txt')).slice(0, 8).join(', '));
  await T('zip (7za) + list + extract', async () => { const r = await job({ type: 'compress', sources: [D + '\\a.txt', D + '\\pic.png'], dest: D, opts: { output: D + '\\made.zip', format: 'zip' } }); const l = await api('archive:list', D + '\\made.zip'); const x = await job({ type: 'extract', sources: [D + '\\made.zip'], dest: D + '\\ex' }); return r + ' ' + JSON.stringify((l.items || l).map((e) => e.path || e.name)) + ' extract ' + x + ' ' + (await api('fs:list', D + '\\ex')).items.map((i) => i.name).join(','); });
  // ---- people's files: each of these must hold, or the build doesn't go out (see the "safety gate" step) ----
  const U = async (name, fn) => { let r; try { r = await fn(); } catch (e) { r = 'threw ' + (e && e.message || e); } await log(`${r === true ? 'safe  ' : 'UNSAFE'} ${name}${r === true ? '' : ': ' + JSON.stringify(r).slice(0, 300)}`); };
  const S = D + '\\safety';
  await api('fs:mkdir', S).catch(() => 0);
  const rd = async (p) => (await api('fs:readText', p, 1000).catch(() => ({ text: '<missing>' }))).text;
  await U('rename never replaces an existing file', async () => {
    await api('fs:writeText', S + '\\a.txt', 'A'); await api('fs:writeText', S + '\\b.txt', 'B');
    let threw = false; try { await api('fs:rename', S + '\\a.txt', S + '\\b.txt'); } catch { threw = true; }
    return threw && (await rd(S + '\\b.txt')) === 'B' && (await rd(S + '\\a.txt')) === 'A' || { threw, b: await rd(S + '\\b.txt') };
  });
  await U('saving over a file keeps its creation date and leaves no work file', async () => {
    await api('fs:writeText', S + '\\keep.txt', 'v1');
    const c1 = (await api('fs:stat', S + '\\keep.txt')).ctime; await wait(1500);
    await api('fs:writeText', S + '\\keep.txt', 'v2');
    const c2 = (await api('fs:stat', S + '\\keep.txt')).ctime;
    const left = (await api('fs:list', S, { hidden: true })).items.filter((i) => i.name.startsWith('~$')).map((i) => i.name);
    return (Math.abs(c2 - c1) < 1000 && (await rd(S + '\\keep.txt')) === 'v2' && !left.length) || { c1, c2, left };
  });
  await U('moving a folder onto one with the same files, answering skip, keeps the skipped originals', async () => {
    for (const d of ['\\src', '\\src\\m', '\\dst', '\\dst\\m']) await api('fs:mkdir', S + d).catch(() => 0); // one level at a time
    await api('fs:writeText', S + '\\src\\m\\one.txt', 'new one'); await api('fs:writeText', S + '\\src\\m\\two.txt', 'new two'); await api('fs:writeText', S + '\\dst\\m\\one.txt', 'old one');
    const r = await job({ type: 'move', sources: [S + '\\src\\m'], dest: S + '\\dst', opts: { conflict: 'skip' } });
    const got = { r, srcOne: await rd(S + '\\src\\m\\one.txt'), dstOne: await rd(S + '\\dst\\m\\one.txt'), dstTwo: await rd(S + '\\dst\\m\\two.txt'), srcTwo: await rd(S + '\\src\\m\\two.txt') };
    return (got.srcOne === 'new one' && got.dstOne === 'old one' && got.dstTwo === 'new two' && got.srcTwo === '<missing>') || got;
  });
  await U('copy with replace swaps the whole file in and leaves no work file', async () => {
    await api('fs:mkdir', S + '\\r1').catch(() => 0); await api('fs:mkdir', S + '\\r2').catch(() => 0);
    await api('fs:writeText', S + '\\r1\\x.txt', 'fresh'); await api('fs:writeText', S + '\\r2\\x.txt', 'stale');
    const r = await job({ type: 'copy', sources: [S + '\\r1\\x.txt'], dest: S + '\\r2', opts: { conflict: 'replace' } });
    const left = (await api('fs:list', S + '\\r2', { hidden: true })).items.filter((i) => i.name.startsWith('~$')).map((i) => i.name);
    return ((await rd(S + '\\r2\\x.txt')) === 'fresh' && !left.length) || { r, x: await rd(S + '\\r2\\x.txt'), left };
  });
  await U('extracting never overwrites a file that is already there', async () => {
    await api('fs:mkdir', S + '\\ex').catch(() => 0);
    await api('fs:writeText', S + '\\ex\\a.txt', 'mine');
    const r = await job({ type: 'extract', sources: [D + '\\made.zip'], dest: S + '\\ex', opts: { smart: false } });
    const names = (await api('fs:list', S + '\\ex')).items.map((i) => i.name);
    return ((await rd(S + '\\ex\\a.txt')) === 'mine' && names.length >= 2) || { r, a: await rd(S + '\\ex\\a.txt'), names };
  });
  await U('a folder name with & in it is never run as a command (terminal and commands)', async () => {
    const weird = S + '\\t&mkdir injected1';
    await api('fs:mkdir', weird).catch(() => 0);
    await api('shell:terminal', weird, 'cmd').catch(() => 0);
    const weird2 = S + '\\r&mkdir injected2';
    await api('fs:mkdir', weird2).catch(() => 0);
    await api('shell:runCommand', `cd "${weird2}"`, S).catch(() => 0);
    await wait(3000);
    const all = [...(await api('fs:list', S)).items.map((i) => i.name), ...(await api('fs:list', weird)).items.map((i) => i.name), ...(await api('fs:list', weird2)).items.map((i) => i.name)];
    return !all.some((n) => /^injected/.test(n)) || all;
  });
  await T('folder size job', async () => { const done = new Promise((res) => { const off = window.atlas.on('work:msg', (m) => { if (m.type === 'done') { off(); res(m); } }); }); await api('work:start', { type: 'size', root: 'C:\\Windows\\Fonts' }); const m = await done; return `${m.files} files ${Math.round(m.total / 1e6)} MB`; });
  await T('search job (walk)', async () => { const items = []; const done = new Promise((res) => { const off = window.atlas.on('work:msg', (m) => { if (m.type === 'results') items.push(...m.items); if (m.type === 'done' || m.type === 'error') { off(); res(m); } }); }); await api('work:start', { type: 'search', roots: [D], query: 'pic', kind: 'file', recursive: true }); await done; return items.map((i) => i.name).join(','); });
  await T('index status', async () => JSON.stringify(await api('index:status')).slice(0, 300));
  await T('pty (powershell)', async () => { let buf = ''; const off = window.atlas.on('pty:data', (m) => { buf += m.d || ''; }); const r = await api('pty:spawn', { shell: 'powershell', cwd: D, cols: 100, rows: 30 }); await wait(2500); await api('pty:write', r.id ?? r, 'echo ("PT" + "Y_" + (40+2))\r'); await wait(2500); off(); await api('pty:kill', r.id ?? r); return /PTY_42/.test(buf) || JSON.stringify(buf.slice(-200)); });
  await T('watch folder', async () => { const got = ev('watch:changed', () => true, 5000); await api('watch:set', 'pane0', D); await wait(300); await api('fs:writeText', D + '\\new.txt', 'x'); return JSON.stringify(await got); });
  await T('versions', async () => { await api('versions:save', D + '\\a.txt', 'test'); return (await api('versions:list', D + '\\a.txt')).length; });
  await T('secret (DPAPI)', async () => { await api('secret:set', 'unittest', 'pw'); return api('secret:has', 'unittest'); });
  await T('default file manager?', async () => api('default:get'));
  await T('who locks', async () => JSON.stringify(await api('locks:who', [D + '\\a.txt'])));
  await T('git status', async () => JSON.stringify(await api('git:status', 'D:\\a\\Dogfile\\Dogfile')).slice(0, 120));
  await T('everything status', async () => JSON.stringify(await api('everything:status')));
  await T('find editor', async () => JSON.stringify(await api('sys:findEditor')));
  await T('cloud detect', async () => JSON.stringify(await api('cloud:detect')).slice(0, 200));
  await T('mapped drives', async () => JSON.stringify(await api('fs:mapped')));
  await T('recent (Windows)', async () => (await api('fs:recentWindows')).length);
  await T('doc text (txt)', async () => api('doc:text', D + '\\a.txt', 100));
  // the photo editor's save: a picture shown from a file, drawn on a canvas, read back and written (a big one too)
  await T('photo edit save (canvas to file)', async () => {
    const img = new Image(); img.src = '/f/?p=' + encodeURIComponent(D + '\\pic.png');
    await img.decode();
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 3000, 2000);
    const px = g.createImageData(3000, 400); for (let i = 0; i < px.data.length; i++) px.data[i] = (i * 2654435761) >>> 24; g.putImageData(px, 0, 0);
    const data = c.toDataURL('image/jpeg', 0.92);
    const out = D + '\\pic (edited).jpg';
    let one = 'ok';
    try { await api('fs:writeDataUrl', out, data); } catch (e) { one = 'ERR ' + e.message; }
    const st1 = await api('fs:stat', out).catch(() => null);
    const b64 = data.slice(data.indexOf(',') + 1), CH = 4 << 20;
    for (let i = 0; i < b64.length; i += CH) await api('fs:writePart', out, b64.slice(i, i + CH), i > 0);
    await api('fs:finishPart', out);
    const st = await api('fs:stat', out);
    return `sent ${Math.round(data.length / 1024)} KB; one request: ${one} ${Math.round((st1?.size || 0) / 1024)} KB; in pieces: ${Math.round((st?.size || 0) / 1024)} KB`;
  });
  await T('window maximized?', async () => api('win:control', 'isMaximized'));
  await T('long paths (over 260 characters)', async () => {
    let L = D + '\\long'; await api('fs:mkdir', L).catch(() => 0);
    for (let i = 0; i < 12; i++) { L += '\\' + 'folder_with_a_long_name_' + i; await api('fs:mkdir', L).catch(() => 0); }
    await api('fs:writeText', L + '\\deep file.txt', 'deep');
    const list = (await api('fs:list', L)).items.map((i) => i.name).join(',');
    const cp = await job({ type: 'copy', sources: [L + '\\deep file.txt'], dest: D });
    await api('fs:rename', L + '\\deep file.txt', L + '\\renamed.txt');
    const st = await api('fs:stat', L + '\\renamed.txt');
    const del = await job({ type: 'delete', sources: [D + '\\long'] });
    return `len ${L.length} list=${list} copy=${cp} renamed=${!!st} delete=${del} gone=${!(await api('fs:exists', D + '\\long'))}`;
  });
  await T('keywords into a file (System.Keywords)', async () => { const png = D + '\\pic.png'; const jpg = D + '\\kw.jpg'; const data = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='; await api('fs:writeDataUrl', jpg, data); const w = await api('keywords:write', jpg, ['Red', 'Holiday']); const r = await api('keywords:read', jpg); const w2 = await api('keywords:write', png, ['Blue']); return JSON.stringify({ w, r, png: w2 }); });
  await T('dialog jump (another program\'s Open dialog goes to a folder)', async () => {
    const ps = `Add-Type -AssemblyName System.Windows.Forms\r\n$d = New-Object System.Windows.Forms.OpenFileDialog\r\n$d.InitialDirectory = 'C:\\Windows'\r\n$r = $d.ShowDialog()\r\nSet-Content -Path '${D}\\dlg-result.txt' -Value (\"$r \" + $d.FileName)\r\n`;
    await api('fs:writeText', D + '\\dlg.ps1', ps);
    await api('shell:runCommand', `powershell -NoProfile -STA -ExecutionPolicy Bypass -File "${D}\\dlg.ps1"`);
    const r = await api('dialogjump:test', D, 'a.txt').catch((e) => 'ERR ' + e.message);
    for (let i = 0; i < 20 && !(await api('fs:exists', D + '\\dlg-result.txt')); i++) await wait(500);
    const res = (await api('fs:readText', D + '\\dlg-result.txt', 1000).catch(() => ({ text: 'no result' }))).text.trim();
    return `${r} → ${res}`;
  }, 40000);
  await T('sidebar fold: busy time and what covers the panes afterwards', async () => {
    const P = await import(new URL('js/pane.js', location.href).href);
    await P.navigate(P.activeTab(), 'C:\\Windows\\Web\\Wallpaper\\Windows').catch(() => {});
    await wait(1500);
    const probe = async (label) => {
      const gaps = [], covers = new Set(); let last = performance.now(), stop = false; const t0 = last;
      const lt = []; let po = null; try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => lt.push(Math.round(e.startTime - t0) + '+' + Math.round(e.duration)))); po.observe({ type: 'longtask' }); } catch {}
      const loop = () => { const n = performance.now(); if (n - last > 40) gaps.push(Math.round(last - t0) + '+' + Math.round(n - last)); last = n; if (n - t0 > 700) { const m = document.getElementById('main').getBoundingClientRect(); const el = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2); if (el && !el.closest('#main')) covers.add(Math.round(n - t0) + ':' + (el.id || el.className || el.tagName)); } if (!stop) setTimeout(loop, 0); };
      document.getElementById('burger').click(); loop();
      await wait(2500); stop = true; po?.disconnect();
      return `${label}: gaps ${gaps.join(',') || 'none'}; long tasks ${lt.join(',') || 'none'}; covered ${[...covers].slice(0, 4).join(',') || 'never'}`;
    };
    const a = await probe('close'), b = await probe('open');
    const e0 = performance.now(); window.__atlas.bus.emit('settings'); const e1 = performance.now();
    return `${a} | ${b} | settings event ${Math.round(e1 - e0)} ms`;
  }, 15000);
  // pressing the menu button again and again, in a big folder: frame gaps, long tasks, and how long until it's calm
  await T('sidebar fold: rapid presses in a big folder', async () => {
    const P = await import(new URL('js/pane.js', location.href).href);
    const t = P.activeTab(); t.view = 'grid';
    await P.navigate(t, 'C:\\Windows\\System32').catch(() => {});
    await wait(2500);
    const gaps = [], lt = []; let last = performance.now(), stop = false; const t0 = last;
    let po = null; try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => lt.push(Math.round(e.startTime - t0) + '+' + Math.round(e.duration)))); po.observe({ type: 'longtask' }); } catch {}
    const loop = () => { const n = performance.now(); if (n - last > 50) gaps.push(Math.round(last - t0) + '+' + Math.round(n - last)); last = n; if (!stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const b = document.getElementById('burger');
    const lat = [];
    for (let i = 0; i < 8; i++) { const c0 = performance.now(); b.click(); lat.push(Math.round(performance.now() - c0)); await wait(i % 2 ? 180 : 420); }
    await wait(3000); stop = true; po?.disconnect();
    return `click handler ms ${lat.join(',')}; gaps ${gaps.slice(0, 12).join(',') || 'none'}; long tasks ${lt.slice(0, 12).join(',') || 'none'}; collapsed=${document.body.classList.contains('no-sidebar')}`;
  }, 20000);
  // how late the window's main thread runs while the sidebar folds (Windows holds back clicks during this):
  // with WebView2's own drag areas (-webkit-app-region, the old way), with Dogfile's own (now), and with no animation
  await T('sidebar fold: main thread lateness', async () => {
    const P = await import(new URL('js/pane.js', location.href).href);
    const t = P.activeTab(); t.view = 'grid';
    await P.navigate(t, 'C:\\Windows\\Web\\Wallpaper\\Windows').catch(() => {});
    await wait(2000);
    const fold = (await import(new URL('js/fold.js', location.href).href));
    const run = async (label, setup, undo) => {
      setup();
      await wait(800);
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) { fold.toggle(); await wait(1300); }
      await wait(1500);
      const lag = ((await api('diag:lag')).ui || []).filter((u) => u.t >= t0);
      undo();
      const tot = lag.reduce((a, u) => a + u.ms, 0), max = lag.reduce((a, u) => Math.max(a, u.ms), 0);
      return `${label}: late ${lag.length}x, worst ${max} ms, total ${tot} ms`;
    };
    const st = document.createElement('style');
    st.textContent = '#tabbar,.side-drag,.tab-drag{-webkit-app-region:drag}.tab,#tab-add,#win-ctl,#burger,.pro-pill,#demo-sign{-webkit-app-region:no-drag}';
    const a = await run('native drag areas', () => document.head.append(st), () => st.remove());
    const b = await run('own drag areas', () => {}, () => {});
    const s = window.__atlas.state.settings; const prev = s.panelAnims;
    const c = await run('no animation', () => { s.panelAnims = { ...(prev || {}), sidebar: 'none' }; }, () => { s.panelAnims = prev; });
    return `${a} | ${b} | ${c}`;
  }, 90000);
  await T('window buttons drawn', async () => document.querySelectorAll('#win-ctl .wc-btn').length === 3 || document.querySelectorAll('#win-ctl .wc-btn').length);
  await log('DONE');
})()
