const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 55000;
const INPUT_USD_PER_MILLION_TOKENS = 0.75;
const OUTPUT_USD_PER_MILLION_TOKENS = 3.75;
const MONTHLY_FREE_GOOGLE_SEARCH_REQUESTS = 5000;
const GOOGLE_SEARCH_USD_PER_REQUEST_AFTER_FREE = 0.014;

const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    summary: { type: "string" },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          store: { type: "string" },
          title: { type: "string" },
          price: { type: "number" },
          currency: { type: "string" },
          source_url: { type: "string" },
          source_title: { type: "string" },
          unit_price_text: { type: "string" },
          specs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                value: { type: "string" }
              },
              required: ["label", "value"]
            }
          }
        },
        required: [
          "store",
          "title",
          "price",
          "currency",
          "source_url",
          "source_title",
          "unit_price_text",
          "specs"
        ]
      }
    }
  },
  required: ["query", "summary", "products"]
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        gemini: Boolean(env.GEMINI_API_KEY),
        mode: "google-search-grounding",
        model: env.GEMINI_MODEL || "gemini-3.6-flash"
      });
    }

    if (url.pathname === "/api/search") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleSearch(request, env);
    }

    return new Response("Shopping compare API", { status: 200 });
  }
};

async function handleSearch(request, env) {
  try {
    if (!env.GEMINI_API_KEY) {
      return json({ error: "後端尚未設定 GEMINI_API_KEY" }, 500);
    }

    const body = await request.json();
    const keyword = String(body.keyword || "").trim();

    if (!keyword) return json({ error: "請輸入商品關鍵字" }, 400);

    const cacheKey = normalizeKey(keyword);
    const cached = SEARCH_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < SEARCH_CACHE_TTL_MS) {
      return json({ ...cached.payload, cache_hit: true });
    }

    const interaction = await runGroundedShoppingSearch(keyword, env);
    const parsed = parseModelJson(extractOutputText(interaction));
    const searchMeta = extractSearchMetadata(interaction);
    const usage = extractUsage(interaction, searchMeta);

    const verifiedProducts = verifyAndNormalizeProducts(
      parsed?.products || [],
      searchMeta.sources
    );

    const products = verifiedProducts
      .sort((a, b) => a.price - b.price)
      .slice(0, 30);

    const payload = {
      keyword,
      summary: String(parsed?.summary || ""),
      products,
      items: products,
      dimensions: buildDimensions(products),
      sources: searchMeta.sources,
      search_queries: searchMeta.queries,
      source_count: searchMeta.sources.length,
      updated_at: new Date().toISOString(),
      cache_hit: false,
      model: interaction._model_used || env.GEMINI_MODEL || "gemini-3.6-flash",
      mode: "google-search-grounding",
      usage,
      verification: {
        candidate_products: Array.isArray(parsed?.products) ? parsed.products.length : 0,
        verified_products: products.length,
        citation_sources: searchMeta.sources.length,
        search_queries: searchMeta.queries.length
      }
    };

    SEARCH_CACHE.set(cacheKey, { savedAt: Date.now(), payload });
    cleanupCache();
    return json(payload);
  } catch (error) {
    return json({ error: cleanError(error) }, 500);
  }
}

