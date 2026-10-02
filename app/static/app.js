/* tripcompanion — 前端。時間一律跟著伺服器的旅程時鐘走，不看裝置時區。 */
(function () {
  "use strict";

  var DEFAULT_DUR = 90 * 60;           // 沒填結束時間時，事件預設持續 90 分鐘
  var POLL_MS = 30000;
  var CAT = {
    transport: { icon: "🚄", label: "交通" },
    sight:     { icon: "📸", label: "景點" },
    meal:      { icon: "🍽", label: "用餐" },
    hotel:     { icon: "🏨", label: "住宿" },
    prep:      { icon: "📋", label: "準備" }
  };

  var qs = new URLSearchParams(location.search);
  var DEBUG_NOW = qs.get("debug_now") || "";

  var state = { events: [], nightPrep: [], stale: false, liveAt: 0, rev: -1, editing: false, nowTs: 0, fetchedAt: 0,
                clockLabel: "", tzChoices: [], tripTz: "" };
  var PEEK = 8;                 // 焦點卡離頂欄的距離（px）。原本是 64，讓前一張露臉；那條被壓暗的殘影擋視線，已拿掉
  var focusEventId = null;      // 停在錨線上的那張 — 只換高亮，不動版面
  var expandedEventId = null;   // 真正展開內容的那張 — 只在捲動停止時才換
  var focusCard = null, expandedCard = null;
  var io = null, settleTimer = null;
  var swapping = false;         // settle() 進行中：擋掉自己造成的回呼
  var TOP_WAIT = 400;           // 捲到頂後靜止多久才回到「現在」（ms）
  var touching = false;         // 手指在螢幕上：手勢優先，程式一律讓位
  var gliding = false, glideTimer = null;   // 停下後輕輕滑進錨線的那一段
  var jumping = false, jumpTimer = null;    // 跳轉飛行中：誰都不准插手
  var releaseTimer = null;                  // endJump 延後放開 swapping 的那一下
  var jumpTargetId = null;
  var railRows = {};            // day_key -> 軌道上那一格
  var eventDay = {};            // event id -> day_key
  var lastNowId = null;         // 上一次時間軸算出來的「現在」是哪張
  var lastRenderKey = "";
  var pendingScrollToNow = true;

  var $timeline = document.getElementById("timeline");
  var $clock = document.getElementById("clock");
  var $dayNow = document.getElementById("dayNow");
  var $fab = document.getElementById("nowFab");
  var $rail = document.getElementById("rail");
  var $editToggle = document.getElementById("editToggle");
  var $modal = document.getElementById("modal");
  var $modalTitle = document.getElementById("modalTitle");
  var $modalBody = document.getElementById("modalBody");
  var $toast = document.getElementById("toast");

  // ------------------------------------------------------------------ utils
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  /* 編輯模式用：沒有 status ＝ 根本沒連上伺服器（瀏覽器丟的是英文原文），其他才是伺服器自己的訊息 */
  function failMsg(err) {
    return err && err.status ? err.message : "沒網路，沒完成。有訊號再試一次";
  }
  function api(path, opts) {
    opts = opts || {};
    var url = path;
    if (DEBUG_NOW) url += (url.indexOf("?") < 0 ? "?" : "&") + "debug_now=" + encodeURIComponent(DEBUG_NOW);
    opts.credentials = "same-origin";
    opts.cache = "no-store";
    if (opts.json !== undefined) {
      opts.method = opts.method || "POST";
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var er = new Error(d.error || ("HTTP " + r.status));
          er.status = r.status;
          er.data = d;
          throw er;
        }
        return d;
      });
    });
  }
  var toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 2600);
  }
  function mapsUrl(q) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }
  function nowTs() {
    // 伺服器時鐘 + 本機經過的秒數。裝置時鐘設錯也不會讓時間軸跑掉。
    if (DEBUG_NOW) return state.nowTs;
    return state.nowTs + Math.round((Date.now() - state.fetchedAt) / 1000);
  }

  // -------------------------------------------------------------- 焦點計算
  function hasEnded(e, now) {
    return (e.end_ts != null ? e.end_ts : e.start_ts + DEFAULT_DUR) <= now;
  }

  function focusInfo(events, now) {
    var idx = -1;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var end = e.end_ts != null ? e.end_ts : e.start_ts + DEFAULT_DUR;
      if (e.start_ts <= now && now < end) idx = i;
    }
    if (idx >= 0) return { idx: idx, kind: "now" };
    for (var j = 0; j < events.length; j++) {
      if (events[j].start_ts > now) return { idx: j, kind: "next" };
    }
    return { idx: events.length - 1, kind: "done" };
  }

  // ------------------------------------------------------------------ 渲染
  /* 行程文字裡唯一允許的標記是 <b>…</b>（粗體）。拆成文字節點與 <b> 元素，不走 innerHTML，
     所以資料裡就算混進別的標籤也只會原樣顯示，不會被當成 HTML 執行。 */
  function rich(tag, cls, text) {
    var n = el(tag, cls);
    String(text || "").split(/(<b>[\s\S]*?<\/b>)/).forEach(function (part) {
      var m = /^<b>([\s\S]*)<\/b>$/.exec(part);
      if (m) n.appendChild(el("b", null, m[1]));
      else if (part) n.appendChild(document.createTextNode(part));
    });
    return n;
  }

  /* 小提示：空一行分段，每段第一行是摘要（收合時就看得到），其餘點開才出現。
     禮儀、「這裡怎麼運作」放這裡；會壞事的（日期、關門時間）留在 warning，永遠攤開。 */
  var hintOpen = {}, notesOpen = {};

  /* 備註：以換行為一項。收合時露出開頭的完整項目 —— 3 行內放得下幾項就放幾項（至少 1 項），
     永遠切在項目邊界，不寫摘要、不做漸層；剩下的只用數字說「還有 N 項」。
     全部放得下（或只有 1 項）就完全不摺。實際放幾項要量版面，所以排版完才由 fitNotes() 決定。 */
  var NOTES_LINES = 3;
  function notesBlock(e) {
    var items = String(e.notes || "").split("\n").map(function (t) { return t.trim(); })
      .filter(Boolean);
    var box = el("div", "notes-box");
    if (items.length < 2) { box.appendChild(rich("div", "notes", items[0] || "")); return box; }
    box.classList.add("notes-fold");
    box.dataset.id = e.id;
    items.forEach(function (t) { box.appendChild(rich("div", "notes note-item", t)); });
    var more = el("button", "note-more");
    more.type = "button";
    more.hidden = true;
    more.addEventListener("click", function () {
      notesOpen[e.id] = !notesOpen[e.id];
      applyNotes(box);
    });
    box.appendChild(more);
    return box;
  }
  /* 離開一張卡時，它裡面自己展開的東西（「還有 N 項」、小提示、明天後續）一起收回去。
     這只在卡片本身要收合的那一刻做，而且卡片收合是瞬間的（沒有過場動畫），
     所以不會在捲動途中留下任何一幀中間狀態（規則 0）。 */
  function foldInner(card) {
    var id = card.dataset.id;
    if (notesOpen[id]) {
      notesOpen[id] = false;
      var box = card.querySelector(".notes-fold");
      if (box) applyNotes(box);
    }
    var ds = card.querySelectorAll("details[open]");
    for (var i = 0; i < ds.length; i++) ds[i].open = false;   // toggle 事件會同步更新 hintOpen／laterOpen
  }
  function applyNotes(box) {
    var items = box.querySelectorAll(".note-item"), more = box.querySelector(".note-more");
    var shown = +box.dataset.shown, open = !!notesOpen[box.dataset.id];
    for (var i = 0; i < items.length; i++) items[i].hidden = !open && i >= shown;
    more.hidden = shown >= items.length;
    more.textContent = open ? "收起 ▴" : "還有 " + (items.length - shown) + " 項 ▾";
  }
  /* 預覽預算：min(3 行, 可用高度的 12%)。字級放大時行高跟著長，只看「3 行」會讓卡片膨脹到把
     下一張擠下摺線；加上 12% 的上限就會自己收斂：小字看三行、特大字可能只看一項。
     全部在 runtime 量，沒有斷點、沒有字數常數。先全部量完（一次 reflow）、再一起寫。 */
  function fitNotes() {
    var boxes = Array.prototype.slice.call($timeline.querySelectorAll(".notes-fold"));
    if (!boxes.length) return;
    var vh = Math.min(window.innerHeight, window.visualViewport ? window.visualViewport.height : 1e9);
    var usable = Math.max(200, vh - headerBottom());
    var plan = boxes.map(function (box) {
      var items = box.querySelectorAll(".note-item");
      for (var i = 0; i < items.length; i++) items[i].hidden = false;
      var lh = parseFloat(getComputedStyle(items[0]).lineHeight) || 24;
      var budget = Math.min(NOTES_LINES * lh, 0.12 * usable) + 1;
      var sum = items[0].offsetHeight, shown = 1;
      for (var k = 1; k < items.length; k++) {
        sum += items[k].offsetHeight;
        if (sum <= budget) shown = k + 1;
        else break;
      }
      return shown;
    });
    boxes.forEach(function (box, i) { box.dataset.shown = plan[i]; applyNotes(box); });
  }
  var fitTimer = null;
  var lastScrollAt = 0;
  /* 預覽項數一變，焦點卡的高度就變 —— 不能在捲動中發生（規則 0），所以只在靜止時重算 */
  function refitSoon() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function run() {
      if (touching || jumping || gliding || swapping || Date.now() - lastScrollAt < 250) {
        fitTimer = setTimeout(run, 250);
        return;
      }
      fitNotes();
    }, 150);
  }
  window.addEventListener("resize", refitSoon);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refitSoon);
  function hintRow(e) {
    var blocks = (e.hint || "").split(/\n\s*\n/).map(function (b) { return b.trim(); })
      .filter(Boolean);
    if (!blocks.length) return null;
    var r = el("div", "row");
    r.appendChild(el("div", "row-label", "小提示"));
    blocks.forEach(function (b, i) {
      var lines = b.split("\n"), head = lines.shift(), rest = lines.join("\n").trim();
      if (!rest) { r.appendChild(rich("div", "hint hint-flat", "💡 " + head)); return; }
      var key = e.id + ":" + i;
      var d = el("details", "hint");
      d.open = !!hintOpen[key];          // 每 30 秒重建時保留展開狀態
      d.appendChild(rich("summary", null, "💡 " + head));
      d.appendChild(rich("div", "hint-body", rest));
      d.addEventListener("toggle", function () { hintOpen[key] = d.open; });
      r.appendChild(d);
    });
    return r;
  }

  function eveRow(text) {
    var r = el("div", "row");
    r.appendChild(el("div", "row-label", "前一晚要準備"));
    r.appendChild(rich("div", "eve", "🌙 " + text));
    return r;
  }

  /* ---------------------------------------------------------------- 今晚預備
     一天結束後，下一天的第一站那張卡變成「今晚準備」：
       區塊 1 今晚睡前 — 鬧鐘最大最先，其餘是全家共用的打勾清單（night_prep，行程書逐日寫好，
                          不從事件文字推算）
       區塊 2 明日首站   — 就是這張卡本身（時間、地點、地圖、警告）
       區塊 3 明天還有   — 收成一行，點開才列
     切換時間 flip_at = max(當天最後一個行程結束 + 30 分, 當天當地 19:30)，沒有第二條規則。
     不設 23:00 的硬門檻：跨年夜 23:55 吃葡萄時不能把畫面翻去明天。 */
  function eveningInfo(events, f, now) {
    if (f.kind !== "next" || f.idx < 1) return null;
    var nx = events[f.idx], prev = events[f.idx - 1], alarmMax = "";
    if (prev.day_key === nx.day_key) return null;
    var dayEnd = 0;
    events.forEach(function (x) {
      if (x.day_key !== prev.day_key) return;
      var en = x.end_ts != null ? x.end_ts : x.start_ts + DEFAULT_DUR;
      if (en > dayEnd) dayEnd = en;
    });
    // 19:30 是「那天當地」的 19:30 → 用那個事件自己的牆上時間與 UTC 的差換算
    var off = Date.parse(prev.start_at + ":00Z") / 1000 - prev.start_ts;
    var floor = Date.parse(prev.day_key + "T19:30:00Z") / 1000 - off;
    if (now < Math.max(dayEnd + 1800, floor)) return null;
    var items = state.nightPrep.filter(function (p) { return p.target_date === prev.day_key; });
    /* 區塊在它自己的鬧鐘時間結束 —— 它的目的是「今晚準備什麼、幾點起床」，最後一刻就是起床那一刻。
       不是午夜：1/3 的 03:00 接駁，02:15 的鬧鐘必須活過午夜。
       終點 = 那晚最晚的 alarm_time；沒有就用明天第一個行程的 leave_at；再沒有就用它的 start_at。
       時間都是明天第一個行程自己時區的牆上時間。與翻頁公式成對：單一公式、沒有第二個條件。 */
    var wall = nx.leave_at || nx.start_at.slice(11, 16);
    items.forEach(function (p) { if (p.alarm_time && (!alarmMax || p.alarm_time > alarmMax)) alarmMax = p.alarm_time; });
    var offNx = Date.parse(nx.start_at + ":00Z") / 1000 - nx.start_ts;       // 明天第一個行程自己的時區
    var endsAt = Date.parse(nx.day_key + "T" + (alarmMax || wall) + ":00Z") / 1000 - offNx;
    if (now >= endsAt) return null;
    var today = dayKeyIn(nx, now), tomorrow = dayKeyIn(nx, now + 86400);
    return {
      word: nx.day_key === today ? "今天" : nx.day_key === tomorrow ? "明天" : "下一天",
      date: prev.day_key, prevId: prev.id, nextId: nx.id,
      rest: events.filter(function (x) { return x.day_key === nx.day_key && x.id !== nx.id; }),
      items: items
    };
  }

  function paintPrep(btn, item) {
    btn.classList.toggle("done", item.is_done);
    btn.setAttribute("aria-checked", item.is_done ? "true" : "false");
    btn.querySelector(".night-check").textContent = item.is_done ? "✓" : "";
  }
  function toggleDone(item, btn) {
    var want = !item.is_done;
    item.is_done = want;
    paintPrep(btn, item);
    api("/api/night_prep/" + item.id + "/done", { method: "PUT", json: { done: want } })
      .then(function (r) {
        // 剛好是自己造成的版本號 +1 → 不必為了這個整條重建；別人同時改過就照常重建
        if (r.rev === state.rev + 1) {
          state.rev = r.rev;
          lastRenderKey = lastRenderKey.replace(/^[^|]*/, function () { return String(r.rev); });
        }
      })
      .catch(function (x) {
        item.is_done = !want; paintPrep(btn, item);
        // 沒有 status ＝ 根本沒連上伺服器（瀏覽器丟的是英文原文：Failed to fetch／Load failed），給中文說明
        toast(x && x.status ? x.message : "沒網路，沒存到。有訊號再勾一次");
      });
  }
  function prepRow(item, cls, label, sub) {
    var b = el("button", "night-item" + (cls ? " " + cls : ""));
    b.type = "button";
    b.setAttribute("role", "checkbox");
    b.appendChild(el("span", "night-check"));
    var t = el("span", "night-title");
    t.appendChild(rich("span", null, label));
    if (sub) t.appendChild(rich("span", "night-sub", sub));
    if (item.due_time && !item.alarm_time) t.appendChild(el("span", "night-due", "　" + item.due_time));
    b.appendChild(t);
    paintPrep(b, item);
    b.addEventListener("click", function () { toggleDone(item, b); });
    return b;
  }

  /* 那一晚沒有任何 night_prep → 整塊不出現（連空狀態那一行也不要）：每晚都占一行、
     卻不是每晚都有內容的東西，會教人學會略過它。唯一的例外是清晨出發的紅色提醒，
     它只在真的清晨出發的那幾晚才會有，所以單獨留著。 */
  function nightBlock(ev, e) {
    var early = parseInt(e.start_at.slice(11, 13), 10) < 6;     // 天亮前出發
    if (!ev.items.length && !early) return null;
    var box = el("section", "night" + (early ? " early" : ""));
    box.setAttribute("aria-label", "今晚準備");
    if (early) box.appendChild(el("div", "night-early", "⚠ " + ev.word + "清晨出發"));
    if (!ev.items.length) return box;
    var hd = el("div", "night-head");
    hd.appendChild(el("span", null, "🌙 今晚睡前"));
    var back = el("button", "night-back", "↑ 回到今天");
    back.type = "button";
    back.addEventListener("click", function () { jumpToCard(cardById(ev.prevId)); });
    hd.appendChild(back);
    box.appendChild(hd);
    var alarms = ev.items.filter(function (x) { return x.alarm_time; });
    var rest = ev.items.filter(function (x) { return !x.alarm_time; });
    alarms.forEach(function (x) {
      // 「建議」＝可考慮、不是命令。不在這行併「· HH:MM 出門」：大字體的鬧鐘行會折成 3–5 行；
      // 出門時間在下面第一站那張卡上（leave_at），不重複
      box.appendChild(prepRow(x, "night-alarm", "建議 " + x.alarm_time + " 起床", x.title));
    });
    rest.forEach(function (x) { box.appendChild(prepRow(x, "", x.title)); });
    box.appendChild(el("div", "night-sep", ev.word + "第一站"));
    return box;
  }

  /* 區塊 3：收成一行，點開才列；每列點下去就滑到那張卡 */
  var laterOpen = {};
  function laterBlock(ev) {
    if (!ev.rest.length) return null;
    var d = el("details", "later");
    d.open = !!laterOpen[ev.nextId];
    d.appendChild(el("summary", null, ev.word + "還有 " + ev.rest.length + " 個行程"));
    ev.rest.forEach(function (x) {
      var b = el("button", "later-row");
      b.type = "button";
      b.appendChild(el("span", "later-time", x.time_label.slice(0, 5)));
      b.appendChild(el("span", "later-title", x.title));
      if (x.warning) b.appendChild(el("span", "later-warn", "⚠"));
      b.addEventListener("click", function () { jumpToCard(cardById(x.id)); });
      d.appendChild(b);
    });
    d.addEventListener("toggle", function () { laterOpen[ev.nextId] = d.open; });
    return d;
  }

  /* 「今天」要用那個事件自己時區的日期，不是旅程時鐘的：伊斯坦堡 00:30 時馬德里還是前一天，
     用馬德里日期會把兩小時後的紅眼班機叫成「明天」。偏移從它的牆上時間與 UTC 時刻反推。 */
  function dayKeyIn(e, ts) {
    var off = Date.parse(e.start_at + ":00Z") / 1000 - e.start_ts;
    return new Date((ts + off) * 1000).toISOString().slice(0, 10);
  }

  function buildCard(e, cls, focusKind, neighbours, dayLabel) {
    var cat = CAT[e.category] || CAT.sight;
    var card = el("article", "card " + cls);
    card.dataset.id = e.id;
    card.style.setProperty("--cat", "var(--" + (CAT[e.category] ? e.category : "sight") + ")");

    // 日期標籤放在卡片「裡面」。獨立的分隔元素會在時間軸上留下一段沒有吸附點的
    // 空隙，mandatory 吸附在那裡判定容易翻面，正是日期線附近彈跳的來源。
    if (dayLabel) card.appendChild(el("div", "day-tag", dayLabel));
    if (neighbours.evening) {
      card.classList.add("evening");
      var nb = nightBlock(neighbours.evening, e);
      if (nb) card.appendChild(nb);
    }

    var head = el("button", "card-head");
    head.type = "button";
    head.appendChild(el("div", "cat-icon", cat.icon));

    var ht = el("div", "head-top");
    if (cls.indexOf("now") >= 0) {
      ht.appendChild(el("div", "now-badge",
        focusKind === "now" ? "現在" :
        focusKind === "next" ? (neighbours.evening && neighbours.evening.items.length ? "今晚準備" : "即將開始") :
        "行程結束"));
    }
    var t = el("div", "card-time");
    // 出門時間和開始時間是兩個數字：有值才顯示，不從開始時間推算
    if (e.leave_at) {
      var lv = el("span", "leave", "出門 " + e.leave_at);
      if (e.travel_note) lv.appendChild(el("span", "travel", e.travel_note));   // 走路還是公車、約幾分：模式和數字一起才有意義
      t.appendChild(lv);
    }
    t.appendChild(el("span", null, e.time_label));
    if (e.tz_label) t.appendChild(el("span", "tz-tag", e.tz_label));
    if (e.warning) t.appendChild(el("span", "tz-tag warn-chip", "⚠ 注意"));
    ht.appendChild(t);
    head.appendChild(ht);
    head.appendChild(el("div", "chev", "▾"));
    // 標題與城市橫跨整個卡寬：放在圖示旁邊只剩約 7 個字一行，地點名會被拆成三行
    var hm = el("div", "head-main");
    hm.appendChild(el("div", "card-title", e.title));
    if (e.city) hm.appendChild(el("div", "card-city", cat.label + "・" + e.city));
    head.appendChild(hm);
    head.addEventListener("click", function () {
      alignCard(card, true);    // 點哪張就把哪張滑到錨線上展開
    });
    card.appendChild(head);

    // fold / fold-in：唯一會改到高度的地方，用 grid 0fr→1fr 做動畫
    var fold = el("div", "fold"), foldIn = el("div", "fold-in");
    fold.appendChild(foldIn);
    if (e.warning) {
      var w = el("div", "warn");
      // 文字自己常以「⚠ 」或「✔ 」開頭：圖示只留一個，✔ 開頭的（已處理）用 ✔，不要再疊一個 ⚠
      var wm = /^\s*(⚠|✔)️?\s*/.exec(e.warning);
      w.appendChild(el("span", "warn-ico", (wm && wm[1] === "✔" ? "✔ " : "⚠ ")));   // 行內：只吃第一行，其餘行用滿欄寬
      w.appendChild(rich("span", null, wm ? e.warning.slice(wm[0].length) : e.warning));
      foldIn.appendChild(w);
    }

    var body = el("div", "card-body");
    if (e.eve) body.appendChild(eveRow(e.eve));
    if (e.location) {
      var r = el("div", "row");
      var a = el("a", "maplink");
      a.href = mapsUrl(e.location);
      a.target = "_blank";
      a.rel = "noopener";
      a.appendChild(el("span", null, "📍"));
      a.appendChild(el("span", "loc", e.location));
      a.appendChild(el("span", "arrow", "看地圖 ›"));
      r.appendChild(a);
      body.appendChild(r);
    }
    if (e.code) {
      var rc = el("div", "row");
      rc.appendChild(el("div", "row-label", "訂位／訂單代號"));
      rc.appendChild(el("div", "code-box", e.code));
      body.appendChild(rc);
    }
    if (e.attachments.length) {
      var rf = el("div", "row");
      rf.appendChild(el("div", "row-label", "票券"));
      var fl = el("div", "files");
      e.attachments.forEach(function (f) {
        var b = el("a", "file-btn");
        b.href = f.url;
        b.target = "_blank";
        b.rel = "noopener";
        b.appendChild(el("span", null, f.is_image ? "🖼" : "📄"));
        b.appendChild(el("span", null, f.name));
        fl.appendChild(b);
      });
      rf.appendChild(fl);
      body.appendChild(rf);
    }
    var hr = hintRow(e);
    if (hr) body.appendChild(hr);
    if (e.notes) {
      var rn = el("div", "row");
      rn.appendChild(el("div", "row-label", "備註"));
      rn.appendChild(notesBlock(e));
      body.appendChild(rn);
    }
    if (neighbours.endOfDay) {
      // 狀態與動作分開：同一顆按鈕塞十四個字，大字級下一定破版
      var eo = el("div", "end-of-day");
      eo.appendChild(el("div", "end-of-day-text", "今日行程已結束"));
      if (neighbours.endOfDay.items.length) {      // 沒有待辦就沒有地方可去，按鈕不放
        var eb = el("button", "end-of-day-btn", "看今晚準備");
        eb.type = "button";
        eb.addEventListener("click", function () { jumpToCard(cardById(neighbours.endOfDay.nextId)); });
        eo.appendChild(eb);
      }
      body.appendChild(eo);
    }
    if (state.editing) body.appendChild(adminRow(e, neighbours));
    foldIn.appendChild(body);
    if (neighbours.evening) {
      var later = laterBlock(neighbours.evening);
      if (later) foldIn.appendChild(later);
    }
    card.appendChild(fold);
    return card;
  }

  function adminRow(e, nb) {
    var row = el("div", "admin-row");
    var edit = el("button", "mini", "✏ 編輯");
    edit.type = "button";
    edit.addEventListener("click", function (ev) { ev.stopPropagation(); openEventForm(e); });
    row.appendChild(edit);

    var up = el("button", "mini", "▲ 上移");
    up.type = "button";
    up.disabled = !nb.prevSame;
    up.addEventListener("click", function () { setOrder(e.id, nb.prevSame.id); });
    row.appendChild(up);

    var down = el("button", "mini", "▼ 下移");
    down.type = "button";
    down.disabled = !nb.nextSame;
    down.addEventListener("click", function () { setOrder(nb.nextSame.id, e.id); });
    row.appendChild(down);

    var del = el("button", "mini danger", "🗑 刪除");
    del.type = "button";
    del.addEventListener("click", function () {
      if (!confirm("確定刪除「" + e.title + "」？連同它的票券檔案一起刪掉。")) return;
      api("/api/events/" + e.id, { method: "DELETE" })
        .then(function () { toast("已刪除"); refresh(true); })
        .catch(function (err) { toast(failMsg(err)); });
    });
    row.appendChild(del);
    return row;
  }

  function setOrder(firstId, secondId) {   // firstId 會排在 secondId 前面
    api("/api/events/reorder", { json: { ids: [firstId, secondId] } })
      .then(function () { refresh(true); })
      .catch(function (err) { toast(failMsg(err)); });
  }

  function render() {
    var events = state.events;
    var now = nowTs();
    var f = focusInfo(events, now);
    var evening = eveningInfo(events, f, now);
    var key = [state.rev, f.idx, f.kind, state.editing, evening ? evening.word : ""].join("|");
    if (key === lastRenderKey && !pendingScrollToNow) return;
    lastRenderKey = key;

    var anchor = topAnchor();
    var followingNow = focusEventId != null && focusEventId === lastNowId;
    focusCard = expandedCard = null;
    var frag = document.createDocumentFragment();

    if (state.editing) {
      var add = el("button", "add-here", "＋ 新增事件");
      add.type = "button";
      add.addEventListener("click", function () { openEventForm(null); });
      frag.appendChild(add);
    }
    if (!events.length) {
      frag.appendChild(el("div", "trip-end", "還沒有任何行程。"));
      $timeline.textContent = "";
      $timeline.appendChild(frag);
      return;
    }

    var lastDay = null;
    events.forEach(function (e, i) {
      var isFocus = i === f.idx;
      var isPast = !isFocus && hasEnded(e, now);
      var dayLabel = null;
      if (e.day_key !== lastDay) { lastDay = e.day_key; dayLabel = e.day_label; }
      var cls = isFocus ? "now" : (isPast ? "past" : "future");
      var prev = events[i - 1], next = events[i + 1];
      frag.appendChild(buildCard(e, cls, f.kind, {
        prevSame: prev && prev.start_at === e.start_at && prev.tz === e.tz ? prev : null,
        nextSame: next && next.start_at === e.start_at && next.tz === e.tz ? next : null,
        evening: isFocus ? evening : null,
        endOfDay: evening && e.id === evening.prevId ? evening : null
      }, dayLabel));
    });
    if (f.kind === "done") {
      frag.appendChild(el("div", "trip-end", "行程結束了，一路平安 ❤"));
    }
    $timeline.textContent = "";
    $timeline.appendChild(frag);
    fitNotes();     // 在算捲動位置之前：它只會改到焦點卡自己的高度

    var nowId = events[f.idx] ? events[f.idx].id : null;
    if (pendingScrollToNow) { focusEventId = expandedEventId = nowId; }
    reattachState();
    setupObserver();
    if (pendingScrollToNow) {
      pendingScrollToNow = false;
      scrollToNow(false);
    } else if (followingNow) {
      // 使用者本來就停在「現在」這張上 → 時間推進時帶著他一起走
      scrollToNow(nowId !== lastNowId);
    } else if (anchor) {
      restoreAnchor(anchor);
    }
    lastNowId = nowId;
    buildRail(events, events[f.idx]);
    updateFab();
  }

  function cardById(id) {
    return id == null ? null : $timeline.querySelector('.card[data-id="' + id + '"]');
  }
  /* render() 會把整條時間軸重建，這裡把高亮／展開狀態接回新的節點上 */
  function reattachState() {
    focusCard = cardById(focusEventId);
    if (focusCard) focusCard.classList.add("focusview");
    expandedCard = cardById(expandedEventId);
    if (expandedCard) expandedCard.classList.add("settled");
  }

  function headerBottom() {
    var h = document.querySelector(".topbar");
    return h ? h.getBoundingClientRect().height : 60;
  }
  /* 錨線：焦點卡的「頂端」停在這裡，上方剛好留 PEEK 給前一張露臉。
     卡片往下展開時，這條線以上的東西完全不動 → 看起來才會順。 */
  function snapTop() { return headerBottom() + PEEK; }
  function applyScrollPadding() {
    document.documentElement.style.scrollPaddingTop = snapTop() + "px";
  }

  /* 重建時要記住「畫面停在哪」。參考點直接取目前的焦點卡 —— 它是身分，不用去掃座標；
     px 只用來記它當下的頂端在哪，重建後再把它放回同一個位置。 */
  function topAnchor() {
    if (!focusCard) return null;
    return { id: focusCard.dataset.id, top: focusCard.getBoundingClientRect().top };
  }
  function restoreAnchor(a) {
    var node = cardById(a.id);
    if (!node) return;
    window.scrollBy(0, node.getBoundingClientRect().top - a.top);
  }
  function alignCard(node, smooth) {
    if (!node) return;
    var y = window.scrollY + node.getBoundingClientRect().top - snapTop();
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
  }
  function scrollToNow(smooth) {
    alignCard($timeline.querySelector(".card.now"), smooth);
  }

  /* 「回到現在」。不能只是 scrollTo 了事 —— 那樣會和進行中的 settle／glide 互相搶，
     而且目標是用「出發前的版面」算的，抵達後 settle 一收合別張就落錯。
     這裡把順序倒過來：先把版面弄成最終狀態，再算目標。 */
  function goToNow() {
    jumpToCard($timeline.querySelector(".card.now"));
  }

  /* 通用跳轉。日期軌和「回到現在」共用同一套：先把版面弄成最終狀態、瞬間補償讓
     出發那一幀不動，再算落點平滑飛過去；飛行期間上鎖，誰都不准插手。 */
  function jumpToCard(nowCard) {
    if (!nowCard) return;

    // 進行中的 settle 一律作廢，否則它的 scrollend 會把這次跳轉吃掉
    clearTimeout(settleTimer);
    clearTimeout(jumpTimer);
    swapping = true;      // 飛行期間 IO 不准換焦點、settle 不准插隊
    jumping = true;

    /* 飛行期間把吸附關掉。proximity 對程式化捲動一樣生效，會把我們算好的落點
       改吸到附近另一個吸附點 —— 那就是「差一兩張」。抵達後才恢復，那時已經正好
       停在吸附點上，恢復是無動作的。 */
    document.documentElement.style.scrollSnapType = "none";

    /* 版面真的變成最終狀態，並瞬間補償，讓「出發前」這一幀畫面完全不動。
       展開必須是瞬間的：動畫版會讓版面在飛行途中持續長高，落點就是算了也會過時。
       這是 Rule 0 的同一條 —— 捲動進行中不改版面，包含我們自己發的平滑捲動。 */
    var ref = focusCard || nowCard;
    var refTop = ref.getBoundingClientRect().top;
    var open = $timeline.querySelectorAll(".card.settled");
    for (var i = 0; i < open.length; i++) {
      if (open[i] !== nowCard) { foldInner(open[i]); open[i].classList.remove("settled"); }
    }
    expandCard(nowCard, true);
    expandedCard = nowCard;
    var moved = ref.getBoundingClientRect().top - refTop;
    if (moved) window.scrollTo({ top: Math.max(0, window.scrollY + moved), behavior: "auto" });

    applyFocus(nowCard);            // 焦點立刻歸位 → FAB 馬上收起來，回饋是即時的
    expandedEventId = focusEventId;
    jumpTargetId = focusEventId;
    alignCard(nowCard, true);       // 版面已是最終狀態，這個落點不會再被改掉
    jumpTimer = setTimeout(endJump, 900);   // 沒有 scrollend 時的保險
  }

  function endJump() {
    if (!jumping) return;
    clearTimeout(jumpTimer);
    clearTimeout(settleTimer);
    jumping = false;
    var target = cardById(jumpTargetId);
    var tries = 0;

    /* 先把狀態釘回目標。飛行途中 IO 的回呼是排隊的，會在 swapping 一放開就補打，
       把焦點改成隔壁那張 —— 接著 settle() 就照那張鎖，於是永遠晚一張。 */
    if (target) {
      applyFocus(target);
      var open = $timeline.querySelectorAll(".card.settled");
      for (var i = 0; i < open.length; i++) {
        if (open[i] !== target) { foldInner(open[i]); open[i].classList.remove("settled"); }
      }
      expandCard(target, true);
      expandedCard = target;
      expandedEventId = focusEventId;
    }

    /* 對齊後再量一次確認；版面若還有殘留變動，最多再修兩輪，直到誤差 ≤1px。 */
    function correct() {
      if (target) alignCard(target, false);
      if (target && ++tries < 3 &&
          Math.abs(target.getBoundingClientRect().top - snapTop()) > 1) {
        requestAnimationFrame(correct);
        return;
      }
      document.documentElement.style.scrollSnapType = "";   // 已經停在吸附點上，恢復是無動作的
      updateFab();
      /* swapping 晚一點才放，讓飛行途中排隊的 IO 回呼先被擋掉；
         然後用現在的幾何重建 observer。 */
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(function () {
        swapping = false;
        setupObserver();
        scheduleSettle();   // 放開之後要有人接手，否則停在半路沒人對齊
      }, 60);
    }
    correct();
  }

  /* 誰停在錨線上，交給 IntersectionObserver 判斷 —— 捲動中每一幀零測量。
     root 上下各縮掉一大截，只留錨線附近 4px 的細帶；蓋住那條帶的就是焦點卡。 */
  var observedVH = 0, observedTop = 0;
  function setupObserver() {
    if (io) io.disconnect();
    var vh = window.innerHeight;
    var top = snapTop();
    var bottom = vh - top - 4;
    if (bottom < 0) { top = Math.max(0, vh - 8); bottom = 4; }   // 極小視窗的保險
    observedVH = vh;
    observedTop = top;
    io = new IntersectionObserver(function (entries) {
      // 正常情況只會有一張蓋到這條 4px 帶；真的多張時取最下面那張的頂端
      var pick = null;
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        if (!pick || entries[i].boundingClientRect.top > pick.boundingClientRect.top) {
          pick = entries[i];
        }
      }
      if (pick) setFocus(pick.target);
    }, { rootMargin: (-top) + "px 0px " + (-bottom) + "px 0px", threshold: 0 });
    var cards = $timeline.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) io.observe(cards[i]);
  }
  /* 手機網址列伸縮常常不發 resize — 捲動時順手比對一下高度（讀 innerHeight 不觸發 layout） */
  function reobserveIfViewportChanged() {
    /* 頁首高度也要看：它一變，snapTop() 就漂移，而 IO 的 rootMargin 是用舊值算的，
       4px 帶和對齊線就不再是同一條，IO 會報隔壁那張。 */
    if (window.innerHeight !== observedVH || snapTop() !== observedTop) {
      applyScrollPadding();
      setupObserver();
    }
  }

  /* 只換高亮 — 邊框、陰影、透明度全是繪製屬性，不會 reflow。 */
  function applyFocus(card) {
    if (!card || card === focusCard) return false;
    if (focusCard) focusCard.classList.remove("focusview");
    focusCard = card;
    focusEventId = parseInt(card.dataset.id, 10);
    card.classList.add("focusview");
    var ev = eventById(focusEventId);
    if (ev) $dayNow.textContent = ev.day_label + (ev.city ? " " + ev.city : "");
    updateFab();
    updateRail();
    return true;
  }

  function setFocus(card) {
    if (swapping || jumping || gliding) return;
    if (!applyFocus(card)) return;
    // 這裡刻意「不」展開。setFocus 只由 IntersectionObserver 觸發，也就是頁面正在動；
    // 捲動中改任何一張卡的高度，吸附座標就會在減速軌跡底下漂移 —— 甩動被截斷、
    // 停在兩張之間、日期線彈跳，全是這一件事的副作用。所有成熟實作都不做。
    // 鎖定的視覺回饋改由 .focusview 提供（透明度／邊框／陰影，純繪製，零 reflow），
    // 所以「已經停在這張了」是立刻看得到的，只有內容晚一拍到。
    scheduleSettle();
  }

  /* 捲動停下來才換「展開的是哪一張」。收合是瞬間的（.settled 一拿掉
     transition 宣告也跟著沒了），展開是動畫的；兩件事在同一幀做完，
     再把焦點卡的頂端補回原位 → 使用者看不到任何跳動。 */
  /* 展開時長隨要長出來的高度走，但走對數：線性的話短卡快到看不見、
     長卡拖到不耐煩，對數把兩端都壓回同一個節奏帶。 */
  function foldMs(card) {
    var inner = card.querySelector(".fold-in");
    var dh = inner ? inner.scrollHeight : 0;
    return Math.round(Math.min(320, Math.max(150, 140 + 55 * Math.log(1 + dh / 80))));
  }

  /* 展開。只在 settle()（＝捲動已經停住）呼叫 —— 這是唯一安全的時機：
     卡片不會再跑掉，長出來的高度全程都在錨線下方，上方一動也不動。 */
  function expandCard(card, instant) {
    if (!card || card.classList.contains("settled")) return;
    card.style.setProperty("--fold-ms", (instant ? 0 : foldMs(card)) + "ms");
    card.classList.add("settled");
  }

  /* 停下來要鎖哪一張。proximity 之下可能停在一張卡的下半部，這時該往前鎖下一張，
     而不是倒退回這張的開頭。仍然是身分導向：從目前焦點出發，只比它和下一張的頂端
     離錨線多遠 —— 正確答案只可能是這兩個之一，不必掃全部卡片。 */
  function lockTarget() {
    if (!focusCard) return null;
    var i = -1;
    for (var k = 0; k < state.events.length; k++) {
      if (state.events[k].id === focusEventId) { i = k; break; }
    }
    var line = snapTop();
    var best = focusCard, min = Math.abs(focusCard.getBoundingClientRect().top - line);
    /* 前後兩張都要比。只比下一張的話方向是單向的 —— 焦點一旦被帶到第 N+1 張，
       就永遠回不到第 N 張，表現就是「永遠晚一張，從來不會早一張」。 */
    [i > 0 ? state.events[i - 1] : null,
     i >= 0 ? state.events[i + 1] : null].forEach(function (ev) {
      var card = ev ? cardById(ev.id) : null;
      if (!card) return;
      var d = Math.abs(card.getBoundingClientRect().top - line);
      if (d < min) { min = d; best = card; }
    });
    return best;
  }

  /* 會推動版面的三件事 —— 收合別張、補償、滑進錨線 —— 才留到停下來做。

     目標是誰？直接用 focusCard，也就是 IntersectionObserver 認定壓在錨線上的那一張。
     這是身分，不是座標，不必再掃一次全部卡片去比距離。
     （曾經有個 nearestCard() 在做這件事，那是 proximity 時代的遺留 —— 當時瀏覽器
     可能停在兩張之間才需要「最近的」；改回 mandatory 之後，停下來一定是某張卡的
     頂端貼在錨線上，IO 給的就是正確答案。） */
  /* 正在讀一張比螢幕還高的卡（大字級下很常見）：錨線落在卡片裡面、卡頂已經在錨線上方一段、
     底還在錨線下方一段 → 使用者是在卡片裡面往下讀，不是停在兩張之間。這時不能把卡滑回頂端，
     也不能改選別張，否則「往下滑一點就被拉回卡頂」，下半張永遠看不到。
     卡頂離錨線不到 24px 仍然照舊滑進去對齊（那是停在兩張之間）；卡底快滑過錨線（剩 120px）也照舊，
     由下一張接手。 */
  function readingInside(card) {
    if (!card || card !== expandedCard) return false;
    var line = snapTop(), r = card.getBoundingClientRect();
    return r.height > window.innerHeight - line - 8 && r.top < line - 24 && r.bottom > line + 120;
  }
  function settle() {
    if (swapping || touching || gliding || topPending) return;
    if (readingInside(focusCard)) { document.documentElement.classList.add("reading"); return; }
    document.documentElement.classList.remove("reading");
    var focus = lockTarget();
    if (!focus) return;
    var open = $timeline.querySelectorAll(".card.settled");
    var extra = false;
    for (var i = 0; i < open.length; i++) if (open[i] !== focus) extra = true;
    var off = focus.getBoundingClientRect().top - snapTop();
    if (!extra && focus === expandedCard && Math.abs(off) <= 2) return;

    swapping = true;
    applyFocus(focus);
    var focusCard0 = focus;
    var restTop = focus.getBoundingClientRect().top;   // 使用者實際停住的位置
    for (var k = 0; k < open.length; k++) {
      if (open[k] !== focus) { foldInner(open[k]); open[k].classList.remove("settled"); }
    }
    expandCard(focusCard0);
    expandedCard = focusCard0;
    expandedEventId = focusEventId;

    /* (a) 收合別張造成的位移 —— 必須瞬間補掉，讓使用者看不見。
           目標是「這張卡維持在剛才停住的位置」，不是跳到錨線。 */
    var moved = focusCard0.getBoundingClientRect().top - restTop;
    if (moved) window.scrollTo({ top: Math.max(0, window.scrollY + moved), behavior: "auto" });

    /* (b) proximity 讓慣性跑完自己的曲線，代價是可能停在兩張之間 ——
           最後這一段平滑滑進錨線，就是「車子滑行到底再輕輕停進位子」的收尾。
           它是一個程式化的平滑捲動，會跟使用者的下一次滑動搶；能放心留著，
           是因為 touchstart 那邊會取消它（見 yieldToTouch）。 */
    if (Math.abs(restTop - snapTop()) > 2) {
      gliding = true;
      alignCard(focusCard0, true);
      clearTimeout(glideTimer);
      glideTimer = setTimeout(function () { gliding = false; swapping = false; }, 700);
    } else {
      requestAnimationFrame(function () { swapping = false; });
    }
  }
  /* 沒有 scrollend 的瀏覽器（iOS < 17.4）用這個：位置沒變才算停。
     慣性滑動與程式化的平滑捲動途中位置一直在變 → 自動重新等，
     不會在半路呼叫 scrollBy 把捲動硬生生打斷。 */
  function scheduleSettle() {
    if (swapping || jumping || gliding) return;
    clearTimeout(settleTimer);
    var y = window.scrollY;
    settleTimer = setTimeout(function () {
      // 手指還按著時位置也是穩定的 —— 那不算「停下來」，等手放開再說
      if (touching || window.scrollY !== y) { scheduleSettle(); return; }
      settle();
    }, 110);
  }

  function eventById(id) {
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === id) return state.events[i];
    }
    return null;
  }
  /* 一天一格。行前那幾天（日期不與主行程連續）併成一格，不然十月的準備事項會把
     整條軌道的比例拉爛。主行程 = 最長的連續日期段，用資料算出來，不寫死日期。 */
  function dayGroups(events) {
    var order = [], byDay = {};
    events.forEach(function (e) {
      if (!byDay[e.day_key]) { byDay[e.day_key] = e; order.push(e.day_key); }
    });
    var runStart = 0, runLen = 1, bestStart = 0, bestLen = 1;
    for (var i = 1; i < order.length; i++) {
      var prev = new Date(order[i - 1] + "T00:00:00Z").getTime();
      var cur = new Date(order[i] + "T00:00:00Z").getTime();
      if (cur - prev === 86400000) { runLen++; }
      else { runStart = i; runLen = 1; }
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
    }
    var groups = [];
    if (bestStart > 0) {
      groups.push({ key: "prep", label: "備", full: "行前準備", first: byDay[order[0]].id,
                    days: order.slice(0, bestStart) });
    }
    for (var k = bestStart; k < order.length; k++) {
      var d = order[k];
      groups.push({ key: d, label: String(parseInt(d.slice(8, 10), 10)), full: byDay[d].day_label,
                    first: byDay[d].id, days: [d],
                    newMonth: k === bestStart || d.slice(5, 7) !== order[k - 1].slice(5, 7) });
    }
    return groups;
  }

  function buildRail(events, nowEvent) {
    railRows = {};
    eventDay = {};
    $rail.textContent = "";
    if (!events.length) return;
    var groups = dayGroups(events);
    var nowKey = null;
    groups.forEach(function (g) {
      g.days.forEach(function (d) { if (nowEvent && nowEvent.day_key === d) nowKey = g.key; });
    });
    events.forEach(function (e) {
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].days.indexOf(e.day_key) >= 0) { eventDay[e.id] = groups[i].key; break; }
      }
    });
    var passed = true;
    groups.forEach(function (g) {
      var row = el("button", "rail-row" + (g.newMonth ? " newmonth" : ""));
      row.type = "button";
      row.title = g.full;
      row.setAttribute("aria-label", g.full);
      row.dataset.day = g.key;
      row.appendChild(el("span", "rail-d", g.label));
      if (g.key === nowKey) { row.classList.add("nowday"); passed = false; }
      else if (passed) row.classList.add("elapsed");
      row.addEventListener("click", function () { jumpToCard(cardById(g.first)); });
      $rail.appendChild(row);
      railRows[g.key] = row;
    });
    updateRail();
  }

  function updateRail() {
    var key = eventDay[focusEventId];
    for (var k in railRows) {
      if (railRows.hasOwnProperty(k)) railRows[k].classList.toggle("at", k === key);
    }
  }

  function updateFab() {
    var nowCard = $timeline.querySelector(".card.now");
    $fab.hidden = !nowCard || nowCard === focusCard;
  }

  function tickClock() {
    if (!state.fetchedAt) return;
    var n = nowTs();
    var f = state.events.length ? focusInfo(state.events, n) : null;
    var label = state.nowLabelBase || "";
    if (!DEBUG_NOW && state.tzOffsetSec != null) {
      // 用伺服器給的旅程時區時間再加上經過的秒數，重新格式化
      var d = new Date((n + state.tzOffsetSec) * 1000);
      label = pad(d.getUTCMonth() + 1) + "/" + pad(d.getUTCDate()) + " " +
              pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
    }
    var clockLabel = state.clockLabel;
    /* 人現在在哪裡就顯示哪裡的時間：「現在」那個行程（或空檔時，剛結束的那個）的時區不是旅程時區，
       就換成它的當地時間，標籤照樣寫明（vault 已有「當地時間為主」的決定）。 */
    if (f) {
      var at = state.events[f.kind === "next" && f.idx > 0 ? f.idx - 1 : f.idx];
      if (at && at.tz && at.tz !== state.tripTz) {
        var nm = "";
        state.tzChoices.forEach(function (c) { if (c.tz === at.tz) nm = c.label; });
        try {
          var parts = {};
          new Intl.DateTimeFormat("en-GB", { timeZone: at.tz, month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false })
            .formatToParts(new Date(n * 1000)).forEach(function (p) { parts[p.type] = p.value; });
          label = parts.month + "/" + parts.day + " " + (parts.hour === "24" ? "00" : parts.hour) + ":" + parts.minute;
          clockLabel = nm ? nm + "時間" : clockLabel;
        } catch (err) { /* 不支援就維持旅程時區 */ }
      }
    }
    /* 畫面上的資料不是這一次連線拿到的（離線開啟，或線上但這次抓失敗）→ 頂端那一行改成提示，
       家人才知道這不是即時的。同一行、同樣高度，不動頂欄的幾何。連上、更新成功後立刻換回時鐘。
       用「沒網路」陳述狀況；不用「離線」（長輩會以為是自己按到飛航模式）。 */
    $clock.classList.toggle("stale", !!state.stale);
    if (state.stale) {
      $clock.textContent = "沒網路・" + relTime(state.liveAt) + " 的資料";
      return;
    }
    $clock.textContent = (clockLabel ? clockLabel + " " : "") + label +
                         (DEBUG_NOW ? "（測試模式）" : "");
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ------------------------------------------------------------------ 資料
  /* 最後一次成功的 /api/state 存在這支手機的 localStorage：沒網路時（地鐵裡）冷啟動還看得到行程。
     只存在裝置上；401（沒解鎖／PIN 換了）一律清掉，不會拿舊資料給一個被鎖住的裝置看。
     寫入照舊要連線（沒有離線寫入佇列）。 */
  var STORE_KEY = "tc_state_v1";
  function saveState(d, t) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ t: t, d: d })); } catch (e) { /* 滿了或被擋：略過 */ }
  }
  function loadSaved() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      return s && s.d && s.d.events && s.t ? s : null;
    } catch (e) { return null; }
  }
  function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }

  /* 「昨天 21:14」：今天／昨天不寫日期（人在國外對這兩個詞最有感），前天以上才寫 12/28 21:14 */
  function relTime(ts) {
    var d = new Date(ts), n = new Date();
    var day0 = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day0(n) - day0(d)) / 86400000);
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (diff <= 0) return "今天 " + hm;
    if (diff === 1) return "昨天 " + hm;
    return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + hm;
  }

  function showLoadFail() {
    state.failShown = true;
    $timeline.textContent = "";
    var box = el("div", "loadfail");
    box.appendChild(el("div", "loadfail-msg", "現在連不上網路"));
    var b = el("button", "loadfail-btn", "再試一次");
    b.type = "button";
    b.addEventListener("click", function () {
      b.disabled = true;
      refresh(true).then(function () { if (!state.events.length) b.disabled = false; });
    });
    box.appendChild(b);
    $timeline.appendChild(box);
  }

  function applyState(d, at, stale, force) {
    if (state.failShown) { state.failShown = false; force = true; }
    state.events = d.events;
    state.rev = d.rev;
    if (d.title) document.title = d.title;
    state.nowTs = d.now_ts;
    state.fetchedAt = at;      // 用來把伺服器時鐘往前推；舊資料要從「抓到的那一刻」起算，不是從現在
    state.liveAt = at;
    state.stale = !!stale;
    state.nowLabelBase = d.now_label;
    state.clockLabel = d.clock_label || "";
    state.tzChoices = d.tz_choices || [];
    state.nightPrep = d.night_prep || [];
    state.tripTz = d.trip_tz || "";
    // 伺服器給的旅程時區牆上時間與 UTC 的差，用來在本機推進時鐘
    state.tzOffsetSec = tripTzOffset(d.now_ts, d.now_label);
    $editToggle.textContent = state.editing ? "結束編輯" : "編輯";
    $editToggle.classList.toggle("on", state.editing);
    if (force) lastRenderKey = "";
    render();
    tickClock();
  }

  function refresh(force) {
    return api("/api/state").then(function (d) {
      var at = Date.now();
      saveState(d, at);
      applyState(d, at, false, force);
    }).catch(function (err) {
      // 沒解鎖（或 100 天過期、PIN 換了）：整個網站鎖著，直到輸入 PIN；舊資料一律清掉
      if (err.status === 401) {
        clearSaved();
        state.pinLen = (err.data && err.data.pin_len) || 0;
        openPin();
        return;
      }
      console.warn("refresh failed", err);
      /* 這一次沒拿到即時資料（沒網路，或伺服器回錯）。畫面上有資料就留著、標成「不是即時的」；
         還沒有任何資料：用上次存的（離線冷啟動）；連存的都沒有才顯示「現在連不上網路」。 */
      if (state.events.length) {
        state.stale = true;
        tickClock();
      } else {
        var s = loadSaved();
        if (s) applyState(s.d, s.t, true, true);
        else showLoadFail();
      }
    });
  }
  function tripTzOffset(ts, label) {
    // label = "MM/DD HH:MM"（旅程時區的牆上時間）→ 推回 UTC 偏移秒數
    var m = /^(\d+)\/(\d+) (\d+):(\d+)$/.exec(label || "");
    if (!m) return 0;
    var utc = new Date(ts * 1000);
    var wallMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    var utcMin = utc.getUTCHours() * 60 + utc.getUTCMinutes();
    var diff = wallMin - utcMin;
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    return diff * 60;
  }

  // ------------------------------------------------------------------ 編輯
  function openModal(title) {
    $modalTitle.textContent = title;
    $modalBody.textContent = "";
    $modal.hidden = false;
    // iOS Safari 不理會 body 上的 overflow:hidden，要連 html 一起鎖
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return $modalBody;
  }
  function closeModal() {
    $modal.hidden = true;
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }
  document.getElementById("modalClose").addEventListener("click", closeModal);
  $modal.addEventListener("click", function (e) { if (e.target === $modal) closeModal(); });

  function field(label, name, value, type, opts) {
    var l = el("label", "f");
    l.appendChild(el("span", null, label));
    var input;
    if (type === "textarea") {
      input = el("textarea");
    } else if (type === "select") {
      input = el("select");
      opts.forEach(function (o) {
        var op = el("option", null, o[1]);
        op.value = o[0];
        input.appendChild(op);
      });
    } else {
      input = el("input");
      input.type = type || "text";
    }
    input.name = name;
    input.value = value || "";
    l.appendChild(input);
    return l;
  }

  function openEventForm(ev) {
    var body = openModal(ev ? "編輯事件" : "新增事件");
    var form = el("form");
    form.appendChild(field("標題 *", "title", ev && ev.title, "text"));
    form.appendChild(field("分類", "category", ev ? ev.category : "sight", "select", [
      ["transport", "🚄 交通"], ["sight", "📸 景點"], ["meal", "🍽 用餐"],
      ["hotel", "🏨 住宿"], ["prep", "📋 準備"]
    ]));
    var two = el("div", "f-two");
    // 預設今天 09:30，而不是寫死某趟旅行的日期
    var d0 = new Date(), pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var defaultStart = d0.getFullYear() + "-" + pad2(d0.getMonth() + 1) + "-" +
                       pad2(d0.getDate()) + "T09:30";
    two.appendChild(field("開始（日期時間）*", "start_at",
      ev ? ev.start_at : defaultStart, "datetime-local"));
    two.appendChild(field("結束（可留空）", "end_at", ev ? ev.end_at : "", "datetime-local"));
    form.appendChild(two);
    // 時區選項由伺服器給：旅程時區 ＋ 目前資料裡用到的時區。寫死一份會在
    // TRIPCOMPANION_TZ 改成別的地方時整個對不上。
    var tzOpts = (state.tzChoices.length ? state.tzChoices
                  : [{ tz: state.tripTz || "UTC", label: state.tripTz || "UTC" }])
      .map(function (c) { return [c.tz, c.label + "　" + c.tz]; });
    form.appendChild(field("時區", "tz", ev ? ev.tz : tzOpts[0][0], "select", tzOpts));
    form.appendChild(field("城市", "city", ev && ev.city, "text"));
    form.appendChild(field("地點（會用來開 Google 地圖）", "location", ev && ev.location, "text"));
    form.appendChild(field("訂位／訂單代號", "code", ev && ev.code, "text"));
    form.appendChild(field("⚠ 注意事項（顯示在卡片最上方）", "warning", ev && ev.warning, "textarea"));
    form.appendChild(field("出門時間（HH:MM，該行程所在時區的時間；不確定就留空）", "leave_at",
      ev && ev.leave_at, "text"));
    form.appendChild(field("怎麼去、要多久（例：地鐵 L1 約 24 分，要有「約」；沒查過就留空）", "travel_note",
      ev && ev.travel_note, "text"));
    form.appendChild(field("備註", "notes", ev && ev.notes, "textarea"));
    form.appendChild(field("💡 小提示（空一行分段；每段第一行是摘要，其餘點開才看得到）",
      "hint", ev && ev.hint, "textarea"));
    form.appendChild(field("🌙 前一晚要準備（前一天晚上的明日預告會列出）",
      "eve", ev && ev.eve, "textarea"));
    var err = el("div", "err");
    form.appendChild(err);
    var save = el("button", "btn", "儲存");
    save.type = "submit";
    form.appendChild(save);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var d = {};
      ["title", "category", "start_at", "end_at", "tz", "city", "location", "code",
       "warning", "notes", "hint", "eve", "leave_at", "travel_note"].forEach(function (k) { d[k] = form.elements[k].value; });
      save.disabled = true;
      var p = ev ? api("/api/events/" + ev.id, { method: "PUT", json: d })
                 : api("/api/events", { json: d });
      p.then(function () { closeModal(); toast("已儲存"); refresh(true); })
       .catch(function (x) { err.textContent = failMsg(x); save.disabled = false; });
    });
    body.appendChild(form);

    if (ev) body.appendChild(attachmentPanel(ev));
  }

  function attachmentPanel(ev) {
    var box = el("div");
    box.appendChild(el("div", "row-label", "票券檔案（PDF / JPG / PNG，每個 ≤10MB）"));
    var list = el("div", "files");
    ev.attachments.forEach(function (f) {
      var b = el("span", "file-btn");
      var a = el("a", null, (f.is_image ? "🖼 " : "📄 ") + f.name);
      a.href = f.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.style.color = "inherit";
      a.style.textDecoration = "none";
      b.appendChild(a);
      var x = el("button", "x", "✕");
      x.type = "button";
      x.style.background = "none";
      x.style.border = "0";
      x.addEventListener("click", function () {
        if (!confirm("刪除 " + f.name + "？")) return;
        api("/api/attachments/" + f.id, { method: "DELETE" })
          .then(function () { closeModal(); toast("附件已刪除"); refresh(true); })
          .catch(function (e2) { toast(failMsg(e2)); });
      });
      b.appendChild(x);
      list.appendChild(b);
    });
    box.appendChild(list);

    var up = el("input");
    up.type = "file";
    up.accept = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
    up.style.marginTop = ".6rem";
    up.addEventListener("change", function () {
      if (!up.files.length) return;
      var fd = new FormData();
      fd.append("file", up.files[0]);
      api("/api/events/" + ev.id + "/attachments", { method: "POST", body: fd })
        .then(function () { closeModal(); toast("票券已上傳"); refresh(true); })
        .catch(function (e2) { toast(failMsg(e2)); up.value = ""; });
    });
    box.appendChild(up);
    return box;
  }

  /* iOS 解鎖畫面式的 PIN：位數固定、按滿自動送出、錯了整排點點抖一下再清空。
     伺服器只給位數（pin_len）；PIN 不是純數字時給 0，退回下面的一般輸入框。 */
  var KEY_LETTERS = ["", "", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"];

  /* 網站鎖著時才會叫到這裡（refresh 拿到 401）。輪詢每 30 秒還會再叫一次，已經開著就別疊第二層。
     沒有「取消」：關掉只剩一片空白，沒意義。 */
  function openPin() {
    if (document.querySelector(".passcode") || !$modal.hidden) return;
    if (!state.pinLen) { openPinForm(); return; }
    var len = state.pinLen, digits = "", busy = false;
    var ov = el("div", "passcode");
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "輸入 PIN 進入編輯模式");

    var head = el("div", "pc-head");
    head.appendChild(el("div", "pc-title", "輸入 PIN"));
    var sub = el("div", "pc-sub", "解鎖後即可查看行程");
    sub.setAttribute("aria-live", "polite");
    head.appendChild(sub);
    var dots = el("div", "pc-dots");
    for (var i = 0; i < len; i++) dots.appendChild(el("span", "pc-dot"));
    head.appendChild(dots);
    ov.appendChild(head);

    var pad = el("div", "pc-pad");
    function key(n) {
      var b = el("button", "pc-key");
      b.type = "button";
      b.setAttribute("aria-label", String(n));
      b.appendChild(el("span", "pc-num", String(n)));
      b.appendChild(el("span", "pc-abc", KEY_LETTERS[n]));
      // 按下就算（iOS 也是），不等手指放開；click 只接鍵盤觸發的（detail === 0）
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        b.classList.add("down");
        press(String(n));
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach(function (t) {
        b.addEventListener(t, function () { b.classList.remove("down"); });
      });
      b.addEventListener("click", function (e) { if (e.detail === 0) press(String(n)); });
      return b;
    }
    for (var n = 1; n <= 9; n++) pad.appendChild(key(n));
    pad.appendChild(el("span"));
    pad.appendChild(key(0));
    var act = el("button", "pc-act");
    act.type = "button";
    act.addEventListener("click", back);
    pad.appendChild(act);
    ov.appendChild(pad);

    function paint() {
      for (var k = 0; k < len; k++) dots.children[k].classList.toggle("on", k < digits.length);
      act.textContent = "刪除";
      act.style.visibility = digits ? "" : "hidden";
    }
    function press(d) {
      if (busy || digits.length >= len) return;
      digits += d;
      paint();
      // 最後一顆點先亮一下再送，不然看起來像沒按到
      if (digits.length === len) { busy = true; setTimeout(submit, 120); }
    }
    function back() {
      if (busy) return;
      digits = digits.slice(0, -1);
      paint();
    }
    function submit() {
      api("/api/auth", { json: { pin: digits } })
        .then(function () {
          ov.classList.add("ok");
          setTimeout(function () { close(); toast("已解鎖"); refresh(true); }, 220);
        })
        .catch(function (x) {
          sub.textContent = x.message;
          sub.classList.add("bad");
          if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
          dots.classList.remove("shake");
          void dots.offsetWidth;          // 重播動畫
          dots.classList.add("shake");
          setTimeout(function () { digits = ""; paint(); busy = false; }, 420);
        });
    }
    function onKey(e) {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); back(); }
    }
    function close() {
      document.removeEventListener("keydown", onKey);
      ov.remove();
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    }

    paint();
    document.addEventListener("keydown", onKey);
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.appendChild(ov);
  }

  function openPinForm() {
    var body = openModal("編輯模式");
    var form = el("form");
    form.appendChild(el("div", "modal-hint", "輸入共用 PIN 解鎖；解鎖後可以查看與修改行程。"));
    var l = el("label", "f");
    l.appendChild(el("span", null, "PIN"));
    var input = el("input", "pin-input");
    input.type = "password";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.name = "pin";
    l.appendChild(input);
    form.appendChild(l);
    var err = el("div", "err");
    form.appendChild(err);
    var go = el("button", "btn", "進入編輯模式");
    go.type = "submit";
    form.appendChild(go);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      go.disabled = true;
      api("/api/auth", { json: { pin: input.value } })
        .then(function () { closeModal(); toast("已解鎖"); refresh(true); })
        .catch(function (x) { err.textContent = x.message; go.disabled = false; input.value = ""; });
    });
    body.appendChild(form);
    setTimeout(function () { input.focus(); }, 50);
  }

  // 解鎖了就能編輯；這顆只切換本機的編輯介面，免得看行程時誤觸刪除
  $editToggle.addEventListener("click", function () {
    state.editing = !state.editing;
    $editToggle.textContent = state.editing ? "結束編輯" : "編輯";
    $editToggle.classList.toggle("on", state.editing);
    lastRenderKey = "";
    render();
  });

  $fab.addEventListener("click", goToNow);

  /* 手指一碰螢幕，程式的捲動一律讓位。沒有這個，上一次跳轉還在飛的平滑捲動
     會把使用者的下一次滑動拉回舊落點 —— 就是「連續快滑時被彈回上一次的位置」。 */
  function yieldToTouch() {
    if (jumping || gliding) {
      window.scrollTo({ top: window.scrollY, behavior: "auto" });   // 取消進行中的平滑捲動
    }
    clearTimeout(jumpTimer);
    clearTimeout(glideTimer);
    clearTimeout(settleTimer);
    clearTimeout(releaseTimer);   // 跳轉的延後釋放也要作廢，否則會晚一步把 swapping 打開
    clearTimeout(topTimer);       // 回到現在的等待期間碰螢幕 → 取消
    topPending = false;
    if (jumping) document.documentElement.style.scrollSnapType = "";
    jumping = false;
    gliding = false;
    swapping = false;
  }
  window.addEventListener("touchstart", function () {
    touching = true;
    yieldToTouch();
  }, { passive: true });
  function endTouch() {
    lastTouchAt = Date.now();
    if (!touching) return;
    touching = false;
    scheduleSettle();          // 手放開才開始等「真的停下來」
  }
  /* 點螢幕頂端（iOS 的狀態列）會把頁面瞬間捲到最上面，沒有任何手指在頁面上。
     捲到頂、而且最近 2.5 秒沒有碰過螢幕、而且現在看的不是「現在」→ 靜止 TOP_WAIT（400ms）後回到現在。
     使用者自己用手指一路捲上來的（有慣性、有觸控）不算；等的這段時間內再碰螢幕就取消。 */
  var lastTouchAt = 0, topTimer = null, topPending = false;
  function checkTop() {
    if (topPending || window.scrollY > 2 || touching || jumping || Date.now() - lastTouchAt < 2500) return;
    var nowCard = $timeline.querySelector(".card.now");
    if (!nowCard || nowCard === focusCard) return;
    /* 等候期間 settle() 必須讓開 —— 否則它會在 6ms 內把畫面滑回剛才的卡（實測），回到現在就永遠不會發生。 */
    topPending = true;
    clearTimeout(settleTimer);
    topTimer = setTimeout(function () {
      topPending = false;
      if (window.scrollY <= 2 && !touching && !jumping) goToNow(); else scheduleSettle();
    }, TOP_WAIT);
  }
  window.addEventListener("touchend", endTouch, { passive: true });
  window.addEventListener("touchcancel", endTouch, { passive: true });

  if ("onscrollend" in window) {
    window.addEventListener("scrollend", function () {
      if (jumping) {
        /* 補償那一下 scrollTo(auto) 自己也會發 scrollend —— 還沒到目標就不算飛完，
           否則剩下的飛行會在無鎖狀態下進行。 */
        var tgt = cardById(jumpTargetId);
        if (tgt && Math.abs(tgt.getBoundingClientRect().top - snapTop()) > 2) return;
        endJump();
        return;
      }
      if (gliding) {                        // 滑進錨線那一段自己結束了
        clearTimeout(glideTimer);
        gliding = false;
        swapping = false;
        return;
      }
      if (touching) return;                 // 手指還在上面，這不算停下來
      clearTimeout(settleTimer);            // 別讓保險計時器再跑一次
      settle();
    });
  }
  window.addEventListener("scroll", function () {
    lastScrollAt = Date.now();
    reobserveIfViewportChanged();
    scheduleSettle();
    checkTop();
  }, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () {
      applyScrollPadding(); setupObserver(); refitSoon();
    });
  }
  window.addEventListener("orientationchange", function () {
    applyScrollPadding(); setupObserver();
  });
  window.addEventListener("resize", function () {
    applyScrollPadding();
    setupObserver();
  });
  applyScrollPadding();

  /* 跟隨系統字級（iOS 動態字型）。網頁只有用 font:-apple-system-body 才會吃到系統設定，
     寫死 px 的根字級會把「字體大小」那條滑桿整個吃掉 —— 家裡四支手機從最小到特大都有。
     做法：用一個不顯示的探針量出系統 body 字級（預設 Large = 17px），按比例換成根字級
     （17px ↔ 18px，維持原本的版面），其餘全部是 rem，會跟著長。往上長的過程中放大倍率逐漸收回 1：
     到 iOS 最大那一檔（23px）就等於系統字級，網頁的字不比使用者其他 App 的字大。回到前景、轉向時重量一次。
     不支援這個關鍵字的瀏覽器（桌機）整段略過，維持 CSS 裡的 18px。 */
  var curRoot = 0, textProbe = null;
  function syncTextSize(rerender) {
    if (!textProbe) return;
    var px = parseFloat(getComputedStyle(textProbe).fontSize);
    if (!(px > 0)) return;
    // 17px 以下維持 ×18/17；17→23px 之間把多出來的 1px 線性收掉，23px 以上就是系統字級本身
    var root = px <= 17 ? px * 18 / 17 : px + Math.max(0, (23 - px) / 6);
    root = Math.max(14, Math.min(root, 44));
    if (Math.abs(root - curRoot) < 0.1) return;
    curRoot = root;
    document.documentElement.style.fontSize = root + "px";
    if (!rerender || !state.events.length) return;
    applyScrollPadding(); setupObserver();
    lastRenderKey = "";     // 版面整個變了：重建並把焦點卡放回同一個位置，順便重算備註預覽項數
    render();
  }
  if (window.CSS && CSS.supports && CSS.supports("font", "-apple-system-body")) {
    // 探針的大小由系統字級決定；iOS 沒有「字級改變」事件，但它一變，ResizeObserver 就會叫
    textProbe = el("span");
    textProbe.setAttribute("aria-hidden", "true");
    textProbe.style.cssText = "position:absolute;left:-99px;top:0;visibility:hidden;" +
      "pointer-events:none;font:-apple-system-body;width:1em;height:1em";
    document.body.appendChild(textProbe);
    syncTextSize(false);
    if (window.ResizeObserver) new ResizeObserver(function () { syncTextSize(true); }).observe(textProbe);
  }
  window.addEventListener("pageshow", function () { syncTextSize(true); });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { syncTextSize(true); refresh(false); }
  });
  window.addEventListener("online", function () { refresh(false); });
  setInterval(function () { refresh(false); }, POLL_MS);
  setInterval(function () { render(); tickClock(); }, 15000);
  /* 離線也能打開：service worker 只快取 App 本體（見 sw.js） */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw").catch(function () { /* 不支援或被擋：照舊要連線 */ });
    });
  }

  refresh(true);
})();
