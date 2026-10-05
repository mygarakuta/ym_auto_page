/* ym_auto_page / dashboard.js - 홈 위젯: 앱을 열 때 엔진을 자동으로 로드 + 간단 조절
 * 코어가 function(pluginId, shadowRoot, items) 형태로 실행한다.
 */
var PLUGIN_ID = (typeof pluginId !== 'undefined' && pluginId) || 'ym_auto_page';
var WIDGET_KEY = 'ym_auto_page_widget';
var $ = function (role) { return shadowRoot.querySelector('[data-role="' + role + '"]'); };

function isWidgetMin() {
  try { return !!(JSON.parse(localStorage.getItem(WIDGET_KEY) || '{}') || {}).minimized; } catch (e) { return false; }
}

/* ---------- 접기 ---------- */
var foldBtn = $('fold');
function applyMin(v) {
  $('card').classList.toggle('is-min', v);
  foldBtn.textContent = v ? '▸' : '▾';
  foldBtn.title = v ? '펼치기' : '접기';
  foldBtn.setAttribute('aria-label', v ? '펼치기' : '접기');
  foldBtn.setAttribute('aria-expanded', String(!v));
}
function setWidgetMin(v) {
  try { localStorage.setItem(WIDGET_KEY, JSON.stringify({ minimized: !!v })); } catch (e) { /* ignore */ }
  applyMin(!!v);
}
applyMin(isWidgetMin());
// 홈 화면 카드 드래그 정렬이 클릭을 가로채지 않도록 이벤트 전파를 막는다
['pointerdown', 'mousedown', 'touchstart'].forEach(function (t) {
  foldBtn.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true });
});
foldBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setWidgetMin(!isWidgetMin()); });

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
    $('mini').textContent = st.prefs.seconds + '초';
  }
  $('minus').addEventListener('click', function () { ap.setPrefs({ seconds: step(ap.getPrefs().seconds, -1) }); });
  $('plus').addEventListener('click', function () { ap.setPrefs({ seconds: step(ap.getPrefs().seconds, +1) }); });
  var off = ap.onChange(function () { if (shadowRoot.host && shadowRoot.host.isConnected) { paint(); } else { off(); } });
  paint();
}).catch(function (err) {
  $('badge').textContent = '오류';
  $('hint').textContent = '엔진을 불러오지 못했습니다: ' + err.message;
});