async function runGroundedShoppingSearch(keyword, env) {
  const model = String(env.GEMINI_MODEL || "gemini-3.6-flash").trim();
  const prompt = buildPrompt(keyword);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchWithTimeout(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            model,
            input: prompt,
            tools: [{ type: "google_search" }],
            response_format: {
              type: "text",
              mime_type: "application/json",
              schema: PRODUCT_SCHEMA
            }
          })
        },
        REQUEST_TIMEOUT_MS
      );

      const text = await response.text();

      if (!response.ok) {
        const lower = text.toLowerCase();

        if (
          response.status === 429 &&
          (
            lower.includes("exceeded your current quota") ||
            lower.includes("quota") ||
            lower.includes("billing")
          )
        ) {
          const error = new Error(
            "Google Search Grounding 配額不足：請在 Google AI Studio / Google Cloud 將目前 Gemini API 專案升級為 Paid Tier 並啟用 Billing。"
          );
          error.fatal = true;
          throw error;
        }

        if (response.status === 429) {
          const error = new Error("Gemini 暫時達到速率限制，請稍後再搜尋。");
          error.fatal = true;
          throw error;
        }

        const error = new Error(
          `Gemini ${model} HTTP ${response.status}: ${text.slice(0, 260)}`
        );

        if ([500, 502, 503, 504].includes(response.status) && attempt < 2) {
          await sleep(900);
          continue;
        }

        throw error;
      }

      const data = JSON.parse(text);
      data._model_used = model;
      return data;
    } catch (error) {
      if (error?.fatal) throw error;

      if (String(error?.message || "").includes("查詢逾時")) {
        throw error;
      }

      if (attempt < 2) {
        await sleep(900);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Gemini Google Search 查詢失敗");
}

function buildPrompt(keyword) {
  return [
    "你是一個台灣線上購物即時比價引擎。",
    `使用者要搜尋的商品：${keyword}`,
    "",
    "請使用 Google Search 搜尋現在可查到的台灣網路購物商品與價格，不限制商城。",
    "先做廣泛搜尋，再針對有明確價格的主要賣場補查；避免對同一商城重複很多相近查詢。",
    "整個任務盡量控制在約 6~8 個 Google Search 查詢內，以兼顧速度、成本與覆蓋率。",
    "請優先找台灣可購買的零售商、品牌官方商城、大型電商、量販店與超商線上商城。",
    "",
    "嚴格規則：",
    "1. 價格必須來自本次 Google Search 可驗證的搜尋來源，不得憑記憶、估價或猜測。",
    "2. source_url 請填本次搜尋結果中實際支持該價格的商品頁或商城頁網址，不要自行改寫網址。",
    "3. 只保留能確認商品名稱與目前售價的結果；舊文章估價、論壇討論、新聞價格不要當成商品售價。",
    "4. 排除二手、拍賣討論、價格比較文章本身；優先使用實際商城商品頁或商城搜尋頁。",
    "5. 搜尋主商品，不要把保護殼、配件、替換零件等不相關商品混進來。",
    "6. 同一商品不同容量、顏色、入數、尺寸、層數等，請拆成不同結果。",
    "7. specs 依商品類型動態整理。例如手機用容量/顏色；衛生紙用層數/抽數/包數；服飾用尺寸/顏色。",
    "8. unit_price_text 只有在規格足以可靠換算時才填，否則填空字串。",
    "9. 整理 6~12 筆品質較高、可驗證的結果即可；不要為了湊數增加低品質來源。",
    "10. store 填賣場名稱；台灣價格 currency 填 TWD。",
    "",
    "請直接回傳符合 schema 的 JSON。"
  ].join("\n");
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const stepLists = [
    Array.isArray(data?.steps) ? data.steps : [],
    Array.isArray(data?.outputs) ? data.outputs : []
  ];

  for (const steps of stepLists) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step?.type !== "model_output" && step?.type !== "text") continue;

      if (typeof step?.text === "string" && step.text.trim()) return step.text.trim();

      const contents = Array.isArray(step?.content) ? step.content : [];
      const text = contents
        .filter((part) => part?.type === "text" && typeof part?.text === "string")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text.trim();
    }
  }

  throw new Error("Gemini 沒有回傳結構化比價結果");
}

