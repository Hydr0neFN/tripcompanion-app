# tripcompanion

A phone-first trip timeline in the shape of Deutsche Bahn Navigator's *Travel Companion*: the event
happening **now** is locked open at a fixed anchor line, its neighbours collapsed above and below,
driven by a clock pinned to the **trip's** timezone rather than the device's.

FastAPI + SQLite + vanilla JS. No build step, no framework, no bundler — clone it, set a PIN, run it.

繁體中文說明：**[README.zh-TW.md](README.zh-TW.md)**

---

## What it does

* **Anchored timeline.** One card is always locked at the anchor line (header + 64 px) and expanded.
  A slow swipe advances one card; a fling coasts several and eases into place. Tap any collapsed card
  to bring it to the anchor.
* **Trip clock, not device clock.** The timeline advances on the server's trip-timezone clock, refreshed
  on load, every 30 s, and on `visibilitychange`. A phone set to the wrong timezone still shows the
  right "now". A floating button returns to it from anywhere in the list.
* **Per-event timezones.** Each event stores naive local time plus an IANA zone; ordering is by absolute
  instant. A return leg crossing three zones lands in the right order, and cards outside the trip's home
  zone are badged so a departure time is never misread as local.
* **Cards carry what you need mid-trip:** ⚠ warnings pinned to the top, start/end times, title, city, a
  location that opens Google Maps, booking codes rendered large, and ticket attachments (PDF/JPG/PNG)
  as open buttons.
* **Date rail** down the right edge: one cell per day, tinted cells showing how much of the trip has
  elapsed *by the clock*, a dot on today, an accent bar on the day being viewed. Tap a cell to jump to
  that day's first event.
* **PIN-gated editing.** Viewing needs no login; editing does. Add, edit, delete, reorder, upload
  tickets. Other devices pick up changes within 30 s, or immediately when brought back to the foreground.

## The scroll interaction

Worth reading before changing anything. Each rule below was arrived at by shipping the opposite and
watching it fail.

> **Rule 0 — no card's layout height may change while a scroll is in progress.**
> That includes a scroll the page itself started.

Changing an item's height mid-scroll makes snap coordinates drift underneath the deceleration
trajectory, so the browser miscalculates where it is stopping. The symptoms arrive in a predictable
order: jitter while scrolling, bouncing at layout seams, then flings that stop short of the card they
should reach. This is not a quirk of this codebase — it is why no mature implementation does it.
DB Navigator (`RecyclerView` + a `LinearSnapHelper` subclass), Apple Wallet
(`targetContentOffset(forProposedContentOffset:withScrollingVelocity:)` + `CATransform3D`),
Apple/Google Maps transit step cards (`PagerSnapHelper`), iOS `UIPickerView` (fixed `rowHeight` plus an
X-axis 3D rotation), Embla, keen-slider and Swiper (virtual transforms over a static snap-point array)
all keep item heights fixed, animate only `transform`/`opacity`, and defer real expansion to
scroll-end. Everything below follows from that.

1. **The anchor geometry must be constant.** Header text is `white-space: nowrap`. If the header wraps
   to a second line it gets taller, the anchor moves, and an `IntersectionObserver` built with the old
   value ends up watching a different line than alignment uses — they disagree by exactly one card. The
   observer is rebuilt when the anchor moves, not only when the viewport resizes.
2. **Focus and expansion are separate.** An `IntersectionObserver` on a 4 px band at the anchor decides
   focus, with zero measurement per frame. `.focusview` changes only opacity, border and shadow — paint,
   never layout. Type sizes and margins are identical focused or not. **No `transform: scale` on a snap
   target**: the snap area is the *transformed* border box, so scaling reintroduces the drift.
3. **Expansion happens only at rest.** `.settled` is what actually expands, and only `settle()` adds it.
   Rest is detected via `scrollend`; on browsers without it (iOS < 17.4) a 110 ms timer re-arms until the
   position stops changing **and** no finger is down — a held finger is stationary too. Never call
   `scrollTo`/`scrollBy` during momentum; WebKit kills the inertia outright.
