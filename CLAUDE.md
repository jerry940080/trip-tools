# CLAUDE.md — trip-tools（旅行記帳・餐廳，測試版）

使用者以繁體中文溝通，回覆一律繁體中文。這是 2026-10-07 在 IzuAtami-trip 的對話裡做的，背景與決策記在這裡。

## 是什麼
GitHub Pages 靜態網站＋Firebase（Spark 免費方案，專案 `trip-tools-21847`）。功能：
- **記帳**：日幣／台幣，每趟一個匯率（1 台幣＝N 日圓，預設 4.8，成員都能改）；誰付＋哪幾個人分；
  分法 平均／比例（份數）／指定金額（加總要等於金額）／有人請客（只算在付款人身上）。
- **結算**：全部換台幣算每人結餘（先付−應分），貪婪法算最少轉帳；按「已付」記一筆 `settles`，結餘跟著抵掉；可匯出 CSV。
- **餐廳**：成員貼 Google 地圖連結推薦 → 待收錄 → 主辦人收錄（確認排哪天、哪餐；餐別必填）或婉拒。
  **2026-10-12 起已接到行程網站**：IzuAtami-trip 的餐廳頁用 Firestore REST 讀 `status=='in'` 的店，標「家人推薦」；
  行程網站的「＋ 新增餐廳」開 `#/t/IzuAtami-trip/resto/add`（這個路由會直接打開推薦表單，再把網址收回 `/resto`）。
- **成員**：主辦人產生邀請連結（20 碼亂數、7 天有效、重新產生即作廢舊的），家人點開用 Google 登入就加入；主辦人可移除成員。

## 使用者確認過的需求（別改回去）
- 和行程網站分開，獨立 repo、獨立網址；正式網站一行都不動。
- Google 登入；每趟成員不同；行程本身仍公開，**花費只有成員看得到**。
- 記帳主畫面＝「依日期列表」＋上方每人結餘摘要。

## 資料（Firestore）
```
users/{uid}                 {trips:{tripId:{title,start,end,color,cover,role}}}   ← 我的行程清單（避免 collectionGroup 索引）
trips/{id}                  {title,start,end,color,cover,owner,rate,createdAt}     ← id＝行程 repo 名稱
trips/{id}/private/invite   {key,expires(Timestamp)}                               ← 只有主辦人能讀寫
trips/{id}/members/{uid}    {uid,name,photo,email,role:'owner'|'member',key,joinedAt}
trips/{id}/expenses/{auto}  {date,title,icon,amount,cur:'JPY'|'TWD',payer,mode:'equal'|'ratio'|'amount'|'treat',shares:{uid:份數或金額},by,at}
trips/{id}/settles/{auto}   {from,to,amount(台幣),at,by}
trips/{id}/restos/{auto}    {name,url,ll,day,meal,note,by,byName,status:'pending'|'in'|'no',at,decidedAt}
```
- 建立行程時從 `/<repo>/trip.json`（同網域）讀標題、日期、顏色、封面；可建立的清單是 `app.js` 的 `KNOWN`。
- 邀請驗證在 `firestore.rules` 裡做：members 建立時 `key` 要等於 `private/invite.key` 且 `request.time < expires`。
- `restos` 在 `status=='in'` 時免登入可讀（給行程網站用；公開的欄位：店名、網址、座標、日期、餐別、備註、推薦人名字與 uid）。
- `trips/{id}` 的 `get` 允許 `resource == null`，否則查「這趟建了沒」會被當成沒權限。

## 程式
- `app.js` 只認 `api` 介面；`?mock` 時載入 `mock.js`（localStorage `tt-mock`，模擬主要權限），否則 `fb.js`。
  **改權限規則時 `mock.js` 要一起改**，模擬測試才有意義。
- 寫入（記帳、已付、收錄）用 `bg()` 不等伺服器：Firestore 離線快取下 `await addDoc` 會等到連上網才 resolve，旅途沒網路時表單會卡住。
- 路由：`#/` 我的行程、`#/t/ID/exp|settle|resto|mem`、`#/join/ID/KEY`。
- 驗證腳本在 IzuAtami-trip 對話的 scratchpad：`tt/t1.js`（模擬模式全流程 53 項：建立、邀請對錯與過期、四種分法、結算與已付、
  權限、餐廳推薦／收錄／改日期／婉拒、移除成員、手機與桌機無溢出）。本機用 `python3 -m http.server` 從上一層目錄起，`/<repo>/trip.json` 才讀得到。