function extractSearchMetadata(data) {
  const queries = [];
  const sourceMap = new Map();
  const steps = [
    ...(Array.isArray(data?.steps) ? data.steps : []),
    ...(Array.isArray(data?.outputs) ? data.outputs : [])
  ];

  function addSource(rawUrl, title = "", snippet = "", origin = "search") {
    const url = normalizeHttpUrl(rawUrl);
    if (!url) return;

    const key = canonicalUrlKey(url);
    if (!key) return;

    const next = {
      title: cleanText(title),
      url,
      snippet: cleanText(snippet),
      origin
    };

    const existing = sourceMap.get(key);
    if (!existing) {
      sourceMap.set(key, next);
      return;
    }

    if (!existing.title && next.title) existing.title = next.title;
    if (!existing.snippet && next.snippet) existing.snippet = next.snippet;
    if (existing.origin !== "citation" && origin === "citation") {
      existing.origin = "citation";
    }
  }

  function collectResultSources(value, depth = 0) {
    if (value == null || depth > 6) return;

    if (Array.isArray(value)) {
      for (const item of value) collectResultSources(item, depth + 1);
      return;
    }

    if (typeof value !== "object") return;

    const url = value.url || value.uri || value.href;
    if (url) {
      addSource(
        url,
        value.title || value.name || "",
        value.snippet || value.description || "",
        "search_result"
      );
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        collectResultSources(child, depth + 1);
      }
    }
  }

  function collectAnnotations(annotations) {
    if (!Array.isArray(annotations)) return;

    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== "object") continue;

      if (
        annotation.type === "url_citation" ||
        annotation.url ||
        annotation.uri
      ) {
        addSource(
          annotation.url || annotation.uri,
          annotation.title || "",
          "",
          "citation"
        );
      }
    }
  }

  for (const step of steps) {
    if (step?.type === "google_search_call") {
      const q =
        step?.arguments?.queries ??
        step?.arguments?.query ??
        step?.arguments?.q ??
        step?.query;

      if (Array.isArray(q)) {
        for (const item of q) {
          const query = cleanText(item);
          if (query) queries.push(query);
        }
      } else {
        const query = cleanText(q);
        if (query) queries.push(query);
      }
    }

    if (step?.type === "google_search_result") {
      collectResultSources(step?.result);
    }

    if (step?.type === "model_output") {
      const contents = Array.isArray(step?.content) ? step.content : [];
      for (const block of contents) {
        collectAnnotations(block?.annotations);
        collectAnnotations(block?.citations);
      }
    }

    if (step?.type === "text") {
      collectAnnotations(step?.annotations);
      collectAnnotations(step?.citations);
    }
  }

  collectAnnotations(data?.annotations);
  collectAnnotations(data?.citations);

  return {
    queries: [...new Set(queries)],
    sources: [...sourceMap.values()]
  };
}

function verifyAndNormalizeProducts(products, sources) {
  const validSources = (Array.isArray(sources) ? sources : [])
    .filter((source) => normalizeHttpUrl(source?.url));

  const seen = new Set();
  const out = [];

  for (const raw of Array.isArray(products) ? products : []) {
    const price = Number(raw?.price);
    if (!Number.isFinite(price) || price <= 0 || price > 10000000) continue;

    const title = cleanText(raw?.title);
    const store = cleanText(raw?.store);
    if (!title || !store) continue;

    const verifiedSource = resolveVerifiedSource(raw, validSources);
    if (!verifiedSource) continue;

    const specs = sanitizeSpecs(raw?.specs);
    const dedupeKey = [
      normalizeForMatch(store),
      normalizeForMatch(title),
      price,
      JSON.stringify(specs)
    ].join("|");

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      id: simpleHash(dedupeKey),
      store_id: simpleHash(store),
      store_name: store,
      store,
      title,
      canonical_name: title,
      price,
      currency: String(raw?.currency || "TWD").toUpperCase(),
      url: verifiedSource.url,
      source_url: verifiedSource.url,
      source_title: cleanText(verifiedSource.title || raw?.source_title || store),
      source_origin: verifiedSource.origin || "citation",
      unit_price_text: cleanText(raw?.unit_price_text),
      specs,
      specs_list: Object.entries(specs).map(([label, value]) => ({ label, value }))
    });
  }

  return out;
}

