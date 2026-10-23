// Dogfile on the phone: send photos, videos, files and text to the PC, and get what the PC sends back.
// Plain script (no modules) so older phones run it too.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var known = {};      // outbox ids already shown
  var first = true;
  var sharedAt = null; // { root, path }
  var online = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function size(n) {
    if (n == null) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
  }
  var toastT;
  function toast(t) { var x = $('toast'); x.textContent = t; x.className = 'show'; clearTimeout(toastT); toastT = setTimeout(function () { x.className = ''; }, 2600); }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: { 'x-dog': '1' }, body: body, credentials: 'same-origin', cache: 'no-store' });
  }
  function setDot(on) {
    if (online === on) return;
    online = on;
    $('dot').className = 'dot ' + (on ? 'on' : 'off');
    $('dot').title = on ? 'Connected' : 'Can’t reach your PC';
  }
  var IMG = /\.(jpe?g|png|gif|webp|heic|avif|bmp)$/i;
  var EXT = function (n) { var m = /\.([a-z0-9]{1,5})$/i.exec(n || ''); return m ? m[1].toUpperCase() : 'FILE'; };

  // ---------- what the PC sent ----------
  function renderFrom(list) {
    var box = $('from');
    box.innerHTML = '';
    list = list.slice().sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
    if (!list.length) { box.appendChild(el('div', { class: 'empty', text: 'Nothing yet. In Dogfile, right-click files and choose “Send to phone”.' })); }
    var fresh = 0;
    list.forEach(function (it) {
      var isNew = !first && !known[it.id];
      if (!known[it.id]) { known[it.id] = 1; if (!first) fresh++; }
      var dismiss = el('button', { class: 'x', title: 'Remove from the list', onclick: function () { api('POST', '/api/dismiss?id=' + encodeURIComponent(it.id)).then(refresh); } }, ['×']);
      if (it.kind === 'text') {
        var ta = el('textarea', { readonly: 'readonly', rows: '1', style: 'position:absolute;left:-9999px' });
        ta.value = it.text || '';
        var copy = el('button', { class: 'small', onclick: function () { copyText(it.text || '', ta); } }, ['Copy']);
        var link = /^https?:\/\/\S+$/i.test((it.text || '').trim()) ? el('a', { class: 'btn', href: it.text.trim(), target: '_blank', rel: 'noopener' }, ['Open']) : null;
        box.appendChild(el('div', { class: 'item' + (isNew ? ' new' : '') }, [el('div', { class: 'ic', text: 'TXT' }), el('div', { class: 'meta' }, [el('div', { class: 'txt', text: it.text || '' })]), link, copy, ta, dismiss]));
        return;
      }
      var url = '/api/file/' + encodeURIComponent(it.id);
      var ic = el('div', { class: 'ic', text: EXT(it.name) });
      if (IMG.test(it.name) && it.size < 25 * 1048576) { ic.textContent = ''; ic.appendChild(el('img', { src: url, alt: '', loading: 'lazy' })); }
      box.appendChild(el('div', { class: 'item' + (isNew ? ' new' : '') }, [
        el('a', { href: url, target: '_blank', rel: 'noopener', style: 'display:contents' }, [ic, el('div', { class: 'meta' }, [el('div', { class: 'name', text: it.name }), el('div', { class: 'sub', text: size(it.size) })])]),
        el('a', { class: 'btn', href: url + '?dl=1', download: it.name }, ['Save']), dismiss,
      ]));
    });
    if (fresh) { toast(fresh === 1 ? 'Your PC sent something' : 'Your PC sent ' + fresh + ' things'); if (navigator.vibrate) navigator.vibrate(60); }
    first = false;
  }
  function copyText(t, ta) {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).then(function () { toast('Copied'); }); return; }
    ta.style.position = 'fixed'; ta.select(); ta.setSelectionRange(0, t.length);
    try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Select the text and copy it'); }
    ta.style.position = 'absolute';
  }

  // ---------- shared folders ----------
  function renderShared(list) {
    $('shared-wrap').hidden = !list.length;
    if (!list.length) return;
    if (!sharedAt || !list.some(function (s) { return s.i === sharedAt.root; })) {
      var box = $('shared'); box.innerHTML = ''; $('crumbs').innerHTML = '';
      list.forEach(function (s) { box.appendChild(el('div', { class: 'item', onclick: function () { openShared(s.i, '', s.name); } }, [el('div', { class: 'ic', text: '📁' }), el('div', { class: 'meta' }, [el('div', { class: 'name', text: s.name })])])); });
    }
  }
  function openShared(root, path, rootName) {
    sharedAt = { root: root, path: path, name: rootName || (sharedAt && sharedAt.name) };
    fetch('/api/browse?root=' + root + '&p=' + encodeURIComponent(path), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(function (d) {
      var crumbs = $('crumbs'); crumbs.innerHTML = '';
      crumbs.appendChild(el('button', { onclick: function () { sharedAt = null; refresh(true); } }, ['All']));
      var parts = path ? path.split('/') : [];
      crumbs.appendChild(document.createTextNode('›'));
      crumbs.appendChild(el('button', { onclick: function () { openShared(root, ''); } }, [sharedAt.name]));
      parts.forEach(function (p, i) { crumbs.appendChild(document.createTextNode('›')); crumbs.appendChild(el('button', { onclick: function () { openShared(root, parts.slice(0, i + 1).join('/')); } }, [p])); });
      var box = $('shared'); box.innerHTML = '';
      if (!d.items.length) box.appendChild(el('div', { class: 'empty', text: 'This folder is empty' }));
      d.items.forEach(function (it) {
        var sub = path ? path + '/' + it.name : it.name;
        if (it.dir) { box.appendChild(el('div', { class: 'item', onclick: function () { openShared(root, sub); } }, [el('div', { class: 'ic', text: '📁' }), el('div', { class: 'meta' }, [el('div', { class: 'name', text: it.name })])])); return; }
        var url = '/api/shared?root=' + root + '&p=' + encodeURIComponent(sub);
        box.appendChild(el('div', { class: 'item' }, [
          el('a', { href: url, target: '_blank', rel: 'noopener', style: 'display:contents' }, [el('div', { class: 'ic', text: EXT(it.name) }), el('div', { class: 'meta' }, [el('div', { class: 'name', text: it.name }), el('div', { class: 'sub', text: size(it.size) })])]),
          el('a', { class: 'btn', href: url + '&dl=1', download: it.name }, ['Save']),
        ]));
      });
    }).catch(function () { toast('Couldn’t open that folder'); });
  }

  // ---------- sending ----------
  var queue = [], active = 0, batch = String(Date.now());
  function addFiles(files) {
    batch = String(Date.now());
    for (var i = 0; i < files.length; i++) queue.push(files[i]);
    pump();
  }
  function pump() {
    while (active < 2 && queue.length) send(queue.shift());
  }
  function send(f) {
    active++;
    var row = el('div', { class: 'up' }, [el('div', { class: 'r' }, [el('span', { class: 'n', text: f.name }), el('span', { class: 's', text: size(f.size) })]), el('div', { class: 'bar' }, [el('i')])]);
    $('ups').insertBefore(row, $('ups').firstChild);
    var bar = row.querySelector('i'), st = row.querySelector('.s');
    var x = new XMLHttpRequest();
    x.open('PUT', '/api/upload?name=' + encodeURIComponent(f.name || 'file') + '&modified=' + (f.lastModified || 0) + '&batch=' + batch);
    x.setRequestHeader('x-dog', '1');
    var t0 = Date.now();
    x.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      bar.style.width = (100 * e.loaded / e.total) + '%';
      var secs = (Date.now() - t0) / 1000;
      st.textContent = Math.round(100 * e.loaded / e.total) + '%' + (secs > 1 ? ' · ' + size(e.loaded / secs) + '/s' : '');
    };
    x.onload = function () {
      active--;
      if (x.status === 200) { row.className = 'up done'; bar.style.width = '100%'; st.textContent = 'Sent'; setTimeout(function () { row.remove(); }, 6000); }
      else { row.className = 'up fail'; st.textContent = x.status === 401 ? 'Not connected' : 'Failed'; addRetry(row, f); }
      pump();
    };
    x.onerror = function () { active--; row.className = 'up fail'; st.textContent = 'Failed'; addRetry(row, f); setDot(false); pump(); };
    x.send(f);
  }
  function addRetry(row, f) {
    row.querySelector('.r').appendChild(el('button', { class: 'small', onclick: function () { row.remove(); queue.push(f); pump(); } }, ['Retry']));
  }

  // ---------- staying in touch ----------
  var busy = false;
  function refresh(force) {
    if (busy && !force) return;
    busy = true;
    fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      busy = false;
      if (r.status === 401) { showPairing(); return null; }
      if (!r.ok) throw new Error();
      return r.json();
    }).then(function (d) {
      if (!d) return;
      setDot(true);
      $('pairing').hidden = true; $('app').hidden = false;
      $('pc').textContent = d.pc;
      $('inbox-name').textContent = 'to “' + d.inbox + '” on ' + d.pc;
      renderFrom(d.outbox || []);
      renderShared(d.shared || []);
    }).catch(function () { busy = false; setDot(false); });
  }
  function showPairing() {
    setDot(false);
    $('app').hidden = true; $('pairing').hidden = false;
    if (/expired=1/.test(location.search)) $('pair-msg').innerHTML = 'That code was already used or has expired. In Dogfile, open <b>Phone transfer</b> and scan the new code.';
  }
  var standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  var ios = /iPhone|iPad/.test(navigator.userAgent);
  $('tip').textContent = standalone ? '' : ios ? 'Tip: tap Share, then Add to Home Screen, to connect with one tap next time.' : 'Tip: add this page to your home screen to connect with one tap next time.';

  $('pick').addEventListener('change', function (e) { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; });
  $('text-btn').addEventListener('click', function () { $('text-in').value = ''; $('text-dlg').showModal(); setTimeout(function () { $('text-in').focus(); }, 50); });
  $('text-dlg').addEventListener('close', function () {
    if ($('text-dlg').returnValue !== 'send') return;
    var t = $('text-in').value;
    if (!t.trim()) return;
    api('POST', '/api/text', t).then(function (r) { toast(r.ok ? 'Sent to your PC' : 'Couldn’t send'); });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(true); });
  setInterval(function () { if (!document.hidden) refresh(); }, 3000);
  refresh(true);
})();
