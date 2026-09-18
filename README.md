# 個人智慧比價系統

新版架構已改成：

- 前端：GitHub Pages 的 `index.html`
- 後端：Cloudflare Worker
- 商城來源：PChome、momo、蝦皮
- Gemini：只負責商品名稱與規格正規化，不產生價格或網址

## 使用流程

1. 搜尋主商品，例如 `iPhone 18 Pro`
2. 後端取得各商城商品資料
3. Gemini 從實際商品標題整理動態規格
4. 首頁自動產生規格選項，例如：
   - 容量：256GB / 512GB / 1TB
   - 顏色：黑色 / 白色 / 原色鈦金屬
   - 其他商品也能自動產生尺寸、版本、記憶體、連線版本等欄位
5. 點選需要的規格後，只顯示符合該組規格的商城價格並標示最低價

## Gemini Key 不再放首頁

Gemini API Key 不會出現在 `index.html`，也不儲存在瀏覽器。

Key 改放 Cloudflare Worker Secret，因此即使 GitHub Pages 是公開原始碼，也看不到你的 Gemini Key。

## 第一次部署 Cloudflare Worker

本機安裝 Node.js 後執行：

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

在 `wrangler secret put GEMINI_API_KEY` 時貼入你的 Gemini API Key。

部署完成後 Cloudflare 會給你一個 Worker 網址，例如：

```text
https://shopping-compare-api.<你的帳號>.workers.dev
```

## 把 GitHub Pages 接到 Worker

打開 `index.html`，找到：

```js
const API_BASE_URL = "";
```

改成剛取得的 Worker 網址：

```js
const API_BASE_URL = "https://shopping-compare-api.<你的帳號>.workers.dev";
```

提交後，原本 GitHub Pages 網址就可以直接使用，而且首頁不需要再輸入 Gemini Key。

Worker 已包含 CORS，因此 GitHub Pages 可以跨網域呼叫。

## Gemini 模型

預設模型設定在：

```text
worker/wrangler.toml
```

目前：

```toml
GEMINI_MODEL = "gemini-3.6-flash"
```

如果你的 Gemini API 可用模型不同，可直接修改。

## 資料可靠性

新版原則：

- 價格：商城資料
- 商品網址：商城資料
- 商品規格：Gemini 根據實際商品標題整理
- Gemini 不會被要求猜價格
- 某商城被反爬或搜尋 API 改版時，前端會顯示該商城連線失敗，不會補一個 AI 猜測價格

## 主要檔案

- `index.html`：搜尋、規格按鈕、價格比較
- `worker/src/index.js`：商城搜尋 + Gemini 規格正規化
- `worker/wrangler.toml`：Cloudflare Worker 設定
- `worker/package.json`：Worker 部署工具

`app.py` 與 `comparator.py` 已停止作為主要流程使用，避免舊版 AI 猜價邏輯繼續被誤用。
