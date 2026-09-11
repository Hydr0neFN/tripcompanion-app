# tripcompanion

專為手機直式瀏覽打造的旅程時間軸，靈感源自德鐵（Deutsche Bahn）Navigator App 的 *Travel Companion*：**當前正在發生**的事件會固定展開於畫面的基準錨線上，前後相鄰的事件則在上下兩側收合；時間軸完全跟隨**旅程**時區推進，不受使用者手機本機時區干擾。

FastAPI + SQLite + vanilla JS。無需打包編譯（no build step）、不引入前端框架與打包工具（bundler）—— clone 專案、設定 PIN 碼即可直接執行。

English version: **[README.md](README.md)**

---

## 功能簡介

* **定點錨定時間軸**：固定保持一張卡片停靠在錨線（頂端導覽列 + 64 px）並維持展開。慢速滑動一次推進一張卡片；快速甩動（fling）則可連續滑行多張後平滑停靠。點擊任何已收合的卡片，即可將其滑動至錨線位置展開。
* **以旅程時區為準，不看裝置時鐘**：時間軸完全由伺服器的旅程時區時鐘驅動，在初次載入、每 30 秒輪詢以及觸發 `visibilitychange`（切換回分頁）時自動更新。即使手機本機時區未變更，依然能精準定位「當前事件」。列表任何位置皆有懸浮按鈕可一鍵「回到現在」。
* **個別事件時區支援**：每個事件儲存當地無時區時間（naive local time）與對應的 IANA 時區字串，底層一律按絕對時刻排序。即使返程連跨三個時區，順序依然分秒不差；非旅程主時區的卡片會加上醒目的時區標籤，避免出發時間被誤讀為當地時間。
* **旅途中一目了然的卡片資訊**：卡片最上方固定顯示 ⚠ 注意事項、開始／結束時間、標題、城市、可一鍵開啟 Google Maps 導航的地點名稱、放大強調顯示的訂位代碼，以及可直接開啟票券附件（PDF/JPG/PNG）的按鈕。
* **右側日期軌道（Date rail）**：右側邊緣提供一天一格的日期導覽列，以底色填滿顯示隨*時鐘推進*已走完的旅程進度、以圓點標註今天、並以高亮邊條標示當前畫面正在瀏覽的日期。點擊任一日空格即可跳轉至該日的第一個事件。
* **單一共用 PIN 碼，手機鎖定畫面風格**：網站開啟時呈現鎖定畫面的數字鍵盤；輸入一組 PIN 碼即可在該裝置上解鎖 30 天的瀏覽與編輯權限。編輯功能在解鎖後為本機切換開關 —— 可新增、編輯、刪除、調整順序與上傳票券。其他裝置會在 30 秒內同步變更，或在畫面回到前景時立即更新。

## 捲動互動機制

在修改任何程式碼之前，強烈建議先讀完這段設計原則。以下每一條規則，都是踩過無數次相反作法的坑之後總結出來的經驗。

> **Rule 0 —— 捲動進行中，任何卡片的 layout 高度絕對不可改變。**
> 這包含由程式自身發起的捲動。

在捲動過程中改變元素高度，會導致 snap 座標在減速軌跡底下漂移，瀏覽器因而無法正確預測與計算停靠位置。產生的問題會以固定的順序出現：捲動時劇烈抖動、在版面交界處彈跳，最後則是快速甩動（fling）在到達目標卡片前提前戛然而止。這並非本專案特有的限制，而是所有成熟實作都不這麼做的根本原因。無論是 DB Navigator（`RecyclerView` + `LinearSnapHelper` 子類別）、Apple Wallet（`targetContentOffset(forProposedContentOffset:withScrollingVelocity:)` + `CATransform3D`）、Apple/Google Maps 的大眾運輸步驟卡（`PagerSnapHelper`）、iOS `UIPickerView`（固定 `rowHeight` 搭配 X 軸 3D 旋轉），還是 Embla、keen-slider 與 Swiper（在靜態 snap-point 陣列上套用虛擬 transform），無一例外皆保持項目高度固定，僅對 `transform` 或 `opacity` 做動畫，並將真正的內容展開延後至捲動完全停止（scroll-end）才執行。以下所有規則皆由此衍生而來。