function resolveVerifiedSource(raw, sources) {
  if (!sources.length) return null;

  const rawUrl = normalizeHttpUrl(raw?.source_url);
  const rawKey = canonicalUrlKey(rawUrl);
  const rawHost = urlHost(rawUrl);
  const rawRoot = siteRoot(rawHost);
  const store = normalizeForMatch(raw?.store);
  const sourceTitle = normalizeForMatch(raw?.source_title);

  let best = null;
  let bestScore = -1;

  for (const source of sources) {
    const sourceUrl = normalizeHttpUrl(source?.url);
    if (!sourceUrl) continue;

    const sourceKey = canonicalUrlKey(sourceUrl);
    const sourceHost = urlHost(sourceUrl);
    const sourceRoot = siteRoot(sourceHost);
    const title = normalizeForMatch(source?.title);

    let score = 0;

    if (rawKey && sourceKey === rawKey) {
      score += 1000;
    } else if (rawHost && sourceHost && rawHost === sourceHost) {
      score += 600;
    } else if (rawRoot && sourceRoot && rawRoot === sourceRoot) {
      score += 420;
    }

    if (rawUrl && sourceUrl) {
      score += pathSimilarityScore(rawUrl, sourceUrl);
    }

    if (sourceTitle && title) {
      if (title.includes(sourceTitle) || sourceTitle.includes(title)) score += 140;
    }

    if (store && title && store.length >= 3) {
      if (title.includes(store) || store.includes(title)) score += 100;
    }

    if (store && sourceHost) {
      const compactHost = normalizeForMatch(sourceHost);
      const storeTokens = merchantTokens(raw?.store);
      if (storeTokens.some((token) => token.length >= 3 && compactHost.includes(token))) {
        score += 120;
      }
    }

    if (source?.origin === "citation") score += 15;

    if (score > bestScore) {
      bestScore = score;
      best = source;
    }
  }

  // 有 source_url 時要求同網址/同主站可對應；沒有有效網址時，
  // 只允許賣場名稱或來源標題明確對上的 citation。
  const threshold = rawUrl ? 400 : 110;
  return bestScore >= threshold ? best : null;
}

function merchantTokens(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/購物網|購物中心|線上購物|線上|商城|台灣|臺灣|官方/g, " ")
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map((x) => normalizeForMatch(x))
    .filter((x) => x.length >= 2);
}

function pathSimilarityScore(a, b) {
  try {
    const pa = new URL(a).pathname.split("/").filter(Boolean);
    const pb = new URL(b).pathname.split("/").filter(Boolean);
    if (!pa.length || !pb.length) return 0;

    let common = 0;
    const limit = Math.min(pa.length, pb.length);
    for (let i = 0; i < limit; i++) {
      if (pa[i] !== pb[i]) break;
      common++;
    }

    return Math.min(120, common * 30);
  } catch {
    return 0;
  }
}

function sanitizeSpecs(specs) {
  const out = {};

  if (Array.isArray(specs)) {
    for (const item of specs) {
      const label = cleanText(item?.label).slice(0, 24);
      const value = cleanText(item?.value).slice(0, 80);
      if (label && value && value !== "未知" && value !== "N/A") {
        out[label] = value;
      }
    }
  } else if (specs && typeof specs === "object") {
    for (const [key, value] of Object.entries(specs)) {
      const label = cleanText(key).slice(0, 24);
      const val = cleanText(value).slice(0, 80);
      if (label && val && val !== "未知" && val !== "N/A") {
        out[label] = val;
      }
    }
  }

  return out;
}

