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
GEMINI_MODEL = "gemini-3.8-flash"
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


## Gemini 過載備援

後端遇到 Gemini 429 / 5xx（例如 503 high demand）時會自動重試，並依序切換備援模型：

- gemini-3.8-flash
- gemini-3.7-flash
- gemini-3.6-flash
- gemini-3.5-flash-lite

因此單一模型尖峰過載時，不會直接讓整次比價失敗。


## 搜尋速度改善

新版後端做了三項調整：

- 每個自動比價商城只取前 12 筆最相關商品，最多送 36 筆做規格整理。
- 相同關鍵字與相同商城組合會保留約 10 分鐘記憶體快取；同一個 Worker instance 內重複搜尋可直接回傳。
- 規格正規化預設改用低延遲的 `gemini-3.5-flash-lite`，若失敗再切換其他 Flash 模型。

## 固定賣場

首頁固定保留以下 17 家，不提供自行新增：

- momo 購物網
- PChome 24h購物
- Yahoo奇摩購物中心
- Coupang 酷澎
- 蝦皮購物
- Costco 好市多線上購物
- UNIQLO 台灣網路商店
- 誠品線上 (Eslite)
- PXGo! 全聯線上購
- 燦坤線上購物 (Tk3C)
- 全國電子線上購物
- 家樂福線上
- 屈臣氏台灣
- 康是美網購
- 東森購物網
- 全家
- 統一超商

目前 momo、PChome、蝦皮會嘗試直接加入自動比價；其他固定賣場先提供搜尋入口。後續若某家需要自動抓價，可再為該網站加入專用 adapter。

## 蝦皮

蝦皮目前採 best-effort 方式讀取網頁搜尋資料。若該搜尋端點拒絕 Cloudflare Worker 請求，前端會顯示「連線失敗」並提供蝦皮手動搜尋連結，不會產生假的價格。


## 17 家固定賣場自動比價

目前後端會對 17 家固定賣場全部自動嘗試搜尋商品與價格：

- momo 購物網
- PChome 24h購物
- Yahoo奇摩購物中心
- Coupang 酷澎
- 蝦皮購物
- Costco 好市多線上購物
- UNIQLO 台灣網路商店
- 誠品線上 (Eslite)
- PXGo! 全聯線上購
- 燦坤線上購物 (Tk3C)
- 全國電子線上購物
- 家樂福線上
- 屈臣氏台灣
- 康是美網購
- 東森購物網
- 全家
- 統一超商

PChome、momo、蝦皮使用專用搜尋邏輯；其餘賣場使用通用 HTML / JSON-LD / 內嵌 JSON 解析器。所有來源會平行搜尋，單一網站失敗不會拖垮整體結果。

由於部分商城會使用反爬、登入、地區或純前端動態資料，某些賣場可能顯示「連線失敗」或 0 筆。這種情況前端會保留該賣場的手動搜尋入口，不會用 AI 猜價格。

Gemini 只做商品型號與規格正規化；若 Gemini 逾時或 503，系統會自動改用本地規格解析，避免整次搜尋失敗。


## 專用商城 Adapter（第二階段）

已新增優先專用解析：

- Costco：改用 `/s?keyword=` 搜尋路徑，並加強商品卡 / JSON-LD / 關鍵字視窗解析。
- Yahoo奇摩購物中心：針對商品 Grid 結構解析商品名稱、價格與連結。
- Coupang 酷澎：針對 `/vp/products/` 商品卡解析商品名稱、折扣後價格與商品網址。
- 家樂福線上：針對搜尋頁的商品區塊與價格格式加強解析。
- 燦坤 Tk3C：針對商品頁 / 分類頁常見的「網路價」與商品連結格式加強解析。

以上專用 adapter 失敗時仍會回退到通用 HTML / JSON-LD / 內嵌 JSON 解析器。單一商城被擋或改版不會影響其他商城。
