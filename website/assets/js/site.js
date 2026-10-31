// Dogfile website: theme button, menu, Buy buttons, the feature showcase, the side index. No libraries.
(function () {
  'use strict';
  var C = window.DOGFILE || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- theme (theme.js keeps the choice; this is just the button) ----------
  var T = window.dogfileTheme;
  $$('[data-theme-toggle]').forEach(function (b) {
    var label = function () { var l = T.isDark() ? 'Switch to light mode' : 'Switch to dark mode'; b.setAttribute('aria-label', l); b.title = l; };
    label();
    b.addEventListener('click', function () { T.set(T.isDark() ? 'light' : 'dark'); label(); });
    window.addEventListener('pageshow', label);
  });

  // ---------- header ----------
  var head = $('.site-head');
  var menuBtn = $('[data-menu]');
  var mnav = $('#mobile-nav');
  if (menuBtn && mnav) {
    menuBtn.addEventListener('click', function () {
      var open = mnav.hidden;
      mnav.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    $$('a', mnav).forEach(function (a) { a.addEventListener('click', function () { mnav.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }); });
  }

  $$('[data-year]').forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

  // ---------- buying ----------
  // Buy buttons are plain links to the license server's /buy, which sends the browser on to Stripe. This only shows
  // that something is happening while Stripe's page loads.
  function resetBuy() { $$('[data-buy]').forEach(function (b) { b.removeAttribute('aria-busy'); }); }
  // the link says which site it's on, so after paying Stripe comes back to this site's thank-you page
  var siteBase = /^https?:$/.test(location.protocol) ? new URL('.', location.href).href : '';
  $$('[data-buy]').forEach(function (btn) {
    if (siteBase) { try { var u = new URL(btn.href); u.searchParams.set('site', siteBase); btn.href = u.toString(); } catch (err) { /* keep the plain link */ } }
    btn.addEventListener('click', function (e) {
      if (btn.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; } // a second click while it loads
      btn.setAttribute('aria-busy', 'true');
      // Stripe opens in a new tab: this one is back to normal shortly
      setTimeout(resetBuy, 2500);
    });
  });
  window.addEventListener('focus', function () { setTimeout(resetBuy, 400); });

  // ---------- Download Free: first to the Free vs Pro page, at its Download Free buttons ----------
  function goGet(force) {
    if (location.hash !== '#get' && !force) return;
    var t = $('#get');
    if (!t || !t.offsetParent) t = $('#get-m'); // small screens show cards instead of the table
    if (!t) return;
    setTimeout(function () {
      t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      var b = t.querySelector('[data-download]');
      if (b) { b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); setTimeout(function () { b.classList.remove('pulse'); }, 2600); }
    }, 80);
  }
  goGet();
  window.addEventListener('hashchange', function () { goGet(); });
  // already on Free vs Pro: scroll there instead of reloading
  if ($('#get')) $$('a[href="download.html#get"]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); history.replaceState(null, '', '#get'); goGet(true); var m = $('#mobile-nav'); if (m && !m.hidden) { var mb = $('[data-menu]'); if (mb) mb.click(); } });
  });
  // back from Stripe: the browser may restore this page exactly as it was, spinner included
  window.addEventListener('pageshow', function (e) { if (e.persisted) resetBuy(); });

  // ---------- coming back from checkout without buying ----------
  var back = /[?&](cancelled|failed)=1\b/.exec(location.search);
  if (back) { var n = $('#' + back[1]); if (n) n.hidden = false; }

  // ---------- hero window: tilted at the top, flat once you scroll ----------
  var win = $('.hero-window');
  if (win && !reduce) {
    var ticking = false;
    var setTilt = function () {
      ticking = false;
      var p = Math.min(1, Math.max(0, window.scrollY / 520));
      win.style.setProperty('--tilt', (14 * (1 - p)).toFixed(2) + 'deg');
      if (head) head.classList.toggle('scrolled', window.scrollY > 8);
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(setTilt); } }, { passive: true });
    setTilt();
  } else if (head) {
    window.addEventListener('scroll', function () { head.classList.toggle('scrolled', window.scrollY > 8); }, { passive: true });
  }

  // ---------- showcase: the screenshot follows the step in the middle of the screen ----------
  var steps = $$('.step[data-shot]');
  var stageImgs = $$('.stage img[data-shot]');
  if (steps.length && stageImgs.length && 'IntersectionObserver' in window) {
    var show = function (step) {
      var k = step.getAttribute('data-shot');
      steps.forEach(function (s) { s.classList.toggle('on', s === step); });
      stageImgs.forEach(function (im) { im.classList.toggle('on', im.getAttribute('data-shot') === k); });
    };
    show(steps[0]);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) show(en.target); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(function (s) { io.observe(s); });
  } else steps.forEach(function (s) { s.classList.add('on'); });

  // ---------- side index: highlight the section on screen ----------
  var idxLinks = $$('.side-index a');
  if (idxLinks.length && 'IntersectionObserver' in window) {
    var idxObs = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (!en.isIntersecting) return;
        idxLinks.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    idxLinks.forEach(function (a) { var sct = document.querySelector(a.getAttribute('href')); if (sct) idxObs.observe(sct); });
  }

  // ---------- looping videos: play while on screen; still with controls when motion is reduced ----------
  $$('video[data-loop]').forEach(function (v) {
    var btn = v.parentElement.parentElement.querySelector('[data-video-toggle]');
    var label = function () { if (btn) btn.textContent = v.paused ? 'Play the video' : 'Pause the video'; };
    if (reduce) { v.removeAttribute('autoplay'); v.pause(); }
    else if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (v.dataset.user === 'paused') return;
          if (en.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause();
        });
      }, { threshold: 0.25 }).observe(v);
    }
    v.addEventListener('play', label); v.addEventListener('pause', label); label();
    if (btn) btn.addEventListener('click', function () {
      if (v.paused) { v.dataset.user = ''; var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      else { v.dataset.user = 'paused'; v.pause(); }
    });
  });
})();