4. **Compensate the swap in the same frame.** The outgoing card collapses instantly (removing `.settled`
   removes its transition with it), the incoming one animates open, and the focused card's top is
   restored in the same frame, so nothing appears to jump. `.timeline` carries `padding-top: 50dvh` so
   this compensation still has room near the top of the list.
5. **Snap is `proximity`, not `mandatory`.** `mandatory` requires the resting position to be a snap
   point, so with snap points every few hundred pixels the browser corrects the fling target the instant
   the finger lifts and momentum never runs. `proximity` lets the fling coast its own curve; the cost is
   that it can rest between two cards.
6. **`settle()` glides into the anchor** — the fix for the cost of rule 5. `lockTarget()` picks the card
   by comparing the current focus against its immediate neighbours only; the answer can only be one of
   those, so nothing scans the list.
7. **Touch always wins.** `touchstart` cancels any in-flight programmatic scroll and clears every lock;
   `settle()` refuses to run while a finger is down. Without it the glide from swipe *n* drags the view
   back during swipe *n+1*: momentum will not build and the page snaps back to the previous landing.
   **Rules 5, 6 and 7 are one package — keep all three or none.** A glide without touch-yield fights the
   user; touch-yield without a glide forces `mandatory` back, which costs the coast.
8. **A programmatic smooth scroll is also "a scroll in progress".** Jumps (back-to-now, date rail) share
   one path, and it needs five guards — each fixing a different cause of the same symptom, *lands
   exactly one card late, never early*:
   * disable snapping for the flight (`scroll-snap-type: none`, restored on arrival and again if the
     user interrupts) — `proximity` applies to programmatic scrolls too and re-targets the landing;
   * expand the target **instantly**, or an animated expand keeps changing layout mid-flight and the
     target computed at t=0 is already stale;
   * verify arrival before ending the jump — the compensation `scrollTo({behavior:"auto"})` issued a few
     lines earlier fires its *own* `scrollend`, which otherwise ends the flight before it starts;
   * re-pin state on arrival and release the lock late, because `IntersectionObserver` callbacks queue
     during the flight and land the instant the lock clears, overwriting focus with a neighbour;
   * make the neighbour comparison **symmetric**. Comparing only forward makes the error
     one-directional: once focus is nudged on, it can never come back. A one-directional error is the
     tell that something upstream is corrupting state, not that the arithmetic is slightly off.
9. **Day labels live inside cards** (`.day-tag`). A standalone separator left a ~76 px run with no snap
   target, which is where day-boundary bouncing came from. `.add-here` likewise needs
   `scroll-snap-align`.
10. **Expand duration is logarithmic in content height:** `140 + 55·ln(1 + Δh/80)`, clamped to
    150–320 ms. Linear scaling makes short cards flash and tall cards drag; the log curve pulls both ends
    into the same rhythm. Content fades in over a fixed 180 ms — only the *length* should track height.

Accepted trade-off: with `proximity`, "one slow swipe = exactly one card" is a browser heuristic plus
the glide rather than a guarantee. Coasting was chosen over the guarantee; tightening it again costs the
coast, and the two are mutually exclusive.

Not done yet, worth considering: CSS scroll-driven animations (`animation-timeline: view()`) would move
the focus highlight entirely to the compositor and replace the observer, and CSS Scroll Snap 2's
`scrollsnapchange` / `scrollsnapchanging` would replace rest detection. Both need testing on the actual
target iOS version — do not trust a support table alone.

---

## Running it

```bash
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt      # Windows: .venv/Scripts/python

.venv/bin/python selfcheck.py                            # must print SELFCHECK: PASS
TRIPCOMPANION_PIN=1234 .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8101 --reload
```

Open <http://127.0.0.1:8101/>.

### Configuration

Environment variables only — nothing about a specific trip is hardcoded.

