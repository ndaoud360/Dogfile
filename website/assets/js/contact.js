// Contact form: sent to Dogfile's own server (the license server's /contact), which saves every message and forwards
// it to the inbox. data-email is the address shown when sending fails, for writing directly.
(function () {
  'use strict';
  var form = document.getElementById('contact-form');
  if (!form) return;
  var to = (form.getAttribute('data-email') || '').trim();
  var configured = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) && to !== 'you@example.com';
  var status = document.getElementById('form-status');
  var send = document.getElementById('send');
  var label = send.querySelector('.btn-label');
  var sending = false;
  var el = function (k) { return form.elements.namedItem(k); };
  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

  function setStatus(html, kind) { status.innerHTML = html; status.className = 'form-status' + (kind ? ' ' + kind : ''); }
  function fieldError(id, msg) {
    var f = document.getElementById('f-' + id);
    f.classList.toggle('invalid', !!msg);
    f.querySelector('.err').textContent = msg || '';
    f.querySelector('input, textarea').setAttribute('aria-invalid', msg ? 'true' : 'false');
    return !msg;
  }
  function check() {
    var n = el('name').value.trim(), e = el('email').value.trim(), m = el('message').value.trim();
    var ok = fieldError('name', n ? '' : 'Please enter your name.');
    ok = fieldError('email', !e ? 'Please enter your email so we can reply.' : EMAIL.test(e) ? '' : 'That email address doesn’t look right.') && ok;
    ok = fieldError('message', m.length >= 5 ? '' : 'Please write a message.') && ok;
    return ok;
  }
  ['name', 'email', 'message'].forEach(function (k) {
    el(k).addEventListener('input', function () { if (document.getElementById('f-' + k).classList.contains('invalid')) check(); });
  });
  var esc = function (s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (sending) return;
    if (!check()) { var bad = form.querySelector('[aria-invalid="true"]'); if (bad) bad.focus(); return; }
    if (!configured) { setStatus('The contact form isn’t set up yet. Please try again later.', 'bad'); return; }
    if (el('_honey').value) { setStatus('Thanks, your message is on its way.', 'ok'); form.reset(); return; } // a bot filled the hidden field
    sending = true;
    send.setAttribute('aria-busy', 'true'); label.textContent = 'Sending';
    setStatus('', '');
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    var name = el('name').value.trim(), email = el('email').value.trim();
    fetch('https://armnbgeluofwseufpqge.supabase.co/functions/v1/license/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, message: el('message').value.trim(), _honey: el('_honey').value }),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok === true) {
          form.reset();
          setStatus('Thanks, ' + esc(name) + '. Your message is on its way, and we’ll reply to ' + esc(email) + '.', 'ok');
        } else throw new Error((j && j.error) || 'not sent');
      })
      .catch(function (e) {
        // the server's own explanation when it gives one (a field it didn't accept, too many messages)
        if (e && e.message && e.message !== 'not sent' && !/fetch|network|abort/i.test(e.message)) { setStatus(esc(e.message), 'bad'); return; }
        setStatus('Your message couldn’t be sent just now. Please try again in a minute, or email us at <a href="mailto:' + esc(to) + '">' + esc(to) + '</a>.', 'bad');
      })
      .then(function () {
        clearTimeout(timer);
        sending = false;
        send.removeAttribute('aria-busy'); label.textContent = 'Send message';
      });
  });
})();
