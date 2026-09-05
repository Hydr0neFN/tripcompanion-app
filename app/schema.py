# -*- coding: utf-8 -*-
"""Shared vocabulary. Kept out of main.py so selfcheck.py can import it without
pulling in FastAPI — validating data should not need the web stack."""
from zoneinfo import available_timezones

CATEGORIES = {"transport", "sight", "meal", "hotel", "prep"}

# Nicer zh-TW names for zones likely to show up on a card. Anything not listed
# falls back to the last path segment, so an unlisted zone still reads sensibly
# rather than being rejected — the trip timezone is configurable, so the set of
# zones in play is not knowable ahead of time.
_TZ_NAMES = {
    "Europe/Madrid": "馬德里",
    "Europe/Istanbul": "伊斯坦堡",
    "Europe/Amsterdam": "阿姆斯特丹",
    "Europe/London": "倫敦",
    "Europe/Paris": "巴黎",
    "Europe/Berlin": "柏林",
    "Asia/Taipei": "台灣",
    "Asia/Tokyo": "日本",
    "Asia/Seoul": "韓國",
    "Asia/Singapore": "新加坡",
    "Asia/Bangkok": "曼谷",
    "Asia/Dubai": "杜拜",
    "America/New_York": "紐約",
    "America/Los_Angeles": "洛杉磯",
}


def valid_tz(name: str) -> bool:
    """Any real IANA zone is allowed. Whitelisting a fixed three broke the moment
    the trip timezone became configurable."""
    return name in available_timezones()


def tz_display(name: str) -> str:
    """Human-facing name for a zone, e.g. 'Asia/Tokyo' -> '日本'."""
    return _TZ_NAMES.get(name) or name.rsplit("/", 1)[-1].replace("_", " ")


def tz_badge(name: str, trip_tz: str) -> str:
    """Badge shown on a card. Empty for the trip's own zone — badging every card
    would be noise; the point is to flag the ones that are *not* local."""
    return "" if name == trip_tz else tz_display(name) + "時間"
