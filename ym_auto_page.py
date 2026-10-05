# -*- coding: utf-8 -*-
"""
ym_auto_page - 자동 페이지 넘김

뷰어를 연 상태에서 지정한 시간(초)마다 다음 페이지로 자동으로 넘겨주는 플러그인.

구조
- 실제 동작은 브라우저에서 도는 engine.js 하나가 전부 맡는다.
- 코어에는 "뷰어 안에서 플러그인 JS를 실행하는" 계약이 없기 때문에, engine.js는
  이 플러그인의 카테고리 탭(script.js) 또는 홈 위젯(dashboard.js)이 처음 화면에
  그려질 때 한 번 로드되어 window 전역에 상주한다(SPA라 페이지를 새로고침하기 전까지 유지).
- 로더는 engine.js 내용을 범용 플러그인 RPC
  (/api/media/context-menu/book/plugins/action, action_id="get_engine")로 받아온다.
  플러그인 폴더의 정적 파일을 직접 서빙하는 공식 경로가 없어서 쓰는 방법이며,
  코어 수정은 필요 없다.
- 페이지 넘김은 뷰어에 키보드 이벤트(기본 ArrowRight)를 보내거나, 지정한 "다음" 버튼을
  클릭하거나, 스크롤형 뷰어라면 화면 높이만큼 스크롤하는 방식 중 하나를 고른다.
"""
import json
import os

from plugins.metadata.base import BaseMetadataProvider

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_ENGINE_FILE = os.path.join(_PLUGIN_DIR, "engine.js")
_VERSION_FILE = os.path.join(_PLUGIN_DIR, "VERSION")

# 설정은 세션(DB)과 무관하게 한 벌만 쓴다 - 엔진 로더가 현재 세션을 알 방법이 없어서
_CONFIG_DB = "general"

_METHODS = ("auto", "key", "button", "scroll")
_KEYS = ("ArrowRight", "ArrowLeft", "ArrowDown", "PageDown", "Space")
_POSITIONS = ("bottom-left", "bottom-right", "top-left", "top-right")


def _read_version():
    try:
        with open(_VERSION_FILE, "r", encoding="utf-8") as f:
            return str(json.load(f).get("plugin version") or "0.0.0")
    except Exception:
        return "0.0.0"


def _to_bool(value, default):
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _to_int(value, default, lo, hi):
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _pick(value, allowed, default):
    value = str(value or "").strip()
    return value if value in allowed else default


