/* ym_auto_page / script.js - 카테고리 탭: 엔진 로드 + 이 기기용 설정 화면 */
(function () {
  'use strict';
  var PLUGIN_ID = 'ym_auto_page';
  var root = (typeof container !== 'undefined' && container) || document.querySelector('.ym-ap-tab');
  if (!root) { return; }
  var $ = function (role) { return root.querySelector('[data-role="' + role + '"]'); };

  function loadEngine() {
    if (window.YMAutoPage) { return Promise.resolve(window.YMAutoPage); }
    if (window.__ymAutoPageLoading) { return window.__ymAutoPageLoading; }
    window.__ymAutoPageLoading = fetch('/api/media/context-menu/book/plugins/action', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'general', plugin_id: PLUGIN_ID, action_id: 'get_engine', context: {} })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.success || !data.code) { throw new Error((data && data.error) || '엔진을 받지 못했습니다.'); }
      new Function('cfg', data.code)(data.config || {});
      if (!window.YMAutoPage) { throw new Error('엔진 초기화에 실패했습니다.'); }
      return window.YMAutoPage;
    }).finally(function () { window.__ymAutoPageLoading = null; });
    return window.__ymAutoPageLoading;
  }

  var stateEl = $('state');
  var savedTimer = null;

  function showSaved() {
    var el = $('saved');
    el.textContent = '저장했습니다.';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { el.textContent = ''; }, 1600);
  }

  function fill(ap) {
    var p = ap.getPrefs();
    var cfg = ap.getConfig();
    root.querySelectorAll('.ym-ap-hotkey').forEach(function (k) { k.textContent = cfg.hotkey || 'Alt+A'; });
    $('seconds').value = p.seconds;
    $('range').value = Math.min(120, p.seconds);
    root.querySelectorAll('[data-sec]').forEach(function (b) {
      b.classList.toggle('is-active', Number(b.dataset.sec) === p.seconds);
    });
    root.querySelectorAll('input[name="ym-ap-method"]').forEach(function (r) { r.checked = r.value === p.method; });
    $('key').value = p.key;
    $('key-wrap').hidden = p.method === 'button';
    $('page-panel').hidden = p.method === 'scroll';
    $('scroll-panel').hidden = p.method === 'key' || p.method === 'button';
    $('speed').value = p.scrollSpeed;
    $('speed-range').value = Math.min(300, p.scrollSpeed);
    root.querySelectorAll('[data-speed]').forEach(function (b) {
      b.classList.toggle('is-active', Number(b.dataset.speed) === p.scrollSpeed);
    });
    $('resetOnInput').checked = !!p.resetOnInput;
    $('stopAtEnd').checked = !!p.stopAtEnd;

    var btnRadio = root.querySelector('input[name="ym-ap-method"][value="button"]');
    btnRadio.disabled = !cfg.nextButtonSelector;
    btnRadio.parentElement.style.opacity = cfg.nextButtonSelector ? '' : '.5';

    var st = ap.getStatus();
    stateEl.classList.remove('is-error');
    stateEl.textContent = st.running
      ? (st.mode === 'scroll'
        ? '지금 자동 스크롤이 켜져 있습니다 (' + p.scrollSpeed + 'px/초).'
        : '지금 자동 넘김이 켜져 있습니다 (' + p.seconds + '초 간격).')
      : '준비됐습니다. 뷰어를 열고 ' + (cfg.hotkey || 'Alt+A') + ' 를 누르세요.';
  }

  function bind(ap) {
    function save(patch) { ap.setPrefs(patch); fill(ap); showSaved(); }

    $('range').addEventListener('input', function () { $('seconds').value = this.value; });
    $('range').addEventListener('change', function () { save({ seconds: Number(this.value) }); });
    $('seconds').addEventListener('change', function () { save({ seconds: Number(this.value) }); });
    root.querySelectorAll('[data-sec]').forEach(function (b) {
      b.addEventListener('click', function () { save({ seconds: Number(b.dataset.sec) }); });
    });
    root.querySelectorAll('input[name="ym-ap-method"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { save({ method: r.value }); } });
    });
    $('speed-range').addEventListener('input', function () { $('speed').value = this.value; });
    $('speed-range').addEventListener('change', function () { save({ scrollSpeed: Number(this.value) }); });
    $('speed').addEventListener('change', function () { save({ scrollSpeed: Number(this.value) }); });
    root.querySelectorAll('[data-speed]').forEach(function (b) {
      b.addEventListener('click', function () { save({ scrollSpeed: Number(b.dataset.speed) }); });
    });
    $('key').addEventListener('change', function () { save({ key: this.value }); });
    $('resetOnInput').addEventListener('change', function () { save({ resetOnInput: this.checked }); });
    $('stopAtEnd').addEventListener('change', function () { save({ stopAtEnd: this.checked }); });
    $('reset').addEventListener('click', function () { ap.resetPrefs(); fill(ap); showSaved(); });
    ap.onChange(function () { if (root.isConnected) { fill(ap); } });
  }

  loadEngine().then(function (ap) {
    fill(ap);
    bind(ap);
  }).catch(function (err) {
    stateEl.classList.add('is-error');
    stateEl.textContent = '자동 넘김 엔진을 불러오지 못했습니다: ' + err.message;
  });
})();
