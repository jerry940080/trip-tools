# CLAUDE.md — trip-tools（旅行記帳・餐廳，測試版）

使用者以繁體中文溝通，回覆一律繁體中文。這是 2026-10-07 在 IzuAtami-trip 的對話裡做的，背景與決策記在這裡。

## 是什麼
GitHub Pages 靜態網站＋Firebase（Spark 免費方案，專案 `trip-tools-21847`）。功能：
- **記帳**：日幣／台幣，每趟一個匯率（1 台幣＝N 日圓，預設 4.8，成員都能改）；誰付＋哪幾個人分；
  分法 平均／比例（份數）／指定金額（加總要等於金額）／有人請客（只算在付款人身上）。
- **結算**：全部換台幣算每人結餘（先付−應分），貪婪法算最少轉帳；按「已付」記一筆 `settles`，結餘跟著抵掉；可匯出 CSV。
- **餐廳**：成員貼 Google 地圖連結推薦 → 待收錄 → 主辦人收錄（確認排哪天哪餐）或婉拒。正式名單**還沒接到行程網站的餐廳頁**（之後的工作）。
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
- `trips/{id}` 的 `get` 允許 `resource == null`，否則查「這趟建了沒」會被當成沒權限。

## 程式
- `app.js` 只認 `api` 介面；`?mock` 時載入 `mock.js`（localStorage `tt-mock`，模擬主要權限），否則 `fb.js`。
  **改權限規則時 `mock.js` 要一起改**，模擬測試才有意義。
- 寫入（記帳、已付、收錄）用 `bg()` 不等伺服器：Firestore 離線快取下 `await addDoc` 會等到連上網才 resolve，旅途沒網路時表單會卡住。
- 路由：`#/` 我的行程、`#/t/ID/exp|settle|resto|mem`、`#/join/ID/KEY`。
- 驗證腳本在 IzuAtami-trip 對話的 scratchpad：`tt/t1.js`（模擬模式全流程 50 項：建立、邀請對錯與過期、四種分法、結算與已付、
  權限、餐廳推薦／收錄／改日期／婉拒、移除成員、手機與桌機無溢出）。本機用 `python3 -m http.server` 從上一層目錄起，`/<repo>/trip.json` 才讀得到。
- 開發環境連不到 gstatic／Firebase，**真正的登入與資料庫只能由使用者上線後測**。

## localStorage
`tt-mock`、`tt-mock-me`（只有模擬模式）。Firebase 自己用 IndexedDB 存離線快取。同網域其他網站用 `izu-`、`hub-` 等前綴，不衝突。

## 待辦
1. 使用者已完成 Pages、規則、授權網域三步驟（2026-10-07），待實測登入。
   邀請連結帶 `?openExternalBrowser=1`（LINE 會改用預設瀏覽器開）；LINE／FB／IG 內建瀏覽器另顯示「請改用 Safari 或 Chrome」提示，因為 Google 不准在內建瀏覽器登入（403 disallowed_useragent）。
2. 正式名單接到行程網站的餐廳頁（行程網站讀 Firestore `status=='in'` 的公開資料；規則要另外開放）。
3. 記帳可考慮：照片收據、依類別統計、更多幣別。
