/* Ontario M1 Trainer v6.3 — мобильное меню и поведение прокрутки (только ширина ≤ 719 px).
 * Не меняет данные, состояние приложения и логику экзамена. Работает поверх app.js и exam64.js. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.matchMedia) return;
  var mq = window.matchMedia('(max-width: 719px), (max-height: 500px)');
  var btn = document.getElementById('menuBtn'), panel = document.getElementById('menuPanel'),
      back = document.getElementById('menuBackdrop'), closeBtn = document.getElementById('menuClose');
  if (!btn || !panel || !back || !closeBtn) return;

  function setOpen(open, returnFocus) {
    panel.hidden = !open;
    back.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('menu-open', open);
    if (open) closeBtn.focus();
    else if (returnFocus) btn.focus();
  }
  btn.addEventListener('click', function () { setOpen(panel.hidden, false); });
  closeBtn.addEventListener('click', function () { setOpen(false, true); });
  back.addEventListener('click', function () { setOpen(false, false); });
  panel.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('nav button[data-mode]')) setOpen(false, true);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false, true);
  });
  function onWidthChange() { if (!mq.matches && !panel.hidden) setOpen(false, false); }
  if (mq.addEventListener) mq.addEventListener('change', onWidthChange); else if (mq.addListener) mq.addListener(onWidthChange);

  // Прокрутка: ответ и отметки не сбрасывают позицию; переход к другому вопросу или разделу — к началу содержимого
  var savedY = 0;
  var KEEP_SCROLL = '[data-act="pick"],[data-act="squiz-pick"],[data-act="bm"],[data-act="mark"],[data-act="sbm"],[data-act="ldone"],[data-act="fs"],[data-act="dark"],[data-e64="pick"]';
  document.addEventListener('click', function () { savedY = window.pageYOffset; }, true);
  document.addEventListener('click', function (e) {
    if (!mq.matches || !e.target || !e.target.closest) return;
    if (e.target.closest(KEEP_SCROLL)) { window.scrollTo(0, savedY); return; }
    if (e.target.closest('[data-act],[data-e64],nav button[data-mode]')) {
      var stage = document.getElementById('stage'), hdr = document.querySelector('header');
      if (stage && hdr) window.scrollTo(0, Math.max(0, stage.getBoundingClientRect().top + window.pageYOffset - hdr.offsetHeight - 6));
    }
  });
})();