| Variable | Default | Meaning |
|---|---|---|
| `TRIPCOMPANION_PIN` | **none — the app refuses to start without it, and rejects the template value `CHANGEME`** | Shared edit PIN |
| `TRIPCOMPANION_TITLE` | `旅程夥伴` | Name shown in the header and browser tab |
| `TRIPCOMPANION_TZ` | `Europe/Madrid` | The trip's timezone; the whole timeline is pinned to it. Any IANA zone works — the editor's zone list is built from this plus whatever zones the data already uses, and the header clock is labelled from it. |

### Time travel

Add `?debug_now=<ISO>` to any URL and both server and client treat that as the current moment (no offset
means the trip timezone). This is how the timeline logic gets exercised without waiting for the trip:

```
/?debug_now=2027-12-26T11:40      # mid train journey
/?debug_now=2027-12-31T11:30      # an errand before everything closes
/?debug_now=2028-01-03T14:30      # a layover, in a different timezone
```

### Your own itinerary

`app/seed.py` ships a **fictional** 58-event demo across 19 days and three timezones, dated well away
from any real trip. Two ways to use
your own:

1. edit `app/seed.py`; or
2. drop an `app/seed_local.py` beside it with the same `EVENTS` list and `seed()` function. It wins over
   `seed.py` when present and is **gitignored** — that filename exists precisely so real bookings never
   reach a commit.

`sample-itinerary.html` shows the source format and which fields map where. The database lives at
`data/tripcompanion.db` and seeds itself only when the events table is empty; delete `data/` to reseed.

`selfcheck.py` asserts **generic invariants** — monotonic ordering, no backwards jump at a timezone seam,
valid categories and zones, every day of the main run covered, no absurdly long events — so it keeps
working after the itinerary is replaced. It imports `app/schema.py` rather than `app/main.py`, so
validating data does not pull in the web stack.

---

## Deploying

```bash
tar -czf app.tar.gz app requirements.txt selfcheck.py README.md README.zh-TW.md deploy
scp app.tar.gz your-host:/root/tripcompanion/
ssh your-host 'cd /root/tripcompanion && tar -xzf app.tar.gz && rm app.tar.gz \
  && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt'
ssh your-host 'cp /root/tripcompanion/deploy/tripcompanion.service /etc/systemd/system/ \
  && systemctl daemon-reload && systemctl enable --now tripcompanion'
```

Edit the unit first — it ships `TRIPCOMPANION_PIN=CHANGEME`, which the app rejects at startup, so the
service will not come up until a real PIN is set. It binds `127.0.0.1:8101` with `--proxy-headers --forwarded-allow-ips 127.0.0.1`, so it is only
reachable through whatever proxy sits in front. **Run a single worker** — sessions and rate-limit
counters live in process memory, so `--workers 2` would desynchronise both. `data/` is not in the tarball, so redeploying never
touches itinerary data or uploaded tickets.

### Exposing it

The app does not touch tunnel configuration. With Cloudflare Tunnel, add a public hostname pointing at
`127.0.0.1:8101`.

> **Viewing requires no login, and that includes ticket attachments.** Filenames are unguessable, but the
> page links to them, so anyone with the URL can open them. Put an access policy in front of the hostname
> before uploading passport scans or visas.

The shared PIN is short and numeric by design — it stops an accidental edit, it is not meant to stand
alone on the open internet. Treat the access policy as the real boundary. Rate limiting uses a 10-minute
sliding window: 10 failures per IP, with a much higher global backstop of 400, deliberately set so one
attacker cannot lock every editor out by burning the shared counter.

## Layout

```
app/main.py        FastAPI: /api/state, event CRUD, PIN auth, uploads, /files/<random>
app/schema.py      category whitelist + timezone validation/labels, shared with selfcheck
app/db.py          SQLite schema (events / attachments / meta)
app/seed.py        fictional demo itinerary; app/seed_local.py wins when present
app/static/app.js  anchor logic, rendering, polling, editing UI
app/static/app.css dark, large-type styling
app/templates/index.html
selfcheck.py       generic invariants over the seed data
deploy/tripcompanion.service
```

## Licence

MIT — see [LICENSE](LICENSE).
