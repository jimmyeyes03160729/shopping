# AI 即時全網比價

目前專案已改成 **Gemini + Google Search Grounding** 架構，不再自行維護各商城爬蟲。

## 架構

```text
GitHub Pages
    ↓
Cloudflare Worker
    ↓
Gemini Interactions API
    ↓
Google Search Grounding
    ↓
結構化商品 / 規格 / 價格 / 來源
```

## 使用方式

使用者只需要輸入主商品，例如：

```text
舒潔衛生紙
iPhone 18 Pro
Sony WH-1000XM6
```

系統會：

1. 讓 Gemini 使用 Google Search 搜尋目前網路資料。
2. 不限制特定商城。
3. 找出台灣可以購買的商品與售價。
4. 自動整理動態規格。
5. 顯示賣場、商品、規格、價格、單位價格與來源。
6. 依搜尋結果自動產生規格篩選，例如：
   - 手機：容量、顏色、版本
   - 衛生紙：層數、抽數、包數
   - 服飾：尺寸、顏色

## 價格可信度原則

Gemini 不可以只靠模型記憶猜價格。

後端會擷取本次 Google Search 實際回傳的來源網址，並再次驗證：

- 商品必須有價格。
- 商品必須有 source_url。
- source_url 必須對應到本次 Google Search 的實際來源。
- 無法驗證來源的商品直接丟棄。

所以網站顯示的每筆價格都應該能點「查看來源」回到本次搜尋取得的網頁。

## Google Search Grounding

後端使用 Gemini Interactions API：

```text
POST https://generativelanguage.googleapis.com/v1beta/interactions
```

並開啟：

```json
{
  "tools": [
    { "type": "google_search" }
  ]
}
```

同時使用 structured output，把結果固定成 JSON 商品資料。

## 主要檔案

- `index.html`
  - GitHub Pages 前端
  - 商品搜尋
  - 動態規格篩選
  - 比價結果
  - Google Search 來源

- `worker/src/index.js`
  - Cloudflare Worker
  - Gemini API Secret
  - Google Search Grounding
  - Structured Output
  - 來源驗證
  - 10 分鐘快取

- `worker/wrangler.toml`
  - Cloudflare Worker 設定

## Cloudflare Worker

Gemini API Key 存在 Cloudflare Secret，不會放在 GitHub Pages 原始碼。

第一次設定：

```powershell
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

之後更新 Worker 只需要：

```powershell
npx wrangler deploy
```

## Gemini 模型

目前 `worker/wrangler.toml` 預設：

```toml
GEMINI_MODEL = "gemini-3.6-flash"
```

後端遇到暫時性 429 / 5xx 會重試，並可嘗試備援 Flash 型號。

## 注意

Google Search Grounding 的使用資格與計費取決於 Gemini API 專案 / API Tier，和 Gemini App 的 Pro 訂閱不是同一件事。

如果 API 專案未開通 Google Search Grounding，網站會直接顯示 Gemini API 回傳的錯誤，不會退回 AI 猜價模式。
