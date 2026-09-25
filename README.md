# AI 即時全網比價

目前專案使用 **SerpAPI Google Shopping + Groq** 架構：SerpAPI 提供商品與價格來源，Groq 負責規格解析；Groq 不可用時才由 Gemini 接手解析。

## 架構

```text
GitHub Pages
    ↓
Cloudflare Worker
    ↓
SerpAPI Google Shopping
    ↓
Groq Structured Outputs
    ↓
Gemini fallback（僅 Groq 失敗時）
```

## 使用方式

使用者只需要輸入主商品，例如：

```text
舒潔衛生紙
iPhone 18 Pro
Sony WH-1000XM6
```

系統會：

1. 由 SerpAPI 查詢 Google Shopping 的目前商品資料。
2. 不限制特定商城。
3. 找出台灣可以購買的商品與售價。
4. 自動整理動態規格。
5. 顯示賣場、商品、規格、價格、單位價格與來源。
6. 依搜尋結果自動產生規格篩選，例如：
   - 手機：容量、顏色、版本
   - 衛生紙：層數、抽數、包數
   - 服飾：尺寸、顏色

## 價格可信度原則

Groq 與 Gemini 不可以只靠模型記憶猜價格。

後端會保留 SerpAPI Google Shopping 實際回傳的商品連結，並再次驗證：

- 商品必須有價格。
- 商品必須有 source_url。
- source_url 必須對應到本次 Google Shopping 的實際商品連結。
- 無法驗證來源的商品直接丟棄。

所以網站顯示的每筆價格都應該能點「查看來源」回到本次搜尋取得的網頁。

## 搜尋與解析流程

後端會呼叫 SerpAPI Google Shopping，並以 Groq Structured Outputs 整理資料：

```text
GET https://serpapi.com/search.json?engine=google_shopping
```

Groq 發生配額、速率限制、暫時性服務錯誤或格式錯誤時，才使用 Gemini 備援；兩者都只收到 SerpAPI 已取得的商品列，並以 structured output 固定 JSON 格式。

## 主要檔案

- `index.html`
  - GitHub Pages 前端
  - 商品搜尋
  - 動態規格篩選
  - 比價結果
  - Google Shopping 來源

- `worker/src/index.js`
  - Cloudflare Worker
  - SerpAPI / Groq / Gemini API Secret
  - Google Shopping 商品來源
  - Groq Structured Output 與 Gemini 備援
  - 來源驗證
  - 10 分鐘快取

- `worker/wrangler.toml`
  - Cloudflare Worker 設定

## Cloudflare Worker

API Key 存在 Cloudflare Secret，不會放在 GitHub Pages 原始碼。

第一次設定：

```powershell
cd worker
npm install
npx wrangler login
npx wrangler secret put SERPAPI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

之後更新 Worker 只需要：

```powershell
npx wrangler deploy
```

## 模型與額度

目前預設使用 `openai/gpt-oss-20b` 進行 Groq 解析，`gemini-3.6-flash` 為備援。Gemini Secret 可不設定，但此時 Groq 無法使用就會回傳錯誤。

```toml
GEMINI_MODEL = "gemini-3.6-flash"
GROQ_MODEL = "openai/gpt-oss-20b"
```

SerpAPI 免費方案每月 250 次搜尋；相同查詢會在 Worker 快取 10 分鐘，以降低使用量。

## 注意

Gemini API 的計費資格與 Gemini App 訂閱不同；它只會在 Groq 無法完成解析時使用，並絕不做搜尋或猜價。
