# -*- coding: utf-8 -*-
"""示範用的種子行程 —— 完全虛構。

這是給第一次跑起來的人看的範例資料，不是任何人的真實行程：飯店名、航班號、
訂位代碼都是編的，也刻意不含旅伴組成、造價、座位號這類個人資訊。

想放自己的行程，兩種做法：
  1. 直接改這個檔；或
  2. 建一個 `app/seed_local.py`（同樣的 EVENTS 格式與 seed 函式）——
     它存在的話 main.py 會優先用它，而且已經在 .gitignore 裡，
     真實訂房與訂位代碼不會被 commit 進去。

一列 = 一個事件：
    (start, end, tz, category, city, title, location, code, warning, notes)

start / end   'YYYY-MM-DDTHH:MM'，該時區的當地時間（end 可為 None）
tz            任何 IANA 時區字串（app/schema.py 的 valid_tz 驗證）
category      transport / sight / meal / hotel / prep
location      直接丟給 Google 地圖搜尋，寫官方英文名命中率最高
code          訂位代碼，卡片上放大顯示
warning       ⚠ 注意事項，顯示在卡片最上方
notes         其他細節

沒寫時間的行程用這個慣例估：早上 09:30／午餐 13:30／下午 15:00／晚餐 20:30。
改完一定要跑 `python selfcheck.py`。
"""

MAD = "Europe/Madrid"
IST = "Europe/Istanbul"
TPE = "Asia/Taipei"

PICKPOCKET = "扒手重災區：手機錢包放身前，護照鎖飯店只帶影本。"
DINNER_TIP = "西班牙晚餐 21:00 起才是常態；想早點吃就挑 20:00–20:30 第一輪入座，好訂也不擠。"