1. **錨線幾何尺寸必須恆定**：頁首文字設定為 `white-space: nowrap`。一旦頁首文字換行導致高度變高，錨線位置就會偏移，而使用舊數值建立的 `IntersectionObserver` 就會監聽與對齊線不同的位置 —— 兩者判定剛好會相差一張卡片。當錨線位置變動時必須重建 observer，而非只在 viewport 尺寸變更時處理。
2. **焦點判定與內容展開必須分離**：由位於錨線處 4 px 狹窄區域的 `IntersectionObserver` 來決定誰取得焦點，捲動中每幀完全零測量。`.focusview` 樣式僅變更 opacity、border 與 box-shadow —— 這些皆為純繪製（paint）屬性，絕不觸發 layout reflow。焦點卡與非焦點卡的字級大小與 margin 完全一致。**切勿在 snap target 上套用 `transform: scale`**：因為 snap 範圍計算的是經過 *transform 變換後*的 border box，進行縮放會重新引入座標漂移。
3. **僅在捲動靜止時才執行展開**：只有 `.settled` 類別才會真正展開內容，且只能由 `settle()` 函式加入。透過 `scrollend` 事件偵測靜止狀態；在不支援 `scrollend` 的瀏覽器（如 iOS < 17.4）中，則透過 110 ms 計時器反覆確認捲動位置停止改變**且**無手指按壓（手指停留不動時位置也是靜止的）。在慣性滑行期間絕不能呼叫 `scrollTo` 或 `scrollBy`，否則 WebKit 會直接硬生生中斷慣性。
4. **在同一幀中補償卡片替換造成的位移**：離場卡片瞬間收合（移除 `.settled` 同時移除 transition 動畫宣告），進場卡片以動畫展開，並在同一幀內瞬間補償焦點卡頂端的位移，使用者在畫面上完全看不到任何跳動。`.timeline` 容器設定了 `padding-top: 50dvh`，確保列表最頂端仍有足夠空間完成此項補償。
5. **Snap 模式採用 `proximity` 而非 `mandatory`**：`mandatory` 強制要求停止位置必須嚴格貼齊 snap point，在每隔數百像素就有一個吸附點的情況下，手指一鬆開瀏覽器就會強行修正甩動目標，導致慣性完全無法發揮。`proximity` 允許甩動按照自身動量曲線自然滑行；其代價是可能停在兩張卡片之間。
6. **透過 `settle()` 平滑滑入錨線**：這是解決第 5 點代價的補償機制。`lockTarget()` 僅比對當前焦點與其前後相鄰卡片的距離來決定鎖定對象；正確答案必定是其中之一，完全無需遍歷整個列表。
7. **觸控手勢永遠具最高優先權（Touch always wins）**：`touchstart` 會立刻中斷所有進行中的程式化平滑捲動並清除所有鎖定狀態；當手指按在螢幕上時，`settle()` 絕對不執行。若無此機制，第 *n* 次滑動結束後的平滑滑入動作會在使用者發起第 *n+1* 次滑動時把畫面拉回，導致無法累積慣性動量，甚至強制彈回上一次停靠的位置。**規則 5、6、7 為不可分割的三位一體機制 —— 必須同時保留或全部捨棄**。沒有觸控讓位的平滑滑入會與使用者手勢衝突；沒有平滑滑入則必須退回 `mandatory`，而這將扼殺甩動慣性。
8. **程式化平滑捲動同樣屬於「進行中的捲動」**：所有跳轉操作（如「回到現在」、日期軌道點擊）皆共用同一個路徑，且需要五道防護措施 —— 每一道分別解決同一個症狀的不同根因（*落地時永遠晚了一張卡片，絕不提早*）：
   * 在飛行期間停用吸附（暫時設定 `scroll-snap-type: none`，抵達後或使用者中斷時再復原）—— 避免 `proximity` 對程式化捲動生效並重新吸附到錯誤目標；
   * **瞬間**展開目標卡片，若使用展開動畫，飛行途中高度持續變化會讓 t=0 時計算的目標落點瞬間過時；
   * 結束跳轉前必須驗證是否真正抵達目標 —— 因為前幾行執行的補償 `scrollTo({behavior:"auto"})` 會觸發其*自身*的 `scrollend` 事件，若不驗證會導致跳轉在剛起飛時就被判定結束；
   * 抵達時重新將狀態釘回目標，並延後釋放鎖定狀態，防止飛行途中排隊累積的 `IntersectionObserver` callback 在解鎖瞬間執行而將焦點覆蓋為鄰近卡片；
   * 將相鄰卡片的比對設計為**對稱比對**。若僅向前比對，會導致單向累積誤差：焦點一旦被推到第 N+1 張就永遠無法退回第 N 張。單向誤差正是上游狀態受污染的典型特徵，而非純粹計算微幅誤差。
