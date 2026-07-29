/* Pin the shell to the visible viewport, including browser keyboard panning. */
(function () {
  'use strict';
  function sync() {
    var vv = window.visualViewport;
    var h = Math.round((vv && vv.height) || window.innerHeight || 0);
    var w = Math.round((vv && vv.width) || window.innerWidth || 0);
    var top = Math.round((vv && vv.offsetTop) || 0);
    var left = Math.round((vv && vv.offsetLeft) || 0);
    var style = document.documentElement.style;
    if (h > 0) style.setProperty('--app-height', h + 'px');
    if (w > 0) style.setProperty('--app-width', w + 'px');
    style.setProperty('--app-top', top + 'px');
    style.setProperty('--app-left', left + 'px');
  }
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sync);
    window.visualViewport.addEventListener('scroll', sync);
  }
})();
