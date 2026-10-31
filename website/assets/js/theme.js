// Light/dark choice. Runs in <head> before the page draws, so the saved theme never flashes the other one.
// The choice is kept in localStorage, with a cookie as a second copy for browsers that clear or block storage.
// It's applied again whenever it could have been lost: a page restored by Back/Forward (the browser keeps the old
// one), a change made in another tab, or anything else rewriting the attribute.
(function () {
  var KEY = 'dogfile-theme';
  var root = document.documentElement;
  function saved() {
    var t = null;
    try { t = localStorage.getItem(KEY); } catch (e) {}
    if (t !== 'light' && t !== 'dark') {
      var m = document.cookie.match(/(?:^|;\s*)dogfile-theme=(light|dark)/);
      t = m ? m[1] : null;
    }
    return t;
  }
  function apply() {
    var t = saved();
    if (t && root.getAttribute('data-theme') !== t) root.setAttribute('data-theme', t);
  }
  window.dogfileTheme = {
    isDark: function () {
      var t = root.getAttribute('data-theme');
      if (t) return t === 'dark';
      return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    },
    set: function (t) {
      try { localStorage.setItem(KEY, t); } catch (e) {}
      document.cookie = KEY + '=' + t + '; path=/; max-age=31536000; SameSite=Lax';
      root.setAttribute('data-theme', t);
    },
  };
  apply();
  window.addEventListener('pageshow', apply);
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
  if (window.MutationObserver) new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