function extractUsage(interaction, searchMeta) {
  const usage =
    interaction?.usage ||
    interaction?.metadata?.total_usage ||
    {};

  const inputTokens = Number(usage.total_input_tokens || 0);
  const outputTokens = Number(usage.total_output_tokens || 0);
  const thoughtTokens = Number(usage.total_thought_tokens || 0);
  const toolUseTokens = Number(usage.total_tool_use_tokens || 0);
  const totalTokens = Number(usage.total_tokens || 0);

  let groundingRequests = 0;
  if (Array.isArray(usage.grounding_tool_count)) {
    for (const item of usage.grounding_tool_count) {
      if (String(item?.type || "").toLowerCase() === "google_search") {
        groundingRequests += Number(item?.count || 0);
      }
    }
  }

  groundingRequests = Math.max(
    groundingRequests,
    Array.isArray(searchMeta?.queries) ? searchMeta.queries.length : 0
  );

  const estimatedTokenCostUsd =
    ((inputTokens + toolUseTokens) / 1_000_000) * INPUT_USD_PER_MILLION_TOKENS +
    ((outputTokens + thoughtTokens) / 1_000_000) * OUTPUT_USD_PER_MILLION_TOKENS;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    thought_tokens: thoughtTokens,
    tool_use_tokens: toolUseTokens,
    total_tokens: totalTokens,
    google_search_requests: groundingRequests,
    estimated_token_cost_usd: Number(estimatedTokenCostUsd.toFixed(8)),
    pricing: {
      input_usd_per_million_tokens: INPUT_USD_PER_MILLION_TOKENS,
      output_usd_per_million_tokens: OUTPUT_USD_PER_MILLION_TOKENS,
      monthly_free_google_search_requests: MONTHLY_FREE_GOOGLE_SEARCH_REQUESTS,
      google_search_usd_per_request_after_free:
        GOOGLE_SEARCH_USD_PER_REQUEST_AFTER_FREE
    }
  };
}

function buildDimensions(products) {
  const map = new Map();

  for (const product of products) {
    for (const [label, value] of Object.entries(product.specs || {})) {
      if (!map.has(label)) map.set(label, new Set());
      map.get(label).add(String(value));
    }
  }

  const preferred = [
    "容量", "儲存空間", "顏色", "尺寸", "層數",
    "抽數", "包數", "入數", "版本", "記憶體", "連線版本"
  ];

  return [...map.entries()]
    .map(([label, values]) => ({
      key: label,
      label,
      values: [...values].sort(naturalSort)
    }))
    .sort((a, b) => {
      const ai = preferred.indexOf(a.label);
      const bi = preferred.indexOf(b.label);
      if (ai === -1 && bi === -1) return a.label.localeCompare(b.label, "zh-Hant");
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
}

function naturalSort(a, b) {
  return String(a).localeCompare(String(b), "zh-Hant", { numeric: true });
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini 回傳不是有效 JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeHttpUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function urlHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function siteRoot(host) {
  const value = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!value) return "";

  const parts = value.split(".").filter(Boolean);
  if (parts.length <= 2) return value;

  const twoLevelSuffixes = new Set([
    "com.tw", "net.tw", "org.tw", "idv.tw",
    "co.uk", "com.hk", "com.cn", "com.au", "co.jp"
  ]);

  const suffix2 = parts.slice(-2).join(".");
  if (twoLevelSuffixes.has(suffix2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }

  return parts.slice(-2).join(".");
}

function canonicalUrlKey(value) {
  try {
    const u = new URL(String(value || "").trim());
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !/^utm_|^(gclid|fbclid|ref|source)$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));

    const query = new URLSearchParams(params).toString();
    return host + path + (query ? "?" + query : "");
  } catch {
    return "";
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function normalizeKey(value) {
  return normalizeForMatch(value);
}

function simpleHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cleanupCache() {
  const now = Date.now();
  for (const [key, entry] of SEARCH_CACHE.entries()) {
    if (now - entry.savedAt > SEARCH_CACHE_TTL_MS) SEARCH_CACHE.delete(key);
  }

  if (SEARCH_CACHE.size > 80) {
    const oldest = [...SEARCH_CACHE.entries()]
      .sort((a, b) => a[1].savedAt - b[1].savedAt)
      .slice(0, SEARCH_CACHE.size - 80);

    for (const [key] of oldest) SEARCH_CACHE.delete(key);
  }
}

async function fetchWithTimeout(input, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Gemini Google Search 查詢逾時");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 500);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type"
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(),
      "cache-control": "no-store"
    }
  });
}
