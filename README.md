# 線上共同畫板

輸入房號就能和朋友即時一起畫畫，作品自動儲存在房間裡，下次進來還在。

## 功能

| 需求 | 做法 |
|---|---|
| 上傳圖片 | 「上傳圖片」按鈕、直接把圖片拖到畫布上、或 Ctrl+V 貼上。可以選「放上畫布」（先拖曳移動、拉右下角縮放），或「設為背景」（放在最底層並符合畫布大小）。 |
| 背景與橡皮擦 | 背景在獨立的最底層，橡皮擦擦不掉；擦掉上面的筆畫和圖片時，會露出背景原本的顏色。滴管取色、下載 PNG 都包含背景。 |
| 上一步／下一步 | 「上一步」復原自己最近一個動作（筆畫、圖片、背景都算），「下一步」再放回來，而且會回到原本的圖層位置。復原後又畫了新東西，就不能再「下一步」。只會動到自己畫的東西，不影響別人。 |
| 下載作品 | 「下載 PNG」：1920×1080 白底 PNG。 |
| 房號 | 大廳可「加入房間」或「建立房間」。建立時房號可自訂（英文、數字、`_`、`-`），留空會自動產生 6 位數。 |
| 房間密碼 | 建立時可設定密碼；在房間內按「密碼」也可以隨時設定、修改或取消。密碼在伺服器上以 scrypt 雜湊保存，不存明碼。 |
| 調色 | 色盤（飽和度方塊＋色相條）、R/G/B 滑桿與數字輸入（0–255）、HEX 輸入、20 個常用色、最近使用的顏色。 |
| 放大縮小 | 滑鼠滾輪以游標位置為中心放大縮小（最多 12 倍）。放大後按住滑鼠右鍵（或中鍵、空白鍵）拖曳、或拖曳畫布外的灰色區域可以移動畫面。手機用兩指縮放和移動。右下角有 − / + 按鈕，按百分比可回到符合畫面。 |
| 其他 | 畫筆、橡皮擦、滴管（從畫布取色）、粗細、不透明度、清空畫布、邀請連結、在線名單、斷線自動重連、手機可用。 |

### 快捷鍵

| 按鍵 | 功能 |
|---|---|
| `B` / `P` | 畫筆 |
| `E` | 橡皮擦 |
| `I` | 滴管 |
| `[` / `]` | 筆刷變細 / 變粗 |
| `Ctrl + Z` | 上一步（復原自己最近一個動作） |
| `Ctrl + Y` 或 `Ctrl + Shift + Z` | 下一步（把剛剛復原的放回來） |
| `Ctrl + V` | 貼上圖片 |
| 滑鼠滾輪 | 放大縮小（以游標位置為中心） |
| `+` / `-` | 放大 / 縮小 |
| `0` | 回到符合畫面 |
| 按住滑鼠右鍵拖曳（或中鍵、`空白鍵`＋左鍵） | 移動畫面 |
| `Enter` / `Esc` | 擺放圖片時：確定 / 取消 |

---

## 在自己電腦上執行

