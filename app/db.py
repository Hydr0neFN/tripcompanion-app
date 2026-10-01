"""SQLite storage layer for tripcompanion."""
import pathlib
import sqlite3

DATA_DIR = pathlib.Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "tripcompanion.db"
ATTACH_DIR = DATA_DIR / "attachments"

SCHEMA = """
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'sight',
  start_at TEXT NOT NULL,              -- 'YYYY-MM-DDTHH:MM', naive local time in tz
  end_at TEXT,                         -- same shape, same tz, optional
  tz TEXT NOT NULL DEFAULT 'Europe/Madrid',
  city TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',   -- place name -> Google Maps query
  code TEXT NOT NULL DEFAULT '',       -- booking / reservation locator
  warning TEXT NOT NULL DEFAULT '',    -- shown at TOP of the card
  notes TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, -- tie-break within the same start_at
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL,
  orig_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attach_event ON attachments(event_id);
CREATE TABLE IF NOT EXISTS night_prep(
  id INTEGER PRIMARY KEY,
  target_date TEXT NOT NULL,            -- 'YYYY-MM-DD': the evening this belongs to
  title TEXT NOT NULL,
  alarm_time TEXT NOT NULL DEFAULT '',  -- 'HH:MM': the wake-up alarm to set tonight
  due_time TEXT NOT NULL DEFAULT '',    -- 'HH:MM': when this has to happen that evening
  is_done INTEGER NOT NULL DEFAULT 0,   -- shared across every phone
  linked_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prep_date ON night_prep(target_date);
CREATE TABLE IF NOT EXISTS meta(
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    ATTACH_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=5000")
    return con


# Columns added after the first deploy. ALTER TABLE keeps existing data; SCHEMA stays the
# original shape so old databases and new ones converge through the same path.
ADDED_COLUMNS = {
    "hint": "TEXT NOT NULL DEFAULT ''",   # collapsed practical tips; one per blank-line block
    "eve": "TEXT NOT NULL DEFAULT ''",    # what to prepare the night before this event
}


def init() -> None:
    con = connect()
    try:
        con.executescript(SCHEMA)
        have = {r["name"] for r in con.execute("PRAGMA table_info(events)")}
        for col, decl in ADDED_COLUMNS.items():
            if col not in have:
                con.execute(f"ALTER TABLE events ADD COLUMN {col} {decl}")
        con.commit()
    finally:
        con.close()


def bump_rev(con: sqlite3.Connection) -> None:
    """Monotonic revision counter — clients poll it to detect edits cheaply."""
    con.execute(
        "INSERT INTO meta(k,v) VALUES('rev','1') "
        "ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)"
    )


def get_rev(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT v FROM meta WHERE k='rev'").fetchone()
    return int(row["v"]) if row else 0
