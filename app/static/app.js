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

  var state = { events: [], rev: -1, editing: false, nowTs: 0, fetchedAt: 0,
                clockLabel: "", tzChoices: [], tripTz: "" };
  var PEEK = 64;                // 焦點卡上方留給前一張露臉的高度（px）
  var focusEventId = null;      // 停在錨線上的那張 — 只換高亮，不動版面
  var expandedEventId = null;   // 真正展開內容的那張 — 只在捲動停止時才換
  var focusCard = null, expandedCard = null;
  var io = null, settleTimer = null;
  var swapping = false;         // settle() 進行中：擋掉自己造成的回呼
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
  function buildCard(e, cls, focusKind, neighbours, dayLabel) {
    var cat = CAT[e.category] || CAT.sight;
    var card = el("article", "card " + cls);
    card.dataset.id = e.id;
    card.style.setProperty("--cat", "var(--" + (CAT[e.category] ? e.category : "sight") + ")");

    // 日期標籤放在卡片「裡面」。獨立的分隔元素會在時間軸上留下一段沒有吸附點的
    // 空隙，mandatory 吸附在那裡判定容易翻面，正是日期線附近彈跳的來源。
    if (dayLabel) card.appendChild(el("div", "day-tag", dayLabel));

    var head = el("button", "card-head");
    head.type = "button";
    head.appendChild(el("div", "cat-icon", cat.icon));

    var ht = el("div", "head-text");
    if (cls.indexOf("now") >= 0) {
      ht.appendChild(el("div", "now-badge",
        focusKind === "now" ? "現在" : focusKind === "next" ? "即將開始" : "行程結束"));
    }
    var t = el("div", "card-time");
    t.appendChild(el("span", null, e.time_label));
    if (e.tz_label) t.appendChild(el("span", "tz-tag", e.tz_label));
    if (e.warning) t.appendChild(el("span", "tz-tag warn-chip", "⚠ 注意"));
    ht.appendChild(t);
    ht.appendChild(el("div", "card-title", e.title));
    if (e.city) ht.appendChild(el("div", "card-city", cat.label + "・" + e.city));
    head.appendChild(ht);
    head.appendChild(el("div", "chev", "▾"));
    head.addEventListener("click", function () {
      alignCard(card, true);    // 點哪張就把哪張滑到錨線上展開
    });
    card.appendChild(head);

    // fold / fold-in：唯一會改到高度的地方，用 grid 0fr→1fr 做動畫
    var fold = el("div", "fold"), foldIn = el("div", "fold-in");
    fold.appendChild(foldIn);
    if (e.warning) {
      var w = el("div", "warn");
      w.appendChild(el("span", "warn-ico", "⚠"));
      w.appendChild(el("span", null, e.warning));
      foldIn.appendChild(w);
    }

    var body = el("div", "card-body");
    if (e.location) {
      var r = el("div", "row");
      r.appendChild(el("div", "row-label", "地點"));
      var a = el("a", "maplink");
      a.href = mapsUrl(e.location);
      a.target = "_blank";
      a.rel = "noopener";
      a.appendChild(el("span", null, "📍"));
      a.appendChild(el("span", null, e.location));
      a.appendChild(el("span", "arrow", "在地圖開啟 ›"));
      r.appendChild(a);
      body.appendChild(r);
    }
    if (e.code) {
      var rc = el("div", "row");
      rc.appendChild(el("div", "row-label", "訂位／訂單代碼"));
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
    if (e.notes) {
      var rn = el("div", "row");
      rn.appendChild(el("div", "row-label", "備註"));
      rn.appendChild(el("div", "notes", e.notes));
      body.appendChild(rn);
    }
    if (state.editing) body.appendChild(adminRow(e, neighbours));
    foldIn.appendChild(body);
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
        .catch(function (err) { toast(err.message); });
    });
    row.appendChild(del);
    return row;
  }

  function setOrder(firstId, secondId) {   // firstId 會排在 secondId 前面
    api("/api/events/reorder", { json: { ids: [firstId, secondId] } })
      .then(function () { refresh(true); })
      .catch(function (err) { toast(err.message); });
  }

  function render() {
    var events = state.events;
    var now = nowTs();
    var f = focusInfo(events, now);
    var key = [state.rev, f.idx, f.kind, state.editing].join("|");
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
        nextSame: next && next.start_at === e.start_at && next.tz === e.tz ? next : null
      }, dayLabel));
    });
    if (f.kind === "done") {
      frag.appendChild(el("div", "trip-end", "行程結束了，一路平安 ❤"));
    }
    $timeline.textContent = "";
    $timeline.appendChild(frag);

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
      if (open[i] !== nowCard) open[i].classList.remove("settled");
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
        if (open[i] !== target) open[i].classList.remove("settled");
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
    if (ev) $dayNow.textContent = ev.day_label + (ev.city ? "　" + ev.city : "");
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
  function settle() {
    if (swapping || touching || gliding) return;
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
      if (open[k] !== focus) open[k].classList.remove("settled");
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
    $clock.textContent = (state.clockLabel ? state.clockLabel + " " : "") + label +
                         (DEBUG_NOW ? "（測試模式）" : "");
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // ------------------------------------------------------------------ 資料
  function refresh(force) {
    return api("/api/state").then(function (d) {
      state.events = d.events;
      state.rev = d.rev;
      if (d.title) document.title = d.title;
      state.nowTs = d.now_ts;
      state.fetchedAt = Date.now();
      state.nowLabelBase = d.now_label;
      state.clockLabel = d.clock_label || "";
      state.tzChoices = d.tz_choices || [];
      state.tripTz = d.trip_tz || "";
      // 伺服器給的旅程時區牆上時間與 UTC 的差，用來在本機推進時鐘
      state.tzOffsetSec = tripTzOffset(d.now_ts, d.now_label);
      $editToggle.textContent = state.editing ? "結束編輯" : "編輯";
      $editToggle.classList.toggle("on", state.editing);
      if (force) lastRenderKey = "";
      render();
      tickClock();
    }).catch(function (err) {
      // 沒解鎖（或 30 天過期、PIN 換了）：整個網站鎖著，直到輸入 PIN
      if (err.status === 401) {
        state.pinLen = (err.data && err.data.pin_len) || 0;
        openPin();
        return;
      }
      console.warn("refresh failed", err);
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
    form.appendChild(field("訂位／訂單代碼", "code", ev && ev.code, "text"));
    form.appendChild(field("⚠ 注意事項（顯示在卡片最上方）", "warning", ev && ev.warning, "textarea"));
    form.appendChild(field("備註", "notes", ev && ev.notes, "textarea"));
    var err = el("div", "err");
    form.appendChild(err);
    var save = el("button", "btn", "儲存");
    save.type = "submit";
    form.appendChild(save);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var d = {};
      ["title", "category", "start_at", "end_at", "tz", "city", "location", "code",
       "warning", "notes"].forEach(function (k) { d[k] = form.elements[k].value; });
      save.disabled = true;
      var p = ev ? api("/api/events/" + ev.id, { method: "PUT", json: d })
                 : api("/api/events", { json: d });
      p.then(function () { closeModal(); toast("已儲存"); refresh(true); })
       .catch(function (x) { err.textContent = x.message; save.disabled = false; });
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
          .catch(function (e2) { toast(e2.message); });
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
        .catch(function (e2) { toast(e2.message); up.value = ""; });
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
    form.appendChild(el("div", "hint", "輸入共用 PIN 解鎖；解鎖後可以查看與修改行程。"));
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
    if (!touching) return;
    touching = false;
    scheduleSettle();          // 手放開才開始等「真的停下來」
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
    reobserveIfViewportChanged();
    scheduleSettle();
  }, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () {
      applyScrollPadding(); setupObserver();
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

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh(false);
  });
  setInterval(function () { refresh(false); }, POLL_MS);
  setInterval(function () { render(); tickClock(); }, 15000);

  refresh(true);
})();
