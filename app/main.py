# -*- coding: utf-8 -*-
"""tripcompanion — a phone-first trip timeline (FastAPI + SQLite, no build step)."""
import datetime
import hashlib
import hmac
import os
import pathlib
import re
import secrets
import time
import uuid
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import Body, FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db
from .schema import CATEGORIES, tz_badge, tz_display, valid_tz

# 本機／Pi 上放的是真實行程（app/seed_local.py，不進 repo）；
# repo 裡只有合成的示範資料。有真的就用真的。
try:
    from . import seed_local as seed
except ImportError:
    from . import seed

BASE = pathlib.Path(__file__).resolve().parent
# 時間軸釘在旅程的時區，不看裝置時區。改成你自己的目的地。
TRIP_TZ_NAME = os.environ.get("TRIPCOMPANION_TZ", "Europe/Madrid")
TRIP_TZ = ZoneInfo(TRIP_TZ_NAME)
# 顯示在頁首的旅程名稱。刻意不寫死 —— 真實的旅程名屬於部署，不屬於原始碼。
TRIP_TITLE = os.environ.get("TRIPCOMPANION_TITLE", "旅程夥伴")

DEFAULT_TITLE = "旅程夥伴"
EDIT_PIN = os.environ.get("TRIPCOMPANION_PIN", "")
# Digit-only PINs get the phone-style keypad sized to this; anything else falls back to a plain
# text field. Length only — never the value.
PIN_LEN = len(EDIT_PIN) if EDIT_PIN.isdigit() and 4 <= len(EDIT_PIN) <= 8 else 0
SESSION_DAYS = 30
COOKIE = "tc_session"
MAX_UPLOAD = 10 * 1024 * 1024
ALLOWED_EXT = {".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".png": "image/png"}
MAGIC = {b"%PDF": "application/pdf", b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png"}
WEEKDAY_ZH = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]

app = FastAPI(title="tripcompanion", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")


def _static_version() -> str:
    h = hashlib.md5()
    for p in sorted((BASE / "static").glob("*")):
        h.update(p.read_bytes())
    return h.hexdigest()[:8]


templates.env.globals["static_v"] = _static_version()
templates.env.globals["trip_title"] = TRIP_TITLE

_SESSION_KEY = b""               # set at startup, see _load_session_key()


def _load_session_key() -> bytes:
    """Random per-install secret (data/session.key) mixed with the PIN: sessions survive a
    restart or redeploy, and changing the PIN signs every device out."""
    path = db.DATA_DIR / "session.key"
    if not path.exists():
        path.write_bytes(secrets.token_bytes(32))
        path.chmod(0o600)
    return hashlib.sha256(path.read_bytes() + EDIT_PIN.encode()).digest()


_PIN_FAILS: dict[str, list[float]] = {}
_GLOBAL_FAILS: list[float] = []
MAX_FAILS_PER_IP = 10
MAX_FAILS_GLOBAL = 400         # backstop for spoofed X-Forwarded-For; deliberately far
                               # above MAX_FAILS_PER_IP so one attacker cannot lock every editor out


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.on_event("startup")
def startup() -> None:
    if not EDIT_PIN or EDIT_PIN == "CHANGEME":
        raise RuntimeError(
            "TRIPCOMPANION_PIN is unset or still the template value. Refusing to start — "
            "set a real PIN in the systemd unit (see deploy/tripcompanion.service) or your shell."
        )
    db.init()
    global _SESSION_KEY
    _SESSION_KEY = _load_session_key()
    con = db.connect()
    try:
        if con.execute("SELECT COUNT(*) c FROM events").fetchone()["c"] == 0:
            n = seed.seed(con)
            print(f"[tripcompanion] seeded {n} events")
        db.bump_rev(con)
        con.commit()
    finally:
        con.close()


# --------------------------------------------------------------------- helpers

def jresp(data, status_code: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status_code, headers={"Cache-Control": "no-store"})


def client_ip(request: Request) -> str:
    """cloudflared sets cf-connecting-ip itself; XFF is caller-controlled, so it is a
    hint for logging only and never the sole basis for a limit (see _GLOBAL_FAILS)."""
    return (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "?")
    )


def tzinfo(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception:
        return TRIP_TZ


def parse_local(s: str, tz: str) -> datetime.datetime | None:
    """'YYYY-MM-DDTHH:MM' in the given zone -> aware datetime."""
    if not s:
        return None
    s = s.strip().replace(" ", "T")[:16]
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(tzinfo=tzinfo(tz))
    except ValueError:
        return None


def now_madrid(request: Request) -> datetime.datetime:
    """Trip clock.  ?debug_now=<ISO> lets us time-travel for testing."""
    raw = request.query_params.get("debug_now")
    if raw:
        try:
            dt = datetime.datetime.fromisoformat(raw.strip())
            return dt if dt.tzinfo else dt.replace(tzinfo=TRIP_TZ)
        except ValueError:
            pass
    return datetime.datetime.now(TRIP_TZ)


def day_label(d: datetime.date) -> str:
    return f"{d.month}/{d.day} {WEEKDAY_ZH[d.weekday()]}"


def event_json(row, attachments: list) -> dict:
    tz = row["tz"] or "Europe/Madrid"
    start = parse_local(row["start_at"], tz)
    end = parse_local(row["end_at"] or "", tz)
    hhmm = start.strftime("%H:%M")
    time_label = hhmm if not end else f"{hhmm} – {end.strftime('%H:%M')}"
    return {
        "id": row["id"],
        "title": row["title"],
        "category": row["category"],
        "city": row["city"],
        "location": row["location"],
        "code": row["code"],
        "warning": row["warning"],
        "notes": row["notes"],
        "tz": tz,
        "tz_label": tz_badge(tz, TRIP_TZ_NAME),
        "start_at": row["start_at"],
        "end_at": row["end_at"] or "",
        "start_ts": int(start.timestamp()),
        "end_ts": int(end.timestamp()) if end else None,
        "day_key": start.date().isoformat(),
        "day_label": day_label(start.date()),
        "time_label": time_label,
        "position": row["position"],
        "attachments": attachments,
    }


def load_events(con) -> list[dict]:
    atts: dict[int, list] = {}
    for a in con.execute("SELECT * FROM attachments ORDER BY id").fetchall():
        atts.setdefault(a["event_id"], []).append({
            "id": a["id"], "name": a["orig_name"], "mime": a["mime"],
            "url": "/files/" + a["stored_name"],
            "size": a["size"], "is_image": a["mime"].startswith("image/"),
        })
    rows = con.execute("SELECT * FROM events").fetchall()
    out = [event_json(r, atts.get(r["id"], [])) for r in rows]
    out.sort(key=lambda e: (e["start_ts"], e["position"], e["id"]))
    return out


# ------------------------------------------------------------------------ auth

def _sign(exp: str) -> str:
    return hmac.new(_SESSION_KEY, exp.encode(), hashlib.sha256).hexdigest()


def is_authed(request: Request) -> bool:
    """Cookie = '<expiry epoch>.<hmac>'. Stateless, so sessions survive a restart or redeploy —
    the PIN now gates viewing too, and a restart must not lock the whole family out mid-trip."""
    exp, _, sig = request.cookies.get(COOKIE, "").partition(".")
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(exp))


def need_editor(request: Request):
    return None if is_authed(request) else jresp({"error": "需要 PIN"}, 401)


def pin_rate_limited(ip: str) -> bool:
    cutoff = time.time() - 600
    _GLOBAL_FAILS[:] = [t for t in _GLOBAL_FAILS if t > cutoff]
    for key in [k for k, v in _PIN_FAILS.items() if not [t for t in v if t > cutoff]]:
        _PIN_FAILS.pop(key, None)          # keep the dict from growing without bound
    tries = [t for t in _PIN_FAILS.get(ip, []) if t > cutoff]
    if tries:
        _PIN_FAILS[ip] = tries
    # 全站計數只用來擋「大量來源同時猛試」的極端情況，門檻拉得比單一 IP 高很多。
    # 不能讓任何人送幾十次錯誤 PIN 就把所有編輯者鎖死十分鐘 —— 那是免費的阻斷服務。
    return len(tries) >= MAX_FAILS_PER_IP or len(_GLOBAL_FAILS) >= MAX_FAILS_GLOBAL


def record_pin_fail(ip: str) -> None:
    now = time.time()
    _PIN_FAILS.setdefault(ip, []).append(now)
    _GLOBAL_FAILS.append(now)


@app.get("/api/auth")
def auth_state(request: Request):
    return jresp({"authed": is_authed(request), "pin_len": PIN_LEN})


@app.post("/api/auth")
def auth_login(request: Request, payload: dict = Body(...)):
    ip = client_ip(request)
    if pin_rate_limited(ip):
        return jresp({"error": "嘗試太多次，請十分鐘後再試"}, 429)
    if not secrets.compare_digest(str(payload.get("pin", "")), EDIT_PIN):
        record_pin_fail(ip)
        return jresp({"error": "PIN 碼不對"}, 401)
    exp = str(int(time.time()) + SESSION_DAYS * 86400)
    resp = jresp({"authed": True})
    resp.set_cookie(COOKIE, f"{exp}.{_sign(exp)}", max_age=SESSION_DAYS * 86400, httponly=True,
                    samesite="lax", path="/", secure=request.url.scheme == "https")
    return resp


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    """Clears this device's cookie. Stateless tokens cannot be revoked one by one — changing the
    PIN is what signs every device out."""
    resp = jresp({"authed": False})
    resp.delete_cookie(COOKIE, path="/")
    return resp


# ----------------------------------------------------------------------- state

@app.get("/api/state")
def api_state(request: Request):
    if not is_authed(request):
        return jresp({"error": "需要 PIN", "pin_len": PIN_LEN}, 401)
    now = now_madrid(request)
    con = db.connect()
    try:
        events = load_events(con)
        rev = db.get_rev(con)
    finally:
        con.close()
    used = sorted({e["tz"] for e in events} | {TRIP_TZ_NAME})
    return jresp({
        "trip_tz": TRIP_TZ_NAME,
        "clock_label": tz_display(TRIP_TZ_NAME) + "時間",
        "tz_choices": [{"tz": z, "label": tz_display(z)} for z in used],
        "now_ts": int(now.timestamp()),
        "now_label": now.strftime("%m/%d %H:%M"),
        "now_day": day_label(now.date()),
        "rev": rev,
        "title": TRIP_TITLE,
        "events": events,
    })


# ---------------------------------------------------------------------- events

def clean_event(p: dict) -> tuple[dict | None, str]:
    title = (p.get("title") or "").strip()
    if not title:
        return None, "標題不能空白"
    tz = (p.get("tz") or TRIP_TZ_NAME).strip()
    if not valid_tz(tz):
        return None, "時區不存在"
    start = (p.get("start_at") or "").strip().replace(" ", "T")[:16]
    if not parse_local(start, tz):
        return None, "開始時間格式要是 YYYY-MM-DDTHH:MM"
    end = (p.get("end_at") or "").strip().replace(" ", "T")[:16]
    if end and not parse_local(end, tz):
        return None, "結束時間格式不對"
    if end and parse_local(end, tz) < parse_local(start, tz):
        return None, "結束時間早於開始時間"
    cat = (p.get("category") or "sight").strip()
    if cat not in CATEGORIES:
        cat = "sight"
    return {
        "title": title[:200], "category": cat, "start_at": start, "end_at": end, "tz": tz,
        "city": (p.get("city") or "").strip()[:80],
        "location": (p.get("location") or "").strip()[:200],
        "code": (p.get("code") or "").strip()[:80],
        "warning": (p.get("warning") or "").strip()[:1000],
        "notes": (p.get("notes") or "").strip()[:4000],
    }, ""


@app.post("/api/events")
def create_event(request: Request, payload: dict = Body(...)):
    if (err := need_editor(request)):
        return err
    data, msg = clean_event(payload)
    if not data:
        return jresp({"error": msg}, 400)
    con = db.connect()
    try:
        pos = con.execute("SELECT COALESCE(MAX(position),0)+1 p FROM events").fetchone()["p"]
        cur = con.execute(
            "INSERT INTO events(title,category,start_at,end_at,tz,city,location,code,"
            "warning,notes,position) VALUES(:title,:category,:start_at,:end_at,:tz,:city,"
            ":location,:code,:warning,:notes,:position)",
            {**data, "position": pos},
        )
        db.bump_rev(con)
        con.commit()
        return jresp({"id": cur.lastrowid})
    finally:
        con.close()


@app.put("/api/events/{event_id}")
def update_event(request: Request, event_id: int, payload: dict = Body(...)):
    if (err := need_editor(request)):
        return err
    data, msg = clean_event(payload)
    if not data:
        return jresp({"error": msg}, 400)
    con = db.connect()
    try:
        cur = con.execute(
            "UPDATE events SET title=:title, category=:category, start_at=:start_at, "
            "end_at=:end_at, tz=:tz, city=:city, location=:location, code=:code, "
            "warning=:warning, notes=:notes, updated_at=datetime('now') WHERE id=:id",
            {**data, "id": event_id},
        )
        if cur.rowcount == 0:
            return jresp({"error": "找不到這個事件"}, 404)
        db.bump_rev(con)
        con.commit()
        return jresp({"ok": True})
    finally:
        con.close()


@app.delete("/api/events/{event_id}")
def delete_event(request: Request, event_id: int):
    if (err := need_editor(request)):
        return err
    con = db.connect()
    try:
        stored = [r["stored_name"] for r in con.execute(
            "SELECT stored_name FROM attachments WHERE event_id=?", (event_id,)).fetchall()]
        cur = con.execute("DELETE FROM events WHERE id=?", (event_id,))
        if cur.rowcount == 0:
            return jresp({"error": "找不到這個事件"}, 404)
        db.bump_rev(con)
        con.commit()
    finally:
        con.close()
    for name in stored:
        (db.ATTACH_DIR / name).unlink(missing_ok=True)
    return jresp({"ok": True})


@app.post("/api/events/reorder")
def reorder_events(request: Request, payload: dict = Body(...)):
    """ids in the wanted order; they must all share the same start_at + tz."""
    if (err := need_editor(request)):
        return err
    ids = [int(i) for i in payload.get("ids", [])][:50]
    if len(ids) < 2:
        return jresp({"error": "至少要兩個事件"}, 400)
    con = db.connect()
    try:
        marks = ",".join("?" * len(ids))
        rows = con.execute(
            f"SELECT id, start_at, tz, position FROM events WHERE id IN ({marks})", ids
        ).fetchall()
        if len(rows) != len(ids):
            return jresp({"error": "有事件不存在"}, 404)
        if len({(r["start_at"], r["tz"]) for r in rows}) != 1:
            return jresp({"error": "只有同一個開始時間的事件可以調整先後"}, 400)
        slots = sorted(r["position"] for r in rows)
        if len(set(slots)) != len(slots):        # ties would make the swap a no-op
            slots = list(range(slots[0], slots[0] + len(slots)))
        for pos, eid in zip(slots, ids):
            con.execute("UPDATE events SET position=? WHERE id=?", (pos, eid))
        db.bump_rev(con)
        con.commit()
        return jresp({"ok": True})
    finally:
        con.close()


# ------------------------------------------------------------------ attachments

@app.post("/api/events/{event_id}/attachments")
async def upload_attachment(request: Request, event_id: int, file: UploadFile = File(...)):
    if (err := need_editor(request)):
        return err
    ext = pathlib.Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        return jresp({"error": "只收 PDF / JPG / PNG"}, 400)
    blob = await file.read(MAX_UPLOAD + 1)
    if len(blob) > MAX_UPLOAD:
        return jresp({"error": "檔案超過 10MB"}, 400)
    if not blob:
        return jresp({"error": "檔案是空的"}, 400)
    mime = next((m for sig, m in MAGIC.items() if blob.startswith(sig)), None)
    if mime != ALLOWED_EXT[ext]:
        return jresp({"error": "檔案內容和副檔名不符"}, 400)
    con = db.connect()
    try:
        if not con.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
            return jresp({"error": "找不到這個事件"}, 404)
        stored = f"{uuid.uuid4().hex}{ext}"
        (db.ATTACH_DIR / stored).write_bytes(blob)
        orig = re.sub(r"[\r\n\"\\]", "_", (file.filename or "ticket")[:120])
        cur = con.execute(
            "INSERT INTO attachments(event_id, stored_name, orig_name, mime, size) "
            "VALUES(?,?,?,?,?)", (event_id, stored, orig, mime, len(blob)))
        db.bump_rev(con)
        con.commit()
        return jresp({"id": cur.lastrowid, "name": orig, "url": "/files/" + stored})
    finally:
        con.close()


@app.delete("/api/attachments/{att_id}")
def delete_attachment(request: Request, att_id: int):
    if (err := need_editor(request)):
        return err
    con = db.connect()
    try:
        row = con.execute("SELECT stored_name FROM attachments WHERE id=?", (att_id,)).fetchone()
        if not row:
            return jresp({"error": "找不到這個附件"}, 404)
        con.execute("DELETE FROM attachments WHERE id=?", (att_id,))
        db.bump_rev(con)
        con.commit()
    finally:
        con.close()
    (db.ATTACH_DIR / row["stored_name"]).unlink(missing_ok=True)
    return jresp({"ok": True})


STORED_RE = re.compile(r"^[0-9a-f]{32}\.(?:pdf|jpe?g|png)$")


def content_disposition(name: str) -> str:
    """RFC 6266 — a Chinese or Spanish filename must not blow up the latin-1 header."""
    ascii_fallback = re.sub(r"[^ -~]", "_", name).replace('"', "_")
    return f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(name)}"