# (start, end, tz, category, city, title, location, code, warning, notes)
EVENTS = [
    # ---------------------------------------------------------- 行前準備
    ("2027-10-15T10:00", None, MAD, "prep", "行前", "近郊火車票開賣（可買了）", "", "",
     "區間快車只提前約 2 個月開賣 — 現在查「無班次」是正常的。",
     "renfe.com 買來回票。官網擋海外卡就改 Trainline，或到當地在售票機買。"),
    ("2027-11-20T10:00", None, MAD, "prep", "行前", "辦轉機國簽證 + 查 ETIAS", "", "",
     "只用官方網站，仿冒站很多。護照效期需逾六個月。",
     "轉機時若要出關觀光就需要簽證。\nETIAS 預計 2026 年底啟用，出發前一個月務必再查一次是否已強制。"),
    ("2027-12-19T20:00", None, MAD, "prep", "行前", "行前打包確認", "", "",
     "簽證列印＋手機存檔；歐盟 EES 生物辨識已全面實施，首次入境要按指紋＋拍照。",
     "馬德里 12 月 0–10°C。帽子、圍巾、發熱衣、好走的鞋、行動電源。"),

    # ---------------------------------------------------------- 12/20 馬德里
    ("2027-12-20T10:25", None, MAD, "transport", "馬德里", "抵達馬德里",
     "Adolfo Suárez Madrid–Barajas Airport", "XX1234",
     "入境採 EES 指紋與臉部辨識，隊伍較長，別急。", "行李提領後搭車進市區。"),
    ("2027-12-20T13:00", None, MAD, "hotel", "馬德里", "Hotel Example Centro 入住（12/20–12/26）",
     "Puerta del Sol, Madrid", "", "", "示範資料；換成你自己的訂房。"),
    ("2027-12-20T18:00", "2027-12-20T20:00", MAD, "sight", "馬德里", "太陽門廣場、馬約爾廣場散步",
     "Puerta del Sol, Madrid", "", PICKPOCKET, "第一晚輕鬆走，不趕行程。"),
    ("2027-12-20T20:30", None, MAD, "meal", "馬德里", "晚餐", "Plaza Mayor, Madrid", "", "", DINNER_TIP),

    # ---------------------------------------------------------- 12/21
    ("2027-12-21T09:30", "2027-12-21T11:30", MAD, "sight", "馬德里", "馬德里王宮",
     "Palacio Real de Madrid", "",
     "先買票：entradas.patrimonionacional.es。12/24、12/31 縮時，12/25、1/1 閉館。", ""),
    ("2027-12-21T13:30", None, MAD, "meal", "馬德里", "聖米格爾市場午餐",
     "Mercado de San Miguel, Madrid", "", PICKPOCKET, ""),
    ("2027-12-21T20:30", None, MAD, "meal", "馬德里", "Tapas 晚餐＋聖誕燈飾散步",
     "Gran Vía, Madrid", "", "", DINNER_TIP),

    # ---------------------------------------------------------- 12/22 一日遊
    ("2027-12-22T09:00", "2027-12-22T09:35", MAD, "transport", "馬德里 → 托雷多",
     "區間快車前往托雷多（約 33 分鐘）", "Madrid Atocha Station", "",
     "托雷多大教堂全年只休 12/25 與 1/1 — 排行程時注意。", ""),
    ("2027-12-22T10:00", "2027-12-22T11:30", MAD, "sight", "托雷多", "托雷多大教堂",
     "Catedral Primada de Toledo", "", "", "線上先買免排隊。"),
    ("2027-12-22T13:30", None, MAD, "meal", "托雷多", "午餐", "Plaza de Zocodover, Toledo", "", "", ""),
    ("2027-12-22T15:00", None, MAD, "sight", "托雷多", "觀景點（Mirador del Valle）",
     "Mirador del Valle, Toledo", "", "", "俯瞰全城最經典的角度。"),
    ("2027-12-22T17:30", "2027-12-22T18:05", MAD, "transport", "托雷多 → 馬德里",
     "區間快車回馬德里", "Toledo Train Station", "", "", ""),

    # ---------------------------------------------------------- 12/23
    ("2027-12-23T09:30", "2027-12-23T12:30", MAD, "sight", "馬德里", "普拉多博物館",
     "Museo Nacional del Prado", "", "先買票：entradas.museodelprado.es。", ""),
    ("2027-12-23T15:00", None, MAD, "sight", "馬德里", "麗池公園、水晶宮",
     "Palacio de Cristal, Parque del Retiro, Madrid", "", "", "冬季天黑早，17:00 前看完比較舒服。"),
    ("2027-12-23T20:30", None, MAD, "sight", "馬德里", "佛朗明哥表演",
     "Cardamomo Tablao Flamenco, Madrid", "", "先訂位，別拖太晚。", "官網線上訂。"),

    # ---------------------------------------------------------- 12/24 平安夜
    ("2027-12-24T10:00", None, MAD, "sight", "馬德里", "購物、咖啡、市中心散步",
     "Gran Vía, Madrid", "",
     "12/24 下午商店陸續打烊；博物館今天縮時。想買的東西上午買完。", ""),
    ("2027-12-24T20:00", None, MAD, "meal", "馬德里", "平安夜晚餐",
     "Plaza Mayor, Madrid", "",
     "務必預約！許多餐廳當晚只做提早場或套餐制。", ""),

    # ---------------------------------------------------------- 12/25 聖誕節
    ("2027-12-25T10:00", None, MAD, "sight", "馬德里", "西班牙廣場",
     "Plaza de España, Madrid", "",
     "聖誕節博物館與多數商店休息 — 今天全排不用門票的戶外行程。", ""),
    ("2027-12-25T16:00", "2027-12-25T17:30", MAD, "sight", "馬德里", "德波神廟看夕陽",
     "Templo de Debod, Madrid", "", "", "冬季約 17:50 日落。"),
    ("2027-12-25T20:30", None, MAD, "meal", "馬德里", "晚餐", "Chueca, Madrid", "",
     "今天餐廳開的少，看到有開先吃，別等。", ""),

    # ---------------------------------------------------------- 12/26 移動日
    ("2027-12-26T10:15", "2027-12-26T11:00", MAD, "prep", "馬德里", "退房 → 車站",
     "Madrid Atocha Station", "", "抓 45 分鐘到車站。人多加行李叫大車。", ""),
    ("2027-12-26T11:22", "2027-12-26T12:57", MAD, "transport", "馬德里 → 薩拉戈薩",
     "高鐵 馬德里 Atocha → 薩拉戈薩 Delicias", "Madrid Atocha Station", "ABC123",
     "有明確班次的行程一定要填真實時間，不要用估的 —— 時間軸就靠它推進。", ""),
    ("2027-12-26T13:15", None, MAD, "hotel", "薩拉戈薩", "Hotel Example Pilar 入住（12/26–12/28）",
     "Plaza del Pilar, Zaragoza", "", "", "示範資料。"),
    ("2027-12-26T15:30", None, MAD, "sight", "薩拉戈薩", "皮拉爾聖母聖殿、La Seo、Ebro 河畔",
     "Basílica del Pilar, Zaragoza", "",
     "薩拉戈薩有 cierzo 強風，體感比氣溫更冷 — 帽子圍巾帶著。", ""),
    ("2027-12-26T20:30", None, MAD, "meal", "薩拉戈薩", "老城 Tapas", "Calle Alfonso I, Zaragoza", "", "", ""),

    # ---------------------------------------------------------- 12/27
    ("2027-12-27T09:30", "2027-12-27T11:30", MAD, "sight", "薩拉戈薩", "阿爾哈費里亞宮",
     "Palacio de la Aljafería, Zaragoza", "", "先買票；假期開放時間先確認。", ""),
    ("2027-12-27T15:00", None, MAD, "sight", "薩拉戈薩", "羅馬遺跡、中央市場、老城區",
     "Mercado Central de Zaragoza", "", "", ""),
    ("2027-12-27T20:30", None, MAD, "meal", "薩拉戈薩", "阿拉貢料理晚餐",
     "Calle Alfonso I, Zaragoza", "", "", ""),

    # ---------------------------------------------------------- 12/28 移動日
    ("2027-12-28T10:15", "2027-12-28T10:45", MAD, "prep", "薩拉戈薩", "退房 → 車站",
     "Zaragoza Delicias Station", "", "", ""),
    ("2027-12-28T10:58", "2027-12-28T12:39", MAD, "transport", "薩拉戈薩 → 巴塞隆納",
     "高鐵 薩拉戈薩 Delicias → Barcelona Sants", "Zaragoza Delicias Station", "DEF456", "", ""),
    ("2027-12-28T13:15", "2027-12-28T15:00", MAD, "hotel", "巴塞隆納",
     "Hotel Example Eixample 寄放行李 → 15:00 入住（12/28–1/2）",
     "Eixample, Barcelona", "", "入住時間 15:00，早到只能寄放行李。", "示範資料。"),
    ("2027-12-28T15:30", None, MAD, "sight", "巴塞隆納", "加泰隆尼亞廣場、蘭布拉大道、哥德區",
     "Plaça de Catalunya, Barcelona", "",
     "蘭布拉大道是全巴塞扒手最兇的一段。" + PICKPOCKET, ""),

    # ---------------------------------------------------------- 12/29
    ("2027-12-29T09:00", "2027-12-29T11:00", MAD, "sight", "巴塞隆納", "聖家堂",
     "Sagrada Família, Barcelona", "",
     "最搶手，開賣即訂（只買官網、選時段票）。周邊也是扒手重災區。", "冬季 9:00–18:00。"),
    ("2027-12-29T15:00", "2027-12-29T16:00", MAD, "sight", "巴塞隆納", "聖保羅醫院",
     "Recinte Modernista de Sant Pau, Barcelona", "", "", "就在聖家堂走路 10 分鐘。"),
    ("2027-12-29T16:15", "2027-12-29T17:30", MAD, "sight", "巴塞隆納", "桂爾公園",
     "Park Güell, Barcelona", "",
     "冬季只開到 17:30，別排太晚 — 買下午早段的時段票。", ""),

    # ---------------------------------------------------------- 12/30
    ("2027-12-30T09:30", "2027-12-30T11:00", MAD, "sight", "巴塞隆納", "巴特婁之家",
     "Casa Batlló, Barcelona", "", "先買票，官網常有早鳥價。", ""),
    ("2027-12-30T11:30", "2027-12-30T13:00", MAD, "sight", "巴塞隆納", "米拉之家（La Pedrera）",
     "Casa Milà La Pedrera, Barcelona", "", "", "與巴特婁之家走路 5 分鐘。"),
    ("2027-12-30T15:00", None, MAD, "sight", "巴塞隆納", "Passeig de Gràcia、格拉西亞區",
     "Gràcia, Barcelona", "", "", ""),

    # ---------------------------------------------------------- 12/31 跨年
    ("2027-12-31T09:30", "2027-12-31T11:00", MAD, "sight", "巴塞隆納", "蒙特惠奇山",
     "Montjuïc, Barcelona", "", "", "纜車上去視野最好。"),
    ("2027-12-31T11:00", "2027-12-31T12:00", MAD, "prep", "巴塞隆納", "超市買齊 1/1 的食材",
     "Eixample, Barcelona", "",
     "中午前一定要買完！12/31 超市提早關、1/1 全城關門。",
     "順手買 12 顆葡萄（超市有跨年小包裝，鐘響一聲吃一顆）。"),
    ("2027-12-31T20:30", None, MAD, "meal", "巴塞隆納", "跨年晚餐",
     "Barceloneta, Barcelona", "", "套餐制，早訂！", ""),
    ("2027-12-31T23:00", "2028-01-01T00:30", MAD, "sight", "巴塞隆納", "跨年倒數・魔法噴泉",
     "Font Màgica de Montjuïc, Barcelona", "",
     "23:00 起人潮爆滿，早點卡位。地鐵整夜行駛。", ""),

    # ---------------------------------------------------------- 1/1
    ("2028-01-01T10:00", None, MAD, "meal", "巴塞隆納", "悠閒早餐（睡晚一點）",
     "Eixample, Barcelona", "", "", "元旦全城安靜，不用趕。"),
    ("2028-01-01T11:30", None, MAD, "sight", "巴塞隆納", "哥德區或海邊散步",
     "Barri Gòtic, Barcelona", "", "1/1 幾乎全城關門 — 今天只排戶外散步。", ""),
    ("2028-01-01T20:00", None, MAD, "meal", "巴塞隆納", "住處自炊晚餐",
     "Eixample, Barcelona", "", "食材 12/31 已備齊。", ""),

    # ---------------------------------------------------------- 1/2
    ("2028-01-02T10:00", None, MAD, "prep", "巴塞隆納", "退房、寄放行李",
     "Eixample, Barcelona", "", "", ""),
    ("2028-01-02T11:00", None, MAD, "sight", "巴塞隆納", "最後購物（冬季折扣季開跑）、市場",
     "La Boqueria, Barcelona", "", PICKPOCKET, ""),
    ("2028-01-02T18:30", None, MAD, "hotel", "巴塞隆納機場", "機場旁飯店入住（1/2–1/3）",
     "Barcelona El Prat Airport", "",
     "入住時就跟櫃檯登記凌晨的接駁班次 —— 很多機場飯店凌晨不發車。", "示範資料。"),

    # ---------------------------------------------------------- 1/3 返程
    ("2028-01-03T03:00", "2028-01-03T03:30", MAD, "transport", "巴塞隆納機場", "飯店接駁車 → 航廈",
     "Barcelona El Prat Airport, Terminal 1", "", "03:30 前一定要到櫃檯。", ""),
    ("2028-01-03T06:30", None, MAD, "transport", "巴塞隆納 → 轉機點", "XX5678 起飛",
     "Barcelona El Prat Airport, Terminal 1", "XX5678", "",
     "抵達時間寫在備註 —— 那是另一個時區，要另開一筆事件。"),
    ("2028-01-03T12:05", None, IST, "transport", "伊斯坦堡", "抵達・入境",
     "Istanbul Airport (IST)", "",
     "跨時區時「抵達」要獨立成一筆，時間軸才會在正確的時刻推進。", "轉機停留約 14 小時。"),
    ("2028-01-03T14:00", "2028-01-03T20:30", IST, "sight", "伊斯坦堡", "轉機市區導覽",
     "Sultanahmet, Istanbul", "",
     "鐵則：跟團不脫隊。", "1 月伊斯坦堡 3–8°C，厚外套圍巾要帶著。"),
    ("2028-01-03T20:30", "2028-01-03T21:30", IST, "transport", "伊斯坦堡", "回機場 → 重過安檢出境",
     "Istanbul Airport (IST)", "", "安檢＋出境留 1 小時。", ""),

    # ---------------------------------------------------------- 1/4 抵達
    ("2028-01-04T01:55", None, IST, "transport", "伊斯坦堡 → 台北", "XX9012 起飛",
     "Istanbul Airport (IST)", "XX9012", "", "機上直接睡＝時差軟著陸。"),
    ("2028-01-04T17:40", None, TPE, "transport", "返程", "抵達・行程結束",
     "Taoyuan International Airport", "", "",
     "長途飛行每 2–3 小時起身走動、多喝水。"),
]


def seed(con) -> int:
    """Insert the seed events. Returns how many rows were inserted."""
    rows = [
        (t, cat, start, end, tz, city, loc, code, warn, notes, i)
        for i, (start, end, tz, cat, city, t, loc, code, warn, notes) in enumerate(EVENTS)
    ]
    con.executemany(
        "INSERT INTO events(title, category, start_at, end_at, tz, city, location, "
        "code, warning, notes, position) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    return len(rows)
