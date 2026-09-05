# -*- coding: utf-8 -*-
"""種子行程的自我檢查。

檢查的是**通用規則**，不是某一趟旅行的內容 —— 換成你自己的行程之後這個檔不用改。
刻意只 import app.schema，不 import app.main：驗證資料不該需要整個 web stack。

    python selfcheck.py
"""
import datetime
import sys
from zoneinfo import ZoneInfo

from app.schema import CATEGORIES, valid_tz

try:                       # 本機有真實行程就驗它，否則驗 repo 內的示範資料
    from app.seed_local import EVENTS
    SOURCE = "app/seed_local.py"
except ImportError:
    from app.seed import EVENTS
    SOURCE = "app/seed.py"

errors, warnings = [], []


def ts(when, tz):
    return datetime.datetime.strptime(when, "%Y-%m-%dT%H:%M").replace(tzinfo=ZoneInfo(tz))


parsed = []
for i, row in enumerate(EVENTS):
    if len(row) != 10:
        errors.append(f"[{i}] 欄位數不是 10：{len(row)}")
        continue
    start, end, tz, cat, city, title, loc, code, warn, notes = row
    if not title.strip():
        errors.append(f"[{i}] 標題是空的")
    if not valid_tz(tz):
        errors.append(f"[{i}] {title}: 時區不存在 {tz}")
        continue
    if cat not in CATEGORIES:
        errors.append(f"[{i}] {title}: 分類不支援 {cat}")
    try:
        s = ts(start, tz)
    except ValueError:
        errors.append(f"[{i}] {title}: 開始時間格式壞了 {start}")
        continue
    e = None
    if end:
        try:
            e = ts(end, tz)
        except ValueError:
            errors.append(f"[{i}] {title}: 結束時間格式壞了 {end}")
        if e and e < s:
            errors.append(f"[{i}] {title}: 結束早於開始")
    parsed.append((s, e, title, code, loc, warn, cat, tz))

if not parsed:
    print("種子資料是空的")
    sys.exit(1)

# 1) 宣告順序必須就是時間順序（跨時區也要成立 —— 比的是絕對時刻）
for a, b in zip(parsed, parsed[1:]):
    if b[0] < a[0]:
        errors.append(f"順序錯亂：「{a[2]}」({a[0]}) 之後排了「{b[2]}」({b[0]})")

# 2) 重疊只是提醒 —— 寄放行李跨越午餐這種是合理的
for a, b in zip(parsed, parsed[1:]):
    if a[1] and b[0] < a[1]:
        warnings.append(f"時間重疊：「{a[2]}」到 {a[1]:%m/%d %H:%M}，但「{b[2]}」{b[0]:%m/%d %H:%M} 就開始")

# 3) 跨時區的事件必須各自獨立成一筆。若某筆的時區與前一筆不同，
#    它就是「抵達」那一筆，時間軸靠它在正確的絕對時刻推進。
for a, b in zip(parsed, parsed[1:]):
    if a[7] != b[7] and (b[0] - a[0]).total_seconds() < 0:
        errors.append(f"跨時區接點時間倒退：「{a[2]}」→「{b[2]}」")

# 4) 主行程期間每天都要有事件（最長的連續日期段就是主行程）
days = sorted({p[0].date() for p in parsed})
best_start = best_len = run_start = 0
run_len = 1
for i in range(1, len(days)):
    if (days[i] - days[i - 1]).days == 1:
        run_len += 1
    else:
        run_start, run_len = i, 1
    if run_len > best_len:
        best_len, best_start = run_len, run_start
trip = days[best_start:best_start + best_len]
if len(trip) < 2:
    warnings.append("找不到連續兩天以上的主行程段")

# 5) 有結束時間的事件不該長到誇張（多半是打錯日期）
for s, e, title, *_ in parsed:
    if e and (e - s).total_seconds() > 24 * 3600:
        errors.append(f"「{title}」持續超過 24 小時，日期可能打錯")

print(f"來源：{SOURCE}")
print(f"事件數：{len(parsed)}／{len(EVENTS)}")
print(f"期間：{parsed[0][0]:%Y-%m-%d %H:%M} → {parsed[-1][0]:%Y-%m-%d %H:%M}")
print(f"主行程連續段：{trip[0]} → {trip[-1]}（{len(trip)} 天）")
print(f"用到的時區：{', '.join(sorted({p[7] for p in parsed}))}")
print(f"分類分佈：{', '.join(f'{c}×{sum(1 for p in parsed if p[6] == c)}' for c in sorted(CATEGORIES))}")
for w in warnings:
    print("  ! " + w)
for e in errors:
    print("  ✗ " + e)
print("SELFCHECK: " + ("FAIL" if errors else "PASS"))
sys.exit(1 if errors else 0)