9. **日期標籤必須置於卡片內部**（`.day-tag`）：若使用獨立的日期分隔元素，會在時間軸上留下約 76 px 無 snap target 的空白間隙，這正是日期交界處彈跳問題的源頭。同樣地，新增事件按鈕 `.add-here` 也必須宣告 `scroll-snap-align`。
10. **卡片展開動畫時長隨內容高度呈對數增長**：公式為 `140 + 55·ln(1 + Δh/80)`，並限制在 150–320 ms 區間。線性比例會導致短卡片一閃而過、長卡片拖沓遲鈍；對數曲線能將長短兩端拉進和諧一致的節奏。內容本體則在固定的 180 ms 內漸層淡入（fade-in）—— 只有*展開時長*隨高度動態調整。

已接受的權衡取捨：在 `proximity` 模式下，「慢速滑動一下 = 推進恰好一張卡片」是結合瀏覽器啟發式（heuristic）慣性判斷與滑入對齊的行為，而非嚴格保證。本專案選擇了滑順的慣性甩動體驗而非絕對保證；若要強行鎖定單張推進則會失去慣性，兩者在機制上互斥。

尚未實作但值得考慮的未來方向：CSS scroll-driven animations（`animation-timeline: view()`）可將焦點高亮完全交由 compositor 處理以取代 observer；而 CSS Scroll Snap 2 的 `scrollsnapchange` / `scrollsnapchanging` 事件則可取代靜止偵測機制。但這兩者皆需在目標 iOS 版本上實機測試驗證，切勿僅依賴瀏覽器支援度相容表。

---

## 執行方式

```bash
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt      # Windows: .venv/Scripts/python

.venv/bin/python selfcheck.py                            # 必須輸出 SELFCHECK: PASS
TRIPCOMPANION_PIN=1234 .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8101 --reload
```

在瀏覽器開啟 <http://127.0.0.1:8101/>。

### 設定環境變數

全部透過環境變數配置 —— 原始碼中完全不寫死任何特定旅程的資料。

| 環境變數 | 預設值 | 說明 |
|---|---|---|
| `TRIPCOMPANION_PIN` | **無預設值 —— 未設定或仍為範本值 `CHANGEME` 時程式拒絕啟動** | 共用 PIN 碼 —— 同時解鎖瀏覽與編輯權限。純數字（4–8 碼）會顯示數字鍵盤，其他格式則顯示文字輸入框。變更 PIN 碼會將所有裝置強制登出。 |
| `TRIPCOMPANION_TITLE` | `旅程夥伴` | 顯示於頂端導覽列與瀏覽器分頁標題的旅程名稱 |
| `TRIPCOMPANION_TZ` | `Europe/Madrid` | 旅程時區；整條時間軸固定以此時區為基準。支援任何 IANA 時區 —— 編輯器的時區選單會由此時區加上資料中已用到的時區組合而成，頁首時鐘標籤亦會由此時區動態產生。 |

### 模擬時間測試（時光旅行）

在任何 URL 後方加上 `?debug_now=<ISO>`，伺服器與前端客戶端就會將該時間視為當前時刻（若未帶時區 offset 則預設為旅程時區）。這樣即可在出發前完整測試時間軸的推進邏輯與各階段狀態：

```
/?debug_now=2027-06-11T11:40      # 火車行駛途中
/?debug_now=2027-06-16T11:30      # 店家打烊前採買
/?debug_now=2027-06-19T14:30      # 不同時區的轉機行程
```

### 替換成自己的行程

`app/seed.py` 內建了橫跨 19 天與 3 個時區、共 58 筆事件的**虛構示範行程**，日期刻意設定在遠離任何真實旅行的時間點。若要換成自己的行程，有兩種方式：

1. 直接修改 `app/seed.py`；或
2. 在同目錄下新增 `app/seed_local.py`，提供相同的 `EVENTS` 列表結構與 `seed()` 函式。若該檔案存在，系統會**優先使用**它；且該檔已被加入 **.gitignore** —— 此命名的設計目的正是為了避免真實的預訂資料被 commit 進版本控制。

