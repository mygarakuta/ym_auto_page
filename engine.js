/*
 * ym_auto_page / engine.js
 *
 * new Function('cfg', engineCode)(cfg) 형태로 한 번만 실행되어 window.YMAutoPage를 만든다.
 * cfg = 관리자 설정 (ym_auto_page.py의 _client_config 참고)
 * 사용자별 값(간격/방식/키 등)은 이 기기의 localStorage에 따로 저장되어 cfg를 덮어쓴다.
 */
(function () {
  'use strict';

  var VERSION = '1.2.1';
  if (window.YMAutoPage && window.YMAutoPage.version) { return; }

  cfg = cfg || {};
  var LS_KEY = 'ym_auto_page_prefs';
  var USER_KEYS = ['seconds', 'method', 'key', 'resetOnInput', 'stopAtEnd'];
  var KEY_INFO = {
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Space: { key: ' ', code: 'Space', keyCode: 32 }
  };

  // ------------------------------------------------------------------ 설정
  function loadUserPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function clampSeconds(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) { n = 10; }
    return Math.max(1, Math.min(600, n));
  }

  function buildPrefs() {
    var user = loadUserPrefs();
    var p = {
      seconds: clampSeconds(cfg.seconds || 10),
      method: cfg.method || 'key',
      key: cfg.key || 'ArrowRight',
      resetOnInput: cfg.resetOnInput !== false,
      stopAtEnd: cfg.stopAtEnd !== false
    };
    USER_KEYS.forEach(function (k) { if (user[k] !== undefined && user[k] !== null) { p[k] = user[k]; } });
    p.seconds = clampSeconds(p.seconds);
    if (['key', 'button', 'scroll'].indexOf(p.method) === -1) { p.method = 'key'; }
    if (!KEY_INFO[p.key]) { p.key = 'ArrowRight'; }
    return p;
  }

  var prefs = buildPrefs();

  // ------------------------------------------------------------------ 상태
  var state = {
    running: false,
    remaining: 0,
    lastTs: 0,
    tickTimer: null,
    viewerEl: null,
    viewerMisses: 0,
    sawViewerWhileRunning: false,
    progress: null,      // { bookId, pageIdx, total, at }
    atEnd: false,
    endTurnMark: null,
    turns: 0
  };
  var listeners = [];

  // 조작 버튼 최소화 상태 (이 기기에만 저장)
  var UI_KEY = 'ym_auto_page_ui';
  function loadUiState() {
    try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  var minimized = !!loadUiState().minimized;
  function saveMinimized(v) {
    minimized = !!v;
    var u = loadUiState();
    u.minimized = minimized;
    try { localStorage.setItem(UI_KEY, JSON.stringify(u)); } catch (e) { /* ignore */ }
  }

  function emit() {
    var snap = api.getStatus();
    listeners.slice().forEach(function (fn) { try { fn(snap); } catch (e) { /* ignore */ } });
  }

  // ------------------------------------------------------------------ 유틸
  function isVisible(el) {
    if (!el || !el.isConnected) { return false; }
    if (el.getClientRects().length === 0) { return false; }
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  }

  function queryVisible(selector) {
    if (!selector) { return null; }
    var list;
    try { list = document.querySelectorAll(selector); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) { if (isVisible(list[i])) { return list[i]; } }
    return null;
  }

  function isOwnUi(el) {
    return !!(el && el.closest && el.closest('#ym-ap-root, #ym-ap-bar, #ym-ap-toast'));
  }

  // 뷰어 찾기: 관리자가 선택자를 지정했으면 그것만, 아니면 "화면 대부분을 덮는 고정 레이어" 휴리스틱
  function findViewer() {
    if (cfg.viewerSelector) { return queryVisible(cfg.viewerSelector); }
    if (document.fullscreenElement) { return document.fullscreenElement; }
    var w = window.innerWidth, h = window.innerHeight;
    var el = document.elementFromPoint(w / 2, h / 2);
    while (el && el !== document.body && el !== document.documentElement) {
      if (isOwnUi(el)) { return null; }
      var cs = getComputedStyle(el);
      if (cs.position === 'fixed') {
        var r = el.getBoundingClientRect();
        if (r.width >= w * 0.85 && r.height >= h * 0.85 &&
            (el.querySelector('img, canvas, iframe, video') || (el.textContent || '').length > 300)) {
          return el;
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function findScrollable(root) {
    var best = null, bestArea = 0;
    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.scrollHeight <= el.clientHeight + 10) { continue; }
      var oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && el !== document.scrollingElement) { continue; }
      var area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  // ------------------------------------------------------------------ 페이지 넘기기
  // 반환: 'ok' | 'end' | 'fail'
  function turnPage() {
    var viewer = state.viewerEl || findViewer();

    if (prefs.method === 'button') {
      var btn = queryVisible(cfg.nextButtonSelector);
      if (!btn) { return 'fail'; }
      btn.click();
      return 'ok';
    }

    if (prefs.method === 'scroll') {
      var sc = viewer ? findScrollable(viewer) : null;
      if (!sc && document.scrollingElement && document.scrollingElement.scrollHeight > window.innerHeight + 10) {
        sc = document.scrollingElement;
      }
      if (!sc) { return 'fail'; }
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) { return 'end'; }
      var step = Math.max(80, Math.round(sc.clientHeight * 0.9));
      try { sc.scrollBy({ top: step, behavior: 'smooth' }); } catch (e) { sc.scrollTop += step; }
      return 'ok';
    }

    // 키보드 방식: 뷰어 안에서 발생한 것처럼 이벤트를 보낸다 (document/window까지 버블링됨)
    var info = KEY_INFO[prefs.key] || KEY_INFO.ArrowRight;
    var active = document.activeElement;
    var target = (viewer && active && viewer.contains(active)) ? active : (viewer || document.body);
    ['keydown', 'keyup'].forEach(function (type) {
      var ev = new KeyboardEvent(type, {
        key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode,
        bubbles: true, cancelable: true, composed: true
      });
      target.dispatchEvent(ev);
    });
    return 'ok';
  }

  // ------------------------------------------------------------------ 타이머
  function tick() {
    var now = performance.now();
    var dt = now - state.lastTs;
    state.lastTs = now;
    if (!state.running) { return; }
    if (document.hidden) { render(); return; }  // 다른 탭을 보는 동안은 멈춤

    state.remaining -= dt;
    if (state.remaining > 0) { render(); return; }

    // 마지막 페이지 판정: 마지막 페이지에서 한 번 넘겼는데도 진행률 기록이 새로 오지 않으면 정지
    if (prefs.stopAtEnd && state.atEnd && state.progress) {
      if (state.endTurnMark !== null && state.endTurnMark === state.progress.at) {
        stop('end');
        return;
      }
      state.endTurnMark = state.progress.at;
    } else {
      state.endTurnMark = null;
    }

    var result = turnPage();
    if (result === 'end' && prefs.stopAtEnd) { stop('end'); return; }
    if (result === 'fail') { stop('fail'); return; }
    state.turns += 1;
    state.remaining = prefs.seconds * 1000;
    render();
  }

  function start() {
    if (state.running) { return; }
    if (prefs.method === 'button' && !cfg.nextButtonSelector) {
      toast("'다음' 버튼 선택자가 없습니다. 관리자 설정에서 지정하거나 다른 넘김 방식을 고르세요.");
      return;
    }
    state.running = true;
    state.remaining = prefs.seconds * 1000;
    state.lastTs = performance.now();
    state.turns = 0;
    state.endTurnMark = null;
    state.viewerMisses = 0;
    state.sawViewerWhileRunning = !!state.viewerEl;
    state.tickTimer = setInterval(tick, 100);
    toast(prefs.seconds + '초마다 다음 페이지로 넘깁니다.');
    render();
    emit();
  }

  function stop(reason) {
    if (!state.running) { return; }
    state.running = false;
    clearInterval(state.tickTimer);
    state.tickTimer = null;
    var msg = {
      end: '마지막 페이지라 자동 넘김을 멈췄습니다.',
      fail: "넘길 대상을 찾지 못해 멈췄습니다. 설정에서 넘김 방식을 확인하세요.",
      closed: '뷰어가 닫혀서 자동 넘김을 멈췄습니다.'
    }[reason] || '자동 넘김을 멈췄습니다.';
    toast(msg);
    render();
    emit();
  }

  function resetCountdown() {
    if (state.running) { state.remaining = prefs.seconds * 1000; render(); }
  }

  // ------------------------------------------------------------------ 진행률 감지 (읽기 전용)
  // 뷰어가 /api/media/progress 로 보내는 page_idx/total_pages를 엿봐서 마지막 페이지를 안다.
  // 요청 자체는 건드리지 않고 그대로 통과시킨다.
  function sniff(url, method, body) {
    url = String(url || '');
    if (url.indexOf('/api/media/progress') === -1 || url.indexOf('progress-state') !== -1) { return; }
    if (String(method || 'GET').toUpperCase() !== 'POST' || typeof body !== 'string') { return; }
    var d;
    try { d = JSON.parse(body); } catch (e) { return; }
    var idx = Number(d.page_idx), total = Number(d.total_pages);
    if (!isFinite(idx)) { return; }
    var prevBook = state.progress && state.progress.bookId;
    state.progress = { bookId: d.book_id, pageIdx: idx, total: total, at: Date.now() };
    state.atEnd = isFinite(total) && total > 1 && idx >= total - 1;
    if (prevBook !== undefined && prevBook !== d.book_id) { state.endTurnMark = null; }
  }

  function installSniffers() {
    if (!cfg.stopAtEnd) { return; }
    var origFetch = window.fetch;
    if (origFetch && !origFetch.__ymAutoPage) {
      var wrapped = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url);
          var method = (init && init.method) || (input && input.method) || 'GET';
          sniff(url, method, init && init.body);
        } catch (e) { /* ignore */ }
        return origFetch.apply(this, arguments);
      };
      wrapped.__ymAutoPage = true;
      window.fetch = wrapped;
    }
    if (navigator.sendBeacon && !navigator.sendBeacon.__ymAutoPage) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      var beacon = function (url, data) {
        try { sniff(url, 'POST', data); } catch (e) { /* ignore */ }
        return origBeacon(url, data);
      };
      beacon.__ymAutoPage = true;
      try { navigator.sendBeacon = beacon; } catch (e) { /* 읽기 전용인 브라우저 */ }
    }
    var XHR = window.XMLHttpRequest;
    if (XHR && !XHR.prototype.__ymAutoPage) {
      var origOpen = XHR.prototype.open, origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__ymApMethod = method; this.__ymApUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try { sniff(this.__ymApUrl, this.__ymApMethod, body); } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      };
      XHR.prototype.__ymAutoPage = true;
    }
  }

  // ------------------------------------------------------------------ 화면 (조작 버튼 / 진행 막대 / 알림)
  var ui = {};

  function injectStyle() {
    if (document.getElementById('ym-ap-style')) { return; }
    var css = [
      '#ym-ap-root{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:2px;padding:4px;',
      'border-radius:999px;background:var(--app-bg-card,#1f2430);color:var(--app-text-primary,#eef0f4);',
      'border:1px solid var(--app-border,rgba(255,255,255,.15));box-shadow:0 6px 20px rgba(0,0,0,.35);',
      'font:600 13px/1 var(--app-font,system-ui,sans-serif);opacity:.4;transition:opacity .2s;user-select:none}',
      '#ym-ap-root:hover,#ym-ap-root:focus-within,#ym-ap-root.is-running{opacity:1}',
      '#ym-ap-root[hidden]{display:none}',
      '#ym-ap-root.pos-bottom-left{left:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px))}',
      '#ym-ap-root.pos-bottom-right{right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px))}',
      '#ym-ap-root.pos-top-left{left:16px;top:calc(16px + env(safe-area-inset-top,0px))}',
      '#ym-ap-root.pos-top-right{right:16px;top:calc(16px + env(safe-area-inset-top,0px))}',
      '#ym-ap-root button{all:unset;cursor:pointer;width:32px;height:32px;display:grid;place-items:center;border-radius:50%}',
      '#ym-ap-root .ym-ap-min{width:24px;height:24px;font-size:11px;opacity:.7}',
      '#ym-ap-root .ym-ap-dot{display:none}',
      '#ym-ap-root.is-min{padding:0;gap:0;opacity:.3;box-shadow:0 2px 8px rgba(0,0,0,.3)}',
      '#ym-ap-root.is-min>*{display:none}',
      '#ym-ap-root.is-min>.ym-ap-dot{display:grid;width:22px;height:22px;font:700 10px/1 var(--app-font,system-ui,sans-serif);font-variant-numeric:tabular-nums}',
      '#ym-ap-root.is-min.is-running{opacity:.85}',
      '#ym-ap-root.is-min.is-running>.ym-ap-dot{background:var(--app-accent,#8b7cf6);color:#fff}',
      '#ym-ap-root button:hover{background:var(--app-bg-card-hover,rgba(255,255,255,.08))}',
      '#ym-ap-root button:focus-visible{outline:2px solid var(--app-accent,#8b7cf6);outline-offset:1px}',
      '#ym-ap-root .ym-ap-play{background:var(--app-accent,#8b7cf6);color:#fff}',
      '#ym-ap-root .ym-ap-play:hover{background:var(--app-accent-hover,#7a6af0)}',
      '#ym-ap-root .ym-ap-sec{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}',
      '#ym-ap-bar{position:fixed;left:0;right:0;bottom:0;height:3px;z-index:2147483000;pointer-events:none}',
      '#ym-ap-bar[hidden]{display:none}',
      '#ym-ap-bar>div{height:100%;width:0;background:var(--app-accent,#8b7cf6);opacity:.85}',
      '#ym-ap-toast{position:fixed;left:50%;top:calc(20px + env(safe-area-inset-top,0px));transform:translateX(-50%);',
      'z-index:2147483001;max-width:min(90vw,420px);padding:10px 16px;border-radius:10px;',
      'background:var(--app-bg-card,#1f2430);color:var(--app-text-primary,#eef0f4);',
      'border:1px solid var(--app-border,rgba(255,255,255,.15));box-shadow:0 6px 20px rgba(0,0,0,.35);',
      'font:500 13px/1.4 var(--app-font,system-ui,sans-serif);pointer-events:none;opacity:0;transition:opacity .2s}',
      '#ym-ap-toast.show{opacity:1}',
      '@media (prefers-reduced-motion:reduce){#ym-ap-root,#ym-ap-toast{transition:none}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'ym-ap-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function makeButton(cls, label, iconCls, fallback) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    var i = document.createElement('i');
    i.className = iconCls;
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    // 아이콘 폰트가 없을 때 대비
    b.dataset.fallback = fallback;
    return b;
  }

  function buildUi() {
    injectStyle();

    var root = document.createElement('div');
    root.id = 'ym-ap-root';
    root.className = 'pos-' + (cfg.floatPosition || 'bottom-left');
    root.hidden = true;

    ui.play = makeButton('ym-ap-play', '자동 넘김 시작 (' + (cfg.hotkey || 'Alt+A') + ')', 'fa-solid fa-play', '▶');
    ui.minus = makeButton('ym-ap-minus', '간격 줄이기', 'fa-solid fa-minus', '−');
    ui.sec = document.createElement('span');
    ui.sec.className = 'ym-ap-sec';
    ui.sec.setAttribute('aria-live', 'polite');
    ui.plus = makeButton('ym-ap-plus', '간격 늘리기', 'fa-solid fa-plus', '+');
    ui.min = makeButton('ym-ap-min', '작게 접기', 'fa-solid fa-chevron-down', '–');
    ui.dot = document.createElement('button');
    ui.dot.type = 'button';
    ui.dot.className = 'ym-ap-dot';
    ui.dot.setAttribute('aria-label', '자동 넘김 조작 버튼 펼치기');
    ui.dot.title = '펼치기';

    root.appendChild(ui.play);
    root.appendChild(ui.minus);
    root.appendChild(ui.sec);
    root.appendChild(ui.plus);
    root.appendChild(ui.min);
    root.appendChild(ui.dot);

    var bar = document.createElement('div');
    bar.id = 'ym-ap-bar';
    bar.hidden = true;
    ui.barFill = document.createElement('div');
    bar.appendChild(ui.barFill);

    var t = document.createElement('div');
    t.id = 'ym-ap-toast';
    t.setAttribute('role', 'status');

    document.body.appendChild(root);
    document.body.appendChild(bar);
    document.body.appendChild(t);
    ui.root = root; ui.bar = bar; ui.toast = t;

    ui.play.addEventListener('click', function () { api.toggle(); ui.play.blur(); });
    ui.minus.addEventListener('click', function () { api.setPrefs({ seconds: stepSeconds(prefs.seconds, -1) }); ui.minus.blur(); });
    ui.plus.addEventListener('click', function () { api.setPrefs({ seconds: stepSeconds(prefs.seconds, +1) }); ui.plus.blur(); });
    ui.min.addEventListener('click', function () { api.setMinimized(true); ui.min.blur(); });
    ui.dot.addEventListener('click', function () { api.setMinimized(false); ui.dot.blur(); });

    // 아이콘 폰트(Font Awesome)가 없으면 글자로 대체
    setTimeout(function () {
      [ui.play, ui.minus, ui.plus, ui.min].forEach(function (b) {
        var i = b.querySelector('i');
        if (i && i.getBoundingClientRect().width === 0) { i.remove(); b.textContent = b.dataset.fallback; }
      });
    }, 1500);
  }

  function stepSeconds(cur, dir) {
    var step = cur < 10 ? 1 : (cur < 60 ? 5 : 15);
    if (dir < 0 && cur <= 10 && cur > 1) { step = 1; }
    return clampSeconds(cur + dir * step);
  }

  function setPlayIcon(running) {
    var i = ui.play.querySelector('i');
    var label = (running ? '자동 넘김 정지' : '자동 넘김 시작') + ' (' + (cfg.hotkey || 'Alt+A') + ')';
    ui.play.title = label;
    ui.play.setAttribute('aria-label', label);
    if (i) { i.className = running ? 'fa-solid fa-pause' : 'fa-solid fa-play'; }
    else { ui.play.textContent = running ? '❚❚' : '▶'; }
  }

  function render() {
    if (!ui.root) { return; }
    var showFloat = cfg.showFloating !== false && (!!state.viewerEl || state.running);
    ui.root.hidden = !showFloat;
    ui.root.classList.toggle('is-running', state.running);
    ui.root.classList.toggle('is-min', minimized);
    // 최소화 상태: 멈춰 있으면 ⏱, 돌고 있으면 남은 초만 표시
    ui.dot.textContent = state.running ? String(Math.max(0, Math.ceil(state.remaining / 1000))) : '⏱';
    ui.dot.title = state.running ? '자동 넘김 중 - 눌러서 펼치기' : '자동 넘김 - 눌러서 펼치기';
    setPlayIcon(state.running);
    if (state.running) {
      var left = Math.max(0, Math.ceil(state.remaining / 1000));
      ui.sec.textContent = left + ' / ' + prefs.seconds + '초';
      ui.bar.hidden = false;
      var ratio = 1 - Math.max(0, state.remaining) / (prefs.seconds * 1000);
      ui.barFill.style.width = (Math.min(1, ratio) * 100).toFixed(1) + '%';
    } else {
      ui.sec.textContent = prefs.seconds + '초';
      ui.bar.hidden = true;
    }
  }

  var toastTimer = null;
  function toast(msg) {
    if (!ui.toast) { return; }
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove('show'); }, 2200);
  }

  // ------------------------------------------------------------------ 입력 처리
  function parseHotkey(str) {
    var parts = String(str || 'Alt+A').split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    var hk = { alt: false, ctrl: false, shift: false, meta: false, key: '' };
    parts.forEach(function (p) {
      var l = p.toLowerCase();
      if (l === 'alt' || l === 'option') { hk.alt = true; }
      else if (l === 'ctrl' || l === 'control') { hk.ctrl = true; }
      else if (l === 'shift') { hk.shift = true; }
      else if (l === 'meta' || l === 'cmd' || l === 'win') { hk.meta = true; }
      else { hk.key = p; }
    });
    return hk;
  }
  var hotkey = parseHotkey(cfg.hotkey);

  function matchesHotkey(e) {
    if (!hotkey.key) { return false; }
    if (e.altKey !== hotkey.alt || e.ctrlKey !== hotkey.ctrl || e.shiftKey !== hotkey.shift || e.metaKey !== hotkey.meta) { return false; }
    var k = hotkey.key;
    if (/^[a-z]$/i.test(k)) { return e.code === 'Key' + k.toUpperCase(); }  // 맥 Option 조합 문자 대응
    if (/^[0-9]$/.test(k)) { return e.code === 'Digit' + k; }
    return e.key.toLowerCase() === k.toLowerCase() || e.code.toLowerCase() === k.toLowerCase();
  }

  function isTypingTarget(el) {
    if (!el) { return false; }
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  window.addEventListener('keydown', function (e) {
    if (!e.isTrusted) { return; }  // 우리가 보낸 가짜 키 이벤트는 무시
    if (matchesHotkey(e) && !isTypingTarget(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      api.toggle();
      return;
    }
    if (state.running && e.key === 'Escape') { stop(); return; }
    if (prefs.resetOnInput) { resetCountdown(); }
  }, true);

  ['pointerdown', 'wheel', 'touchstart'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!e.isTrusted || isOwnUi(e.target)) { return; }
      if (prefs.resetOnInput) { resetCountdown(); }
    }, { capture: true, passive: true });
  });

  // 뷰어 열림/닫힘 감시
  setInterval(function () {
    var v = findViewer();
    state.viewerEl = v;
    if (state.running) {
      if (v) { state.sawViewerWhileRunning = true; state.viewerMisses = 0; }
      else if (state.sawViewerWhileRunning) {
        state.viewerMisses += 1;
        if (state.viewerMisses >= 2) { stop('closed'); }
      }
    }
    render();
  }, 700);

  // ------------------------------------------------------------------ 공개 API
  var api = {
    version: VERSION,
    start: start,
    stop: function () { stop(); },
    toggle: function () { if (state.running) { stop(); } else { start(); } },
    isRunning: function () { return state.running; },
    getConfig: function () { return JSON.parse(JSON.stringify(cfg)); },
    getPrefs: function () { return JSON.parse(JSON.stringify(prefs)); },
    setPrefs: function (patch) {
      var user = loadUserPrefs();
      USER_KEYS.forEach(function (k) { if (patch && patch[k] !== undefined) { user[k] = patch[k]; } });
      try { localStorage.setItem(LS_KEY, JSON.stringify(user)); } catch (e) { /* 저장 실패해도 이번 세션엔 적용 */ }
      var wasSeconds = prefs.seconds;
      prefs = buildPrefs();
      if (state.running && wasSeconds !== prefs.seconds) { state.remaining = prefs.seconds * 1000; }
      render();
      emit();
      return api.getPrefs();
    },
    resetPrefs: function () {
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      prefs = buildPrefs();
      render();
      emit();
      return api.getPrefs();
    },
    isMinimized: function () { return minimized; },
    setMinimized: function (v) { saveMinimized(v); render(); emit(); },
    getStatus: function () {
      return {
        running: state.running,
        viewerDetected: !!state.viewerEl,
        remainingSec: state.running ? Math.max(0, Math.ceil(state.remaining / 1000)) : null,
        turns: state.turns,
        minimized: minimized,
        progress: state.progress ? JSON.parse(JSON.stringify(state.progress)) : null,
        prefs: api.getPrefs()
      };
    },
    onChange: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    }
  };

  installSniffers();
  buildUi();
  render();
  window.YMAutoPage = api;
  console.log('[ym_auto_page] engine ' + VERSION + ' loaded');
})();
