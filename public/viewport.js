/* Sets --app-height to the visible viewport height before layout paints. */
(function () {
  'use strict';
  function sync() {
    var vv = window.visualViewport;
    var h = Math.round((vv && vv.height) || window.innerHeight || 0);
    if (h > 0) document.documentElement.style.setProperty('--app-height', h + 'px');
  }
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sync);
    window.visualViewport.addEventListener('scroll', sync);
  }
})();
