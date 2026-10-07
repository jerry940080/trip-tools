# trip-tools（測試版）

旅行的**花費記帳／分帳**和**餐廳推薦／收錄**，要用 Google 帳號登入，只有每趟的成員看得到。
行程網站（IzuAtami-trip 等）不用登入照常公開，**這個工具完全獨立，不會影響它們**。

- 網址：https://jerry940080.github.io/trip-tools/
- 模擬模式（不連資料庫、資料只存在這台瀏覽器，用來試畫面）：`?mock=1`，`?mock=1&as=媽媽` 換身分，`?mock=reset` 清空

## 第一次啟用（只要做一次）

1. **開 GitHub Pages**：這個 repo → Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾 `/ (root)` → Save。
2. **貼資料權限規則**：Firebase 主控台 → Firestore Database → 「規則」分頁 → 把 `firestore.rules` 整段貼上取代 → 發布。
3. **確認登入網域**：Firebase 主控台 → Authentication → 設定 → 已授權的網域，要有 `jerry940080.github.io`（沒有就新增）。
4. 打開網址 → 用 Google 登入 → 建立一趟 → 成員頁產生邀請連結 → 傳到 LINE 群組。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 版面與樣式 |
| `app.js` | 主程式（四個分頁：記帳、結算、餐廳、成員；邀請加入頁） |
| `fb.js` | Firebase 登入與資料庫 |
| `mock.js` | 模擬模式，介面和 `fb.js` 相同 |
| `firestore.rules` | 資料權限（要貼到 Firebase 主控台才生效） |
