/* البرنس لايف — مبدّل الوضع المظلم/النهاري (المظلم افتراضي) */
(function () {
  var KEY = 'pl_theme';
  var root = document.documentElement;
  var isLight = function () { return root.getAttribute('data-theme') === 'light'; };

  function render() {
    var light = isLight();
    var label = light ? 'الوضع المظلم' : 'الوضع النهاري';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', light ? 'true' : 'false');
      btn.setAttribute('aria-label', label);
      btn.title = label;
      var sun = btn.querySelector('.ico-sun');
      var moon = btn.querySelector('.ico-moon');
      if (sun) sun.style.display = light ? 'none' : 'block';
      if (moon) moon.style.display = light ? 'block' : 'none';
      var txt = btn.querySelector('.theme-label');
      if (txt) txt.textContent = label;
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#EEF3F7' : '#0E141B');
  }

  function toggle() {
    var next = isLight() ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    root.setAttribute('data-theme', next);
    render();
  }

  window.plToggleTheme = toggle;
  render();
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', toggle);
  });
})();
