# 個人智慧比價系統

目前主架構：

- 前端：`index.html`
- 後端：Cloudflare Worker
- 商城來源：PChome、momo、蝦皮
- Gemini：只負責商品規格正規化，不負責產生價格或網址

## 使用流程

1. 搜尋主商品，例如 `iPhone 18 Pro`
2. 系統先取得各商城商品資料
3. Gemini 從商品標題整理動態規格，例如：
   - 容量：256GB / 512GB / 1TB
   - 顏色：黑色 / 白色 / 原色鈦金屬
   - 其他商品也可自動出現尺寸、版本、記憶體等欄位
4. 首頁自動產生可點選的規格選項
5. 選擇規格後，只顯示符合該組規格的商城價格，並標示目前最低價

## 為什麼首頁沒有 Gemini Key

不要把 Gemini API Key 寫在 GitHub Pages 或 JavaScript 裡。即使網址只有自己使用，瀏覽器仍能直接看到原始碼中的 Key。

本專案改成把 Key 放在 Cloudflare Worker Secret，首頁不需要輸入 Key。

## Cloudflare Worker 部署

先安裝 Node.js，之後：

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

輸入 `wrangler secret put GEMINI_API_KEY` 後，把你的 Gemini API Key 貼進終端機。

部署完成後會取得類似：

```text
https://shopping-compare-api.<你的帳號>.workers.dev
```

目前 `wrangler.toml` 已設定把專案根目錄當作靜態資源，因此最簡單的使用方式是直接用這個 Worker 網址開啟網站。這樣 `index.html` 中：

```js
const API_BASE_URL = "";
```

不需要修改。

## 若仍要使用 GitHub Pages

如果你希望前端繼續放 GitHub Pages，也可以把 `index.html` 裡的：

```js
const API_BASE_URL = "";
```

改成：

```js
const API_BASE_URL = "https://shopping-compare-api.<你的帳號>.workers.dev";
```

如果跨網域使用，Worker 需再加入允許該 GitHub Pages 網域的 CORS 設定。

## Gemini 模型

預設模型在 `worker/wrangler.toml`：

```toml
GEMINI_MODEL = "gemini-2.5-flash"
```

可依你的 Gemini API 可用模型調整。

## 資料可靠性原則

- 價格：商城搜尋資料
- 商品網址：商城搜尋結果
- 型號 / 容量 / 顏色：Gemini 根據實際商品標題整理
- Gemini 不會收到「請猜價格」的任務
- 某商城被反爬或 API 改版時，首頁會顯示該商城連線失敗，而不是補一個 AI 猜的價格

## 舊檔案

`app.py` 與 `comparator.py` 保留作為相容提示，但主要版本已改為 `index.html + worker/src/index.js`。
