/* ym_auto_page / dashboard.js - 홈 위젯: 앱을 열 때 엔진을 자동으로 로드 + 간단 조절
 * 코어가 function(pluginId, shadowRoot, items) 형태로 실행한다.
 *
 * 접기 버튼은 코어 카드 머리글의 × 버튼 왼쪽에 끼워 넣는다. 코어 DOM 구조는 공식 계약이
 * 아니므로, × 버튼을 못 찾으면 위젯 안쪽 오른쪽 위에 접기 버튼을 두는 방식으로 물러난다. */
var PLUGIN_ID = (typeof pluginId !== 'undefined' && pluginId) || 'ym_auto_page';
var WIDGET_KEY = 'ym_auto_page_widget';
var $ = function (role) { return shadowRoot.querySelector('[data-role="' + role + '"]'); };

function isWidgetMin() {
  try { return !!(JSON.parse(localStorage.getItem(WIDGET_KEY) || '{}') || {}).minimized; } catch (e) { return false; }
}

/* ---------- 코어 머리글의 × 버튼 찾기 ---------- */
function looksLikeClose(el) {
  if (!el || el.closest('[data-ym-ap-fold]')) { return false; }
  var label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.className || '')).toLowerCase();
  var text = (el.textContent || '').trim();
  return text === '×' || text === '✕' || text === 'x' ||
    /close|remove|delete|닫기|제거|삭제/.test(label) ||
    !!el.querySelector('.fa-xmark, .fa-times, .fa-close');
}

function findCloseButton(host) {
  var node = host.parentElement;
  for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    var cands = node.querySelectorAll('button, [role="button"], .close, [class*="remove"], [class*="close"]');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (host.contains(c) || c.contains(host)) { continue; }
      if (looksLikeClose(c)) { return c; }
    }
  }
  return null;
}

/* ---------- 접기 버튼 ---------- */
var foldBtn = null, foldStatus = null;

function makeHeaderFold(closeBtn) {
  var parent = closeBtn.parentElement;
  var old = parent.querySelector('[data-ym-ap-fold]');
  if (old) { old.remove(); }

  var box = document.createElement('span');
  box.setAttribute('data-ym-ap-fold', '1');
  box.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-right:6px;vertical-align:middle;';

  foldStatus = document.createElement('span');
  foldStatus.style.cssText = 'font-size:.8rem;color:var(--app-text-muted,#9aa3b2);font-variant-numeric:tabular-nums;white-space:nowrap;';

  foldBtn = document.createElement('button');
  foldBtn.type = 'button';
  foldBtn.style.cssText = 'all:unset;cursor:pointer;width:24px;height:24px;display:inline-grid;place-items:center;' +
    'border-radius:50%;color:var(--app-text-muted,#9aa3b2);font-size:.95rem;line-height:1;transition:transform .15s;';
  foldBtn.addEventListener('mouseenter', function () { foldBtn.style.background = 'var(--app-bg-card-hover,rgba(255,255,255,.08))'; });
  foldBtn.addEventListener('mouseleave', function () { foldBtn.style.background = 'transparent'; });
  foldBtn.textContent = '▾';

  box.appendChild(foldStatus);
  box.appendChild(foldBtn);
  parent.insertBefore(box, closeBtn);
  return foldBtn;
}

var closeBtn = shadowRoot.host ? findCloseButton(shadowRoot.host) : null;
if (closeBtn) {
  makeHeaderFold(closeBtn);
} else {
  foldBtn = $('fold');      // 물러난 위치: 위젯 안쪽
  foldBtn.hidden = false;
}

function applyMin(v) {
  $('card').classList.toggle('is-min', v && !!closeBtn);  // 머리글 버튼이 있을 때만 본문 전체를 숨김
  if (!closeBtn) {
    shadowRoot.querySelector('.ctl').style.display = v ? 'none' : '';
    $('hint').style.display = v ? 'none' : '';
  }
  foldBtn.textContent = v ? '▸' : '▾';
  foldBtn.title = v ? '펼치기' : '접기';
  foldBtn.setAttribute('aria-label', v ? '펼치기' : '접기');
  foldBtn.setAttribute('aria-expanded', String(!v));
  if (foldStatus) { foldStatus.style.display = v ? '' : 'none'; }
}
function setWidgetMin(v) {
  try { localStorage.setItem(WIDGET_KEY, JSON.stringify({ minimized: !!v })); } catch (e) { /* ignore */ }
  applyMin(!!v);
}
applyMin(isWidgetMin());
foldBtn.addEventListener('click', function (e) { e.stopPropagation(); setWidgetMin(!isWidgetMin()); });

/* ---------- 엔진 ---------- */
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

function step(cur, dir) {
  var s = cur < 10 ? 1 : (cur < 60 ? 5 : 15);
  if (dir < 0 && cur <= 10 && cur > 1) { s = 1; }
  return Math.max(1, Math.min(600, cur + dir * s));
}

loadEngine().then(function (ap) {
  function paint() {
    var st = ap.getStatus();
    $('sec').textContent = st.prefs.seconds + '초';
    $('badge').textContent = st.running ? '켜짐' : '대기';
    $('badge').classList.toggle('on', st.running);
    $('hint').textContent = '뷰어를 연 뒤 ' + (ap.getConfig().hotkey || 'Alt+A') + ' 로 시작/정지합니다.';
    if (foldStatus) { foldStatus.textContent = (st.running ? '켜짐 ' : '') + st.prefs.seconds + '초'; }
  }
  $('minus').addEventListener('click', function () { ap.setPrefs({ seconds: step(ap.getPrefs().seconds, -1) }); });
  $('plus').addEventListener('click', function () { ap.setPrefs({ seconds: step(ap.getPrefs().seconds, +1) }); });
  var off = ap.onChange(function () { if (shadowRoot.host && shadowRoot.host.isConnected) { paint(); } else { off(); } });
  paint();
}).catch(function (err) {
  $('badge').textContent = '오류';
  if (foldStatus) { foldStatus.textContent = '오류'; }
  $('hint').textContent = '엔진을 불러오지 못했습니다: ' + err.message;
});