需要 [Node.js](https://nodejs.org/) 18 以上（建議 LTS 版）。

```bash
npm install
npm start
```

打開瀏覽器到 <http://localhost:3000>。開兩個分頁進同一個房號，就能測試多人同步。

本機執行時，房間資料會存在 `data/` 資料夾（每個房間一個 JSON 檔）。

---

## 免費架設到網路上（Render + MongoDB Atlas）

**為什麼要兩個服務？** Render 免費主機負責跑網站，但它的硬碟是暫時的，每次重啟、重新部署、閒置休眠後檔案都會消失。所以作品要存到 MongoDB Atlas 的免費資料庫，才會永久保存。

### 步驟 1：建立免費資料庫（MongoDB Atlas）

1. 到 <https://www.mongodb.com/cloud/atlas/register> 註冊帳號。
2. 建立 Cluster，方案選 **Free（M0）**，地區建議選 **Singapore**（離台灣近，和步驟 3 的 Render 同區）。
3. **Database Access**：新增一個資料庫使用者，記下帳號和密碼。
   密碼建議只用英文和數字，不然要另外做網址編碼。
4. **Network Access**：按 Add IP Address，選 **Allow access from anywhere**（`0.0.0.0/0`）。
   這是因為 Render 免費方案沒有固定 IP。
5. 回到 Cluster 按 **Connect → Drivers**，複製連線字串，長得像：
   ```
   mongodb+srv://帳號:<db_password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
   ```
   把 `<db_password>` 換成步驟 3 的密碼，先存起來。

### 步驟 2：把程式碼放上 GitHub

到 <https://github.com/new> 建立一個新的 repository（可以設成 Private），然後在這個資料夾執行：

```bash
git init
git add .
git commit -m "線上共同畫板"
git branch -M main
git remote add origin https://github.com/你的帳號/你的repo名稱.git
git push -u origin main
```

`.gitignore` 已經排除了 `node_modules/` 和 `data/`，不會把測試資料傳上去。

### 步驟 3：在 Render 部署網站

1. 到 <https://render.com> 用 GitHub 帳號登入。
2. 按 **New → Web Service**，選剛剛的 repository。
3. 設定：
   - **Region**：Singapore
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：**Free**
4. 在 **Environment Variables** 新增：
   - `MONGODB_URI` = 步驟 1 複製的連線字串
5. 按 **Deploy**。完成後會得到網址，例如 `https://painting-online.onrender.com`，傳給朋友就能一起畫了。

> 也可以改用 **New → Blueprint**，Render 會讀 `render.yaml` 自動帶入設定，只需要貼上 `MONGODB_URI`。

部署完成後，Render 的 Logs 應該會看到 `儲存方式：MongoDB`。如果顯示「本機檔案」，代表 `MONGODB_URI` 沒設好，資料會在重啟後消失。

### 免費方案的限制

- **會休眠**：Render 免費主機 15 分鐘沒人使用就會休眠，下一個人打開時要等約 30～60 秒喚醒。大廳畫面會顯示「正在連線伺服器…」，等它變成「已連線」即可。
- **容量 512 MB**：MongoDB Atlas 免費方案的上限。筆畫很小，主要是上傳的圖片佔空間（每張已自動壓縮到長邊 1920px 以內）。
- **自動清理**：超過 30 天沒人進入的房間會自動刪除，避免容量爆掉。可用環境變數 `ROOM_TTL_DAYS` 調整（設 `0` = 永不刪除）。

---

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `3000` | 網站埠號（Render 會自動設定） |
| `MONGODB_URI` | （無） | 有設定就用 MongoDB 儲存，沒設定就存到本機 `data/` |
| `MONGODB_DB` | `painting_online` | MongoDB 資料庫名稱 |
| `DATA_DIR` | `./data` | 本機儲存資料夾 |
| `ROOM_TTL_DAYS` | `30` | 房間閒置幾天後自動刪除，`0` 表示不刪除 |

## 專案結構

```
server.js              伺服器：房間、密碼驗證、即時同步（Express + Socket.IO）
store.js               儲存層：MongoDB 或本機 JSON 檔
public/
  index.html           大廳與畫板畫面
  style.css            樣式
  js/main.js           連線、大廳、工具列、上傳下載
  js/board.js          畫布：繪圖、同步重播、圖片擺放
  js/color-picker.js   色盤與 RGB 調色
render.yaml            Render 部署設定
```

## 運作原理

畫布上的每一筆畫、每一張圖片、每一次設定背景都是一個「操作」，伺服器幫每個操作編上遞增的序號並依序保存。新進房間的人收到全部操作後依序重畫，就會得到同一張圖。畫筆移動時，座標每一格畫面送出一次，所以其他人可以即時看到線條畫出來。

畫布分三層：最底層是背景（最後一次設定的背景圖），中間是筆畫和圖片，最上層是正在畫、還沒放開的線條。橡皮擦只擦中間層，所以擦掉的地方會露出背景。

「上一步」會刪掉自己最後一個操作；「下一步」依原本的序號把它插回原位，所以圖層前後順序（例如橡皮擦擦過的地方、和別人的線條誰蓋誰）都和復原前一樣。「下一步」的紀錄只存在伺服器記憶體，伺服器重新啟動或房間沒人超過 1 分鐘就會清掉，已經畫好的內容不受影響。
