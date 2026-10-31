// Thank-you page: Stripe sends buyers here as thanks.html?session_id=cs_…  We ask the license server for the serial
// number (GET /claim). It's created the moment Stripe reports the payment, so it can take a few seconds.
(function () {
  'use strict';
  var C = window.DOGFILE || {};
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var show = function (name) { $$('[data-state]').forEach(function (s) { s.hidden = s.getAttribute('data-state') !== name; }); };
  var q = new URLSearchParams(location.search);
  var sid = q.get('session_id') || q.get('session') || '';
  var serial = '', saved = false, started = 0, timer = 0;

  function error(title, text) {
    $('[data-error-title]').textContent = title;
    $('[data-error-text]').textContent = text;
    show('error');
  }
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) {
    error('We Couldn’t Find a Purchase in This Link', 'This page opens after paying at checkout. If you’ve paid, contact us with the email address you paid with and we’ll send your serial number.');
    return;
  }

  function next() {
    var waited = Date.now() - started;
    if (waited > 90000) { show('slow'); return; }
    if (waited > 12000) $('[data-loading-text]').textContent = 'Still confirming. Some banks take a little longer, so please keep this page open.';
    timer = setTimeout(poll, waited < 10000 ? 1500 : 3000);
  }
  function poll() {
    clearTimeout(timer);
    fetch(C.licenseApi + '/claim?session=' + encodeURIComponent(sid), { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (res) {
        var j = res.j || {};
        if (res.ok && typeof j.serial === 'string' && j.serial) return success(j);
        if (res.ok && j.pending === false) return error('This Purchase Was Refunded or Canceled', 'This serial number no longer works. If you think that’s a mistake, contact us and we’ll sort it out.');
        if (res.status === 400 || res.status === 404) return error('We Couldn’t Find This Purchase', 'The link may be incomplete. If you’ve paid, contact us with the email address you paid with and we’ll send your serial number.');
        next(); // pending, or the server was busy: ask again shortly
      })
      .catch(next); // offline for a moment: keep trying
  }

  function success(j) {
    serial = j.serial;
    $('[data-serial]').textContent = serial;
    if (j.email) { $('[data-email]').textContent = j.email; $('[data-email-line]').hidden = false; }
    show('ok');
    document.title = 'Your serial number | Dogfile';
  }

  function markSaved(how) {
    saved = true;
    var w = $('[data-save-warn]');
    w.classList.add('done');
    w.querySelector('span').innerHTML = '<b>' + how + '</b> Keep it somewhere safe, like a password manager or your notes. You’ll need it again on a new PC.';
  }
  window.addEventListener('beforeunload', function (e) {
    if (serial && !saved) { e.preventDefault(); e.returnValue = ''; }
  });

  $('[data-copy]').addEventListener('click', function () {
    var btn = this, label = btn.querySelector('span');
    var done = function () { label.textContent = 'Copied'; markSaved('Copied to your clipboard.'); setTimeout(function () { label.textContent = 'Copy serial number'; }, 2500); };
    var fallback = function () {
      var r = document.createRange(); r.selectNodeContents($('[data-serial]'));
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      if (ok) done(); else label.textContent = 'Selected: press Ctrl+C';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(serial).then(done, fallback);
    else fallback();
  });

  $('[data-save]').addEventListener('click', function () {
    var text = 'Dogfile Pro serial number\r\n\r\n' + serial + '\r\n\r\n' +
      'Activate: open Dogfile, choose Settings > License > Enter serial number, and paste it in.\r\n' +
      'It works on 2 PCs. To move it, choose Settings > License > Deactivate this PC on the old one.\r\n\r\n' +
      'Bought ' + new Date().toLocaleDateString() + '. Keep this file somewhere safe.\r\n';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'Dogfile Pro serial number.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    markSaved('Saved as “Dogfile Pro serial number.txt”.');
  });

  $('[data-retry]').addEventListener('click', function () {
    started = Date.now();
    $('[data-loading-text]').textContent = 'Checking again…';
    show('loading');
    poll();
  });

  started = Date.now();
  poll();
})();