- 開發環境連不到 gstatic／Firebase，**真正的登入與資料庫只能由使用者上線後測**。

## 嵌入模式（2026-10-12）
`?embed=行程ID`：給行程網站用 iframe 嵌入（IzuAtami-trip 的「資訊 › 記帳」與電腦版 `#acct`）。`<html class="embed">`：
不顯示測試橫條、分頁移到上方當分段（餐廳分頁改叫「推薦」，避免和行程網站的「餐廳」撞名）、沒有「我的行程」（`#/` 一律導回這趟）、
登出回這趟、登入頁多「改在新視窗打開記帳」。`fb.js` 載入失敗（沒網路、被擋）顯示「連不上記帳伺服器」而不是一直「載入中…」。
其他行程網站要嵌入，照 IzuAtami-trip CLAUDE.md 變更（四十）做。

## 預算（2026-10-13）
使用者要求「花費只有登入的成員看得到，管理人可以編輯每一項的金額與計算方式」。原本行程網站的公開花費頁（`COST`）整個搬過來。
- 分頁順序：**預算**／記帳／結算／推薦（嵌入時；獨立開時叫餐廳）／成員。路由 `#/t/ID/budget`。
- 資料 `trips/{id}/budget/{auto}`：`{g 分組, name, note, amt(null＝未知、0＝免費), cur 'NT'|'JPY', mode, rooms, approx, opt, order, by, at}`；
  `mode`：`total` 總價 ÷ 人數、`pp` 每人單價 × 人數、`room` 每間 × 間數 ÷ 人數（使用者選的三種；沒有「只算部分人」）。
  人數＝`trips/{id}.ppl`（**主辦人設定**，預設 4；不是成員數）。`opt` 是選項，去了才算、不計入合計。
- 權限：`budget` 成員可讀、只有主辦人可寫；`ppl` 寫在 trip 文件，原規則本來就只准主辦人改 rate 以外的欄位。
  預算讀不到（規則沒更新）時只影響預算頁（`cur.bErr`），不會鎖住整個工具。
- **每人每晚**（使用者要求，住宿用）：項目多一個 `nights`（晚數，選填）。有晚數時那列多一行橘字「每人每晚 …」＝每人金額 ÷ 晚數，編輯時的試算也會顯示。
  `bNights()`：`nights` 沒填但分組是住宿，就從說明裡的「N 晚」讀，所以舊資料（匯入時說明寫著「2 晚」）不用改也會顯示。
- 合計：日圓與台幣分開加總，另用 trip 的匯率換算「約合台幣」。分組固定順序 `BG`，自訂分組排在後面。
- **匯入**：預算是空的時候，主辦人看到「匯入行程網站原本的預估」，讀 `seeds/<行程ID>.json`（`{ppl, items}`），逐筆 `add`。
  `seeds/IzuAtami-trip.json` 是 2026-10-13 從行程網站 `COST` 轉出來的 41 項（grp／car → total、其餘 → pp、駕照譯本改 total）。
  **這個檔是公開的**（GitHub Pages），使用者匯入後要刪掉。
- 驗證：IzuAtami 對話 scratchpad `tt/bud.js`（匯入、Airbnb 3,044／12,176、改人數重算、每間×間數、留空＝未知、刪除、成員唯讀、非成員擋、嵌入無溢出）、
  `tt/emb3.js`（行程網站嵌入）；`t1.js` 的分頁位置因為多了預算往後挪一格。

## localStorage
`tt-mock`、`tt-mock-me`（只有模擬模式）。Firebase 自己用 IndexedDB 存離線快取。同網域其他網站用 `izu-`、`hub-` 等前綴，不衝突。

## 待辦
1. 使用者已完成 Pages、規則、授權網域三步驟（2026-10-07），待實測登入。
   邀請連結帶 `?openExternalBrowser=1`（LINE 會改用預設瀏覽器開）；LINE／FB／IG 內建瀏覽器另顯示「請改用 Safari 或 Chrome」提示，因為 Google 不准在內建瀏覽器登入（403 disallowed_useragent）。
2. （已完成 2026-10-12）正式名單接到行程網站的餐廳頁。其他行程網站要接的話，照 IzuAtami-trip CLAUDE.md 變更（三十九）做。
3. 記帳可考慮：照片收據、依類別統計、更多幣別。
