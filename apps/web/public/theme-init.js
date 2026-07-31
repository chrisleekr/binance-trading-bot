// Apply persisted theme before paint to avoid FOUC. Served from same origin so
// the strict CSP (script-src 'self') allows it — an inline <script> would be
// blocked in production. Referenced synchronously in <head>, so it runs before
// the body paints.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (_) {}
})();