class YM_AutoPageMetadataProvider(BaseMetadataProvider):
    id = "ym_auto_page"
    name = "자동 페이지 넘김"
    is_searchable = False

    config_schema = [
        {"key": "DEFAULT_SECONDS", "label": "기본 넘김 간격(초, 1~600)", "type": "number", "default": 10},
        {"key": "DEFAULT_SCROLL_SPEED", "label": "세로 스크롤 속도(px/초, 10~600)", "type": "number", "default": 60},
        {"key": "DEFAULT_METHOD", "label": "기본 넘김 방식", "type": "select", "default": "auto", "options": [
            {"value": "auto", "label": "자동 (좌우 뷰어는 초 단위 넘김, 상하 뷰어는 서서히 스크롤)"},
            {"value": "key", "label": "항상 키보드 키로 넘기기"},
            {"value": "button", "label": "항상 '다음' 버튼 클릭 (아래 선택자 필요)"},
            {"value": "scroll", "label": "항상 아래로 서서히 스크롤"},
        ]},
        {"key": "DEFAULT_KEY", "label": "보낼 키", "type": "select", "default": "ArrowRight", "options": [
            {"value": "ArrowRight", "label": "→ (왼쪽에서 오른쪽으로 읽기)"},
            {"value": "ArrowLeft", "label": "← (오른쪽에서 왼쪽으로 읽기, 일본식 만화)"},
            {"value": "ArrowDown", "label": "↓"},
            {"value": "PageDown", "label": "Page Down"},
            {"value": "Space", "label": "Space"},
        ]},
        {"key": "NEXT_BUTTON_SELECTOR", "label": "'다음' 버튼 CSS 선택자 (버튼 클릭 방식용)", "type": "text", "default": ""},
        {"key": "VIEWER_SELECTOR", "label": "뷰어 컨테이너 CSS 선택자 (비우면 자동 감지)", "type": "text", "default": ""},
        {"key": "HOTKEY", "label": "시작/정지 단축키", "type": "text", "default": "Alt+A"},
        {"key": "SHOW_FLOATING", "label": "뷰어에 조작 버튼 표시", "type": "checkbox", "default": True},
        {"key": "FLOAT_POSITION", "label": "조작 버튼 위치", "type": "select", "default": "bottom-left", "options": [
            {"value": "bottom-left", "label": "왼쪽 아래"},
            {"value": "bottom-right", "label": "오른쪽 아래"},
            {"value": "top-left", "label": "왼쪽 위"},
            {"value": "top-right", "label": "오른쪽 위"},
        ]},
        {"key": "STOP_AT_END", "label": "마지막 페이지에서 자동 정지", "type": "checkbox", "default": True},
        {"key": "RESET_ON_USER_INPUT", "label": "직접 넘기거나 조작하면 카운트다운 다시 시작", "type": "checkbox", "default": True},
    ]

    category_tab = {
        "title": "자동 페이지 넘김",
        "icon": "fa-solid fa-stopwatch",
        "order": 85,
        "sessions": ["general", "adult"],
    }

    # 홈 화면 플러그인 배치 모드에서 이 위젯을 추가해 두면, 앱을 열 때마다
    # 엔진이 자동으로 로드된다 (카테고리 탭을 매번 들르지 않아도 됨).
    home_widget = {
        "title": "자동 페이지 넘김",
        "icon": "fa-solid fa-stopwatch",
        "order": 90,
        "limit": 1,
        "sessions": ["general", "adult"],
        "layout": "grid",
        "size": 1,
    }

    # ---------------------------------------------------------------- 필수 계약
    def search(self, db_type, query):
        return []

    def apply(self, db_type, book_id, item_data):
        return False, "자동 페이지 넘김은 메타데이터를 적용하지 않습니다."

    # ---------------------------------------------------------------- 설정
    def _client_config(self):
        cfg = self.get_plugin_config(_CONFIG_DB, default={}) or {}
        return {
            "seconds": _to_int(cfg.get("DEFAULT_SECONDS"), 10, 1, 600),
            "scrollSpeed": _to_int(cfg.get("DEFAULT_SCROLL_SPEED"), 60, 10, 600),
            "method": _pick(cfg.get("DEFAULT_METHOD"), _METHODS, "auto"),
            "key": _pick(cfg.get("DEFAULT_KEY"), _KEYS, "ArrowRight"),
            "nextButtonSelector": str(cfg.get("NEXT_BUTTON_SELECTOR") or "").strip(),
            "viewerSelector": str(cfg.get("VIEWER_SELECTOR") or "").strip(),
            "hotkey": str(cfg.get("HOTKEY") or "Alt+A").strip() or "Alt+A",
            "showFloating": _to_bool(cfg.get("SHOW_FLOATING"), True),
            "floatPosition": _pick(cfg.get("FLOAT_POSITION"), _POSITIONS, "bottom-left"),
            "stopAtEnd": _to_bool(cfg.get("STOP_AT_END"), True),
            "resetOnInput": _to_bool(cfg.get("RESET_ON_USER_INPUT"), True),
        }

    # ---------------------------------------------------------------- 홈 위젯
    def get_dashboard_data(self, db_type, limit=10):
        cfg = self._client_config()
        return {
            "success": True,
            "items": [{
                "item_type": "metric",
                "metric": "자동 페이지 넘김",
                "value": f"{cfg['seconds']}초",
                "description": f"뷰어에서 {cfg['hotkey']} 키로 시작/정지",
            }],
        }

    # ---------------------------------------------------------------- RPC
    def get_context_menu_items(self, db_type, context):
        # 도서 우클릭 메뉴에는 아무것도 추가하지 않는다 (RPC 채널만 사용)
        return []

    def run_context_menu_action(self, db_type, action_id, context):
        if action_id == "get_config":
            return {"success": True, "config": self._client_config(), "version": _read_version()}

        if action_id == "get_engine":
            try:
                with open(_ENGINE_FILE, "r", encoding="utf-8") as f:
                    code = f.read()
            except OSError as e:
                return {"success": False, "error": f"engine.js를 읽을 수 없습니다: {e}"}
            return {
                "success": True,
                "config": self._client_config(),
                "version": _read_version(),
                "code": code,
            }

        return {"success": False, "error": f"알 수 없는 동작입니다: {action_id}"}