`sample-itinerary.html` 展示了資料來源的格式以及各欄位如何對應。資料庫檔案位於 `data/tripcompanion.db`，且僅在 events 資料表完全為空時才會自動寫入種子資料；若要重新匯入種子資料，只需刪除 `data/` 目錄即可。

`selfcheck.py` 用於驗證資料的**通用不變量（generic invariants）** —— 包含絕對時間單調遞增、跨時區接點無倒退、事件分類與時區合法、涵蓋主行程的每一天、無不合理超長事件等 —— 因此在更換行程內容後依然能持續運作。此腳本刻意只引用 `app/schema.py` 而非 `app/main.py`，驗證資料時無需載入完整的 web 框架與相關依賴。

---

## 部署方式

```bash
tar -czf app.tar.gz app requirements.txt selfcheck.py README.md README.zh-TW.md deploy
scp app.tar.gz your-host:/root/tripcompanion/
ssh your-host 'cd /root/tripcompanion && tar -xzf app.tar.gz && rm app.tar.gz \
  && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt'
ssh your-host 'cp /root/tripcompanion/deploy/tripcompanion.service /etc/systemd/system/ \
  && systemctl daemon-reload && systemctl enable --now tripcompanion'
```

部署前請先編輯 unit 檔案 —— 該檔案預設包含 `TRIPCOMPANION_PIN=CHANGEME`，程式在啟動時會直接拒絕此範本值，因此在設定真實 PIN 碼之前服務將無法啟動。服務會綁定於 `127.0.0.1:8101` 並啟用 `--proxy-headers --forwarded-allow-ips 127.0.0.1`，因此僅能透過前端的反向代理（reverse proxy）存取。**請務必只執行單一 worker** —— session 與速率限制計數器皆保存在 process 記憶體中，若設定 `--workers 2` 將導致兩者狀態不同步。`data/` 目錄未包含在 tar 壓縮檔中，因此重新部署絕對不會覆蓋既有的行程資料與已上傳的票券附件。

### 對外公開服務

本專案程式碼不會去修改任何通道（Tunnel）或防火牆設定。若搭配 Cloudflare Tunnel，只需新增一個指向 `127.0.0.1:8101` 的公開 hostname 即可。

> **行程 API 需要 PIN 碼；票券檔案則為權限識別網址（capability URLs）。** 在裝置解鎖前，`/api/state` 會回應 401，且頁面標題在此之前保持為通用標題。`/files/<random>` **並未**綁定 cookie 驗證 —— iOS 主畫面應用程式（home-screen apps）可能會在未共享其 cookie 的瀏覽器環境中開啟連結 —— 因此檔案網址一旦被取得，任何持有該網址的人皆可開啟。在對外公開前，若要上傳護照掃描檔或簽證等文件，請務必在 hostname 前端配置存取控制政策（Access Policy）。

Session cookie 格式為 `<expiry>.<HMAC>`，以隨機產生的 `data/session.key` 結合 PIN 碼作為密鑰：服務重啟與重新部署後依然有效，且一旦變更 PIN 碼就會立即使所有裝置的 session 同步失效。共用 PIN 碼在設計上採用簡短的數字形式，並非設計用來單獨面對公開網路；請將存取控制政策視為真正的安全邊界。速率限制（Rate limiting）採用 10 分鐘滑動視窗：單一 IP 上限 10 次失敗，並設有較高（400 次）的全局總量防護門檻，刻意避免單一攻擊者耗盡共用計數器而導致所有編輯者被鎖定在外。

## 專案結構

```
app/main.py        FastAPI：/api/state、事件 CRUD、PIN 驗證、檔案上傳、/files/<random>
app/schema.py      事件分類與時區輔助函式，與 selfcheck 共用
app/db.py          SQLite schema（events / attachments / meta）
app/seed.py        虛構的示範行程；app/seed_local.py 存在時優先使用
app/static/app.js  錨線對齊邏輯、渲染、輪詢、編輯 UI
app/static/app.css 深色模式、大字級排版樣式
app/templates/index.html
selfcheck.py       針對種子資料的通用不變量自我檢查
deploy/tripcompanion.service
```

## 授權條款

MIT — 詳見 [LICENSE](LICENSE)。