@app.get("/files/{stored}")
def serve_attachment(stored: str):
    """Opaque uuid filename — sequential ids would let anyone enumerate the tickets."""
    if not STORED_RE.match(stored):
        return jresp({"error": "找不到這個附件"}, 404)
    con = db.connect()
    try:
        row = con.execute("SELECT * FROM attachments WHERE stored_name=?", (stored,)).fetchone()
    finally:
        con.close()
    if not row:
        return jresp({"error": "找不到這個附件"}, 404)
    path = db.ATTACH_DIR / row["stored_name"]
    if not path.exists():
        return jresp({"error": "檔案不見了"}, 404)
    return FileResponse(
        path, media_type=row["mime"],
        headers={"Cache-Control": "private, max-age=3600",
                 "Content-Disposition": content_disposition(row["orig_name"])},
    )


# ------------------------------------------------------------------------ page

@app.get("/healthz")
def healthz():
    return jresp({"ok": True})


@app.get("/")
def index(request: Request):
    # The real trip name is itself a disclosure; a locked device gets the generic one.
    title = TRIP_TITLE if is_authed(request) else DEFAULT_TITLE
    resp = templates.TemplateResponse(request, "index.html",
                                      {"request": request, "trip_title": title})
    resp.headers["Cache-Control"] = "no-store"
    return resp
