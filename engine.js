/*
 * ym_auto_page / engine.js
 *
 * new Function('cfg', engineCode)(cfg) 형태로 한 번만 실행되어 window.YMAutoPage를 만든다.
 * cfg = 관리자 설정 (ym_auto_page.py의 _client_config 참고)
 * 사용자별 값(간격/방식/키 등)은 이 기기의 localStorage에 따로 저장되어 cfg를 덮어쓴다.
 */
(function () {
  'use strict';

  var VERSION = '1.3.0';
  if (window.YMAutoPage && window.YMAutoPage.version) { return; }

  cfg = cfg || {};
  var LS_KEY = 'ym_auto_page_prefs';
  var USER_KEYS = ['seconds', 'scrollSpeed', 'method', 'key', 'resetOnInput', 'stopAtEnd'];
  var METHODS = ['auto', 'key', 'button', 'scroll'];
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

  function clampSpeed(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) { n = 60; }
    return Math.max(10, Math.min(600, n));
  }

  function buildPrefs() {
    var user = loadUserPrefs();
    var p = {
      seconds: clampSeconds(cfg.seconds || 10),
      scrollSpeed: clampSpeed(cfg.scrollSpeed || 60),
      method: cfg.method || 'auto',
      key: cfg.key || 'ArrowRight',
      resetOnInput: cfg.resetOnInput !== false,
      stopAtEnd: cfg.stopAtEnd !== false
    };
    USER_KEYS.forEach(function (k) { if (user[k] !== undefined && user[k] !== null) { p[k] = user[k]; } });
    p.seconds = clampSeconds(p.seconds);
    p.scrollSpeed = clampSpeed(p.scrollSpeed);
    if (METHODS.indexOf(p.method) === -1) { p.method = 'auto'; }
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
    turns: 0,
    mode: null,            // 실행 중 방식: 'page'(좌우, 초 단위 넘김) | 'scroll'(상하, 서서히 스크롤)
    predictedMode: 'page', // 멈춰 있을 때 조작 버튼에 보여줄 방식
    scrollEl: null,
    scrollAcc: 0,
    rafId: null,
    pauseUntil: 0,
    endSince: 0,
    stuckMs: 0,
    lastRender: 0
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
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
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

  // 스크롤할 대상. minRatio: 내용이 화면 몇 배 이상 길어야 "세로 스크롤 뷰어"로 볼지
  function findScrollTarget(minRatio, allowDocument) {
    var viewer = state.viewerEl || findViewer();
    var sc = viewer ? findScrollable(viewer) : null;
    if (!sc && allowDocument) {
      var se = document.scrollingElement;
      if (se && se.scrollHeight > window.innerHeight + 10) { sc = se; }
    }
    if (sc && sc.scrollHeight < sc.clientHeight * (minRatio || 1)) { return null; }
    return sc;
  }

  // 상하(세로로 길게 이어지는) 뷰어면 'scroll', 좌우(페이지) 뷰어면 'page'
  function resolveMode() {
    if (prefs.method === 'scroll') { return 'scroll'; }
    if (prefs.method === 'key' || prefs.method === 'button') { return 'page'; }
    // 자동: 화면 높이의 3배 이상 이어지는 스크롤 영역이 있으면 웹툰/스크롤 뷰어로 판단
    // (페이지형 뷰어에서 그림 한 장이 화면보다 조금 긴 경우는 page로 남긴다)
    return findScrollTarget(3, false) ? 'scroll' : 'page';
  }

  // ------------------------------------------------------------------ 페이지 넘기기 (좌우)
  // 반환: 'ok' | 'fail'
  function turnPage() {
    var viewer = state.viewerEl || findViewer();

    if (prefs.method === 'button') {
      var btn = queryVisible(cfg.nextButtonSelector);
      if (!btn) { return 'fail'; }
      btn.click();
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

  // ------------------------------------------------------------------ 좌우: 초 단위 넘김
  function tick() {
    var now = performance.now();
    var dt = now - state.lastTs;
    state.lastTs = now;
    if (!state.running || state.mode !== 'page') { return; }
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
    if (result === 'fail') { stop('fail'); return; }
    state.turns += 1;
    state.remaining = prefs.seconds * 1000;
    render();
  }

  // ------------------------------------------------------------------ 상하: 서서히 스크롤
  function setScrollTop(sc, top) {
    // 뷰어에 scroll-behavior:smooth가 걸려 있어도 즉시 이동해야 매 프레임 조금씩 내려간다
    try { sc.scrollTo({ top: top, behavior: 'instant' }); } catch (e) { sc.scrollTop = top; }
  }

  function scrollFrame(ts) {
    if (!state.running || state.mode !== 'scroll') { return; }
    state.rafId = requestAnimationFrame(scrollFrame);
    var dt = Math.min(100, ts - state.lastTs);  // 탭 전환 뒤 첫 프레임이 크게 튀지 않도록
    state.lastTs = ts;
    if (document.hidden || dt <= 0) { return; }

    if (performance.now() < state.pauseUntil) { renderThrottled(ts); return; }  // 사용자가 만진 직후 잠깐 멈춤

    var sc = state.scrollEl;
    if (!sc || !sc.isConnected) {
      sc = state.scrollEl = findScrollTarget(prefs.method === 'scroll' ? 1 : 3, prefs.method === 'scroll');
      if (!sc) { stop('fail'); return; }
    }

    var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    if (!atBottom) {
      state.scrollAcc += prefs.scrollSpeed * dt / 1000;
      if (state.scrollAcc >= 1) {
        var n = Math.floor(state.scrollAcc);
        state.scrollAcc -= n;
        var before = sc.scrollTop;
        setScrollTop(sc, before + n);
        state.stuckMs = (Math.abs(sc.scrollTop - before) < 0.5) ? state.stuckMs + dt : 0;
      }
    }

    // 끝 판정: 바닥에 닿았거나 더 내려가지 않는 상태가 3초 이어지면 정지
    // (그 사이 다음 화가 이어 붙거나 이미지가 늦게 로드되면 계속 내려간다)
    if (atBottom || state.stuckMs > 0) {
      if (!state.endSince) { state.endSince = ts; }
      if (prefs.stopAtEnd && ts - state.endSince > 3000) { stop('end'); return; }
    } else {
      state.endSince = 0;
    }
    renderThrottled(ts);
  }

  function renderThrottled(ts) {
    if (ts - state.lastRender < 200) { return; }
    state.lastRender = ts;
    render();
  }

  // ------------------------------------------------------------------ 시작/정지
  function start() {
    if (state.running) { return; }
    var mode = resolveMode();
    if (mode === 'page' && prefs.method === 'button' && !cfg.nextButtonSelector) {
      toast("'다음' 버튼 선택자가 없습니다. 관리자 설정에서 지정하거나 다른 넘김 방식을 고르세요.");
      return;
    }
    if (mode === 'scroll') {
      state.scrollEl = findScrollTarget(prefs.method === 'scroll' ? 1 : 3, prefs.method === 'scroll');
      if (!state.scrollEl) { toast('스크롤할 영역을 찾지 못했습니다.'); return; }
    }

    state.running = true;
    state.mode = mode;
    state.turns = 0;
    state.endTurnMark = null;
    state.viewerMisses = 0;
    state.sawViewerWhileRunning = !!state.viewerEl;
    state.lastTs = performance.now();
    state.pauseUntil = 0;
    state.endSince = 0;
    state.stuckMs = 0;
    state.scrollAcc = 0;

    if (mode === 'scroll') {
      state.rafId = requestAnimationFrame(scrollFrame);
      toast('아래로 서서히 스크롤합니다 (' + prefs.scrollSpeed + 'px/초).');
    } else {
      state.remaining = prefs.seconds * 1000;
      state.tickTimer = setInterval(tick, 100);
      toast(prefs.seconds + '초마다 다음 페이지로 넘깁니다.');
    }
    render();
    emit();
  }

  function stop(reason) {
    if (!state.running) { return; }
    var mode = state.mode;
    state.running = false;
    clearInterval(state.tickTimer);
    state.tickTimer = null;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    state.mode = null;
    state.scrollEl = null;
    var name = mode === 'scroll' ? '자동 스크롤' : '자동 넘김';
    var msg = {
      end: mode === 'scroll' ? '끝까지 내려와서 자동 스크롤을 멈췄습니다.' : '마지막 페이지라 자동 넘김을 멈췄습니다.',
      fail: mode === 'scroll' ? '스크롤할 영역을 찾지 못해 멈췄습니다.' : '넘길 대상을 찾지 못해 멈췄습니다. 설정에서 넘김 방식을 확인하세요.',
      closed: '뷰어가 닫혀서 ' + name + '을 멈췄습니다.'
    }[reason] || name + '을 멈췄습니다.';
    toast(msg);
    render();
    emit();
  }

  // 사용자가 직접 넘기거나 화면을 만졌을 때
  function resetCountdown() {
    if (!state.running) { return; }
    if (state.mode === 'scroll') {
      state.pauseUntil = performance.now() + 2000;  // 2초 쉬었다가 그 위치부터 다시 내려감
      state.scrollAcc = 0;
      state.endSince = 0;
      state.stuckMs = 0;
    } else {
      state.remaining = prefs.seconds * 1000;
    }
    render();
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
    ui.minus.addEventListener('click', function () { adjust(-1); ui.minus.blur(); });
    ui.plus.addEventListener('click', function () { adjust(+1); ui.plus.blur(); });
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

  function currentMode() { return state.running ? state.mode : state.predictedMode; }

  function adjust(dir) {
    if (currentMode() === 'scroll') { api.setPrefs({ scrollSpeed: stepSpeed(prefs.scrollSpeed, dir) }); }
    else { api.setPrefs({ seconds: stepSeconds(prefs.seconds, dir) }); }
  }

  function stepSpeed(cur, dir) {
    var step = cur < 30 ? 5 : (cur < 100 ? 10 : (cur < 300 ? 20 : 50));
    if (dir < 0) { step = cur <= 30 ? 5 : (cur <= 100 ? 10 : (cur <= 300 ? 20 : 50)); }
    return clampSpeed(cur + dir * step);
  }

  function stepSeconds(cur, dir) {
    var step = cur < 10 ? 1 : (cur < 60 ? 5 : 15);
    if (dir < 0 && cur <= 10 && cur > 1) { step = 1; }
    return clampSeconds(cur + dir * step);
  }

  function setPlayIcon(running, name) {
    var i = ui.play.querySelector('i');
    var label = (name || '자동 넘김') + (running ? ' 정지' : ' 시작') + ' (' + (cfg.hotkey || 'Alt+A') + ')';
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
    var mode = currentMode();
    var label = mode === 'scroll' ? '자동 스크롤' : '자동 넘김';
    // 최소화 상태: 멈춰 있으면 ⏱, 넘김 중이면 남은 초, 스크롤 중이면 ↓
    ui.dot.textContent = !state.running ? '⏱' : (mode === 'scroll' ? '↓' : String(Math.max(0, Math.ceil(state.remaining / 1000))));
    ui.dot.title = (state.running ? label + ' 중' : label) + ' - 눌러서 펼치기';
    ui.minus.title = mode === 'scroll' ? '느리게' : '간격 줄이기';
    ui.plus.title = mode === 'scroll' ? '빠르게' : '간격 늘리기';
    ui.minus.setAttribute('aria-label', ui.minus.title);
    ui.plus.setAttribute('aria-label', ui.plus.title);
    setPlayIcon(state.running, label);

    if (mode === 'scroll') {
      ui.sec.textContent = '↓ ' + prefs.scrollSpeed + 'px/초';
      // 진행 막대 = 지금까지 내려온 위치
      var sc = state.scrollEl;
      if (state.running && sc && sc.scrollHeight > sc.clientHeight) {
        ui.bar.hidden = false;
        var pos = sc.scrollTop / (sc.scrollHeight - sc.clientHeight);
        ui.barFill.style.width = (Math.max(0, Math.min(1, pos)) * 100).toFixed(1) + '%';
      } else {
        ui.bar.hidden = true;
      }
    } else if (state.running) {
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
    if (!state.running) { state.predictedMode = v ? resolveMode() : (prefs.method === 'scroll' ? 'scroll' : 'page'); }
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
      if (state.running && state.mode === 'page' && wasSeconds !== prefs.seconds) { state.remaining = prefs.seconds * 1000; }
      if (!state.running) { state.predictedMode = state.viewerEl ? resolveMode() : (prefs.method === 'scroll' ? 'scroll' : 'page'); }
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
        mode: state.running ? state.mode : state.predictedMode,
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
