const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 50000;
const STRUCTURE_TIMEOUT_MS = 20000;

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
          source_id: { type: "string" },
          store: { type: "string" },
          title: { type: "string" },
          price: { type: "number" },
          currency: { type: "string" },
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
          "source_id",
          "store",
          "title",
          "price",
          "currency",
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
        mode: "generate-content-google-search-grounding",
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
    const keyword = cleanText(body?.keyword);

    if (!keyword) return json({ error: "請輸入商品關鍵字" }, 400);

    const cacheKey = normalizeForMatch(keyword);
    const cached = SEARCH_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < SEARCH_CACHE_TTL_MS) {
      return json({ ...cached.payload, cache_hit: true });
    }

    const model = String(env.GEMINI_MODEL || "gemini-3.6-flash").trim();

    // 第一段：只負責 Google Search grounding，直接從 groundingMetadata 取得來源。
    const discovery = await runGroundedDiscovery(keyword, model, env.GEMINI_API_KEY);
    const grounded = extractGenerateContentGrounding(discovery);

    if (!grounded.sources.length) {
      const payload = {
        keyword,
        summary: grounded.text || "",
        products: [],
        items: [],
        dimensions: [],
        sources: [],
        search_queries: grounded.queries,
        source_count: 0,
        updated_at: new Date().toISOString(),
        cache_hit: false,
        model,
        mode: "generate-content-google-search-grounding",
        usage: combineUsage(
          parseGenerateContentUsage(discovery),
          emptyUsage(),
          grounded.queries.length
        ),
        verification: {
          candidate_products: 0,
          verified_products: 0,
          citation_sources: 0,
          search_queries: grounded.queries.length
        }
      };

      SEARCH_CACHE.set(cacheKey, { savedAt: Date.now(), payload });
      cleanupCache();
      return json(payload);
    }

    // 第二段：不再上網，只把第一段已 grounded 的文字與來源整理成固定 JSON。
    const structuredResponse = await runProductStructuring(
      keyword,
      grounded,
      model,
      env.GEMINI_API_KEY
    );

    const structuredText = extractGenerateContentText(structuredResponse);
    const parsed = parseJson(structuredText);

    const products = normalizeStructuredProducts(
      parsed?.products || [],
      grounded.sources
    )
      .sort((a, b) => a.price - b.price)
      .slice(0, 30);

    const usage = combineUsage(
      parseGenerateContentUsage(discovery),
      parseGenerateContentUsage(structuredResponse),
      grounded.queries.length
    );

    const payload = {
      keyword,
      summary: cleanText(parsed?.summary) || grounded.text.slice(0, 500),
      products,
      items: products,
      dimensions: buildDimensions(products),
      sources: grounded.sources,
      search_queries: grounded.queries,
      source_count: grounded.sources.length,
      updated_at: new Date().toISOString(),
      cache_hit: false,
      model,
      mode: "generate-content-google-search-grounding",
      usage,
      verification: {
        candidate_products: Array.isArray(parsed?.products) ? parsed.products.length : 0,
        verified_products: products.length,
        citation_sources: grounded.sources.length,
        search_queries: grounded.queries.length
      }
    };

    SEARCH_CACHE.set(cacheKey, { savedAt: Date.now(), payload });
    cleanupCache();
    return json(payload);
  } catch (error) {
    return json({ error: cleanError(error) }, 500);
  }
}

async function runGroundedDiscovery(keyword, model, apiKey) {
  const prompt = [
    "你是一個台灣線上購物即時比價研究助手。",
    `搜尋商品：${keyword}`,
    "",
    "請務必使用 Google Search 取得目前可查到的台灣網路商品與售價。",
    "不要限制特定商城，但優先實際可購買的商城、品牌官網、量販店與大型電商。",
    "請找 6~12 筆高品質結果即可，不需要大量重複搜尋。",
    "每個價格都要由搜尋到的網頁支持，不得依記憶猜價。",
    "排除新聞、論壇、二手、配件、價格比較文章本身。",
    "同一商品若規格不同，請清楚寫出規格，例如容量、顏色、層數、抽數、包數、尺寸。",
    "請用精簡條列整理，每筆至少包含：賣場、商品名稱、售價、可辨識規格。",
    "若能計算單位價格再列出，不能可靠換算就省略。",
    "請在回答中引用來源。"
  ].join("\n");

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }]
      })
    },
    DISCOVERY_TIMEOUT_MS
  );

  const text = await response.text();

  if (!response.ok) {
    throwFriendlyGeminiError(response.status, text);
  }

  return JSON.parse(text);
}

async function runProductStructuring(keyword, grounded, model, apiKey) {
  const sourceRows = grounded.sources.slice(0, 30).map((source) => ({
    source_id: source.id,
    title: source.title,
    url: source.url,
    evidence: source.evidence.slice(0, 900)
  }));

  const prompt = [
    "你是商品資料整理器。禁止上網、禁止自行新增價格或網址。",
    `使用者搜尋：${keyword}`,
    "",
    "下面是已經由 Google Search grounding 得到的文字：",
    grounded.text.slice(0, 14000),
    "",
    "下面是可使用的來源清單：",
    JSON.stringify(sourceRows),
    "",
    "規則：",
    "1. 只整理 grounded 文字中確實出現、且有明確價格的商品。",
    "2. 每筆商品的 source_id 必須從上面來源清單挑一個，不能自創。",
    "3. source_id 應選擇其 evidence 或標題最能支持該商品與價格的來源。",
    "4. 不確定來源對應時，該商品不要輸出。",
    "5. 排除二手、配件、新聞、論壇與不同主商品。",
    "6. specs 依商品種類動態整理，例如衛生紙：層數/抽數/包數；手機：容量/顏色。",
    "7. unit_price_text 無法可靠計算就填空字串。",
    "8. 台灣價格 currency 填 TWD。",
    "9. 不要把搜尋摘要中的估價或價格區間當成單一商品價格。",
    "",
    "請依 schema 回傳 JSON。"
  ].join("\n");

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseFormat: {
            text: {
              mimeType: "application/json",
              schema: PRODUCT_SCHEMA
            }
          }
        }
      })
    },
    STRUCTURE_TIMEOUT_MS
  );

  const text = await response.text();

  if (!response.ok) {
    throwFriendlyGeminiError(response.status, text);
  }

  return JSON.parse(text);
}

function extractGenerateContentGrounding(data) {
  const candidate = data?.candidates?.[0] || {};
  const metadata =
    candidate?.groundingMetadata ||
    candidate?.grounding_metadata ||
    {};

  const text = extractGenerateContentText(data);
  const chunks =
    metadata?.groundingChunks ||
    metadata?.grounding_chunks ||
    [];
  const supports =
    metadata?.groundingSupports ||
    metadata?.grounding_supports ||
    [];
  const queries =
    metadata?.webSearchQueries ||
    metadata?.web_search_queries ||
    [];

  const sources = chunks
    .map((chunk, index) => {
      const web = chunk?.web || {};
      const url = normalizeHttpUrl(web?.uri || web?.url);
      if (!url) return null;

      return {
        id: `S${index + 1}`,
        title: cleanText(web?.title) || hostLabel(url),
        url,
        snippet: "",
        evidence: ""
      };
    })
    .filter(Boolean);

  const byChunkIndex = new Map();
  sources.forEach((source) => {
    const chunkIndex = Number(source.id.slice(1)) - 1;
    byChunkIndex.set(chunkIndex, source);
  });

  for (const support of supports) {
    const indices =
      support?.groundingChunkIndices ||
      support?.grounding_chunk_indices ||
      [];

    const segment =
      cleanText(support?.segment?.text) ||
      sliceByIndices(
        text,
        support?.segment?.startIndex ?? support?.segment?.start_index,
        support?.segment?.endIndex ?? support?.segment?.end_index
      );

    if (!segment) continue;

    for (const index of indices) {
      const source = byChunkIndex.get(Number(index));
      if (!source) continue;

      source.evidence = cleanText(
        [source.evidence, segment].filter(Boolean).join(" | ")
      ).slice(0, 1800);

      if (!source.snippet) source.snippet = segment.slice(0, 300);
    }
  }

  return {
    text,
    queries: [...new Set((Array.isArray(queries) ? queries : []).map(cleanText).filter(Boolean))],
    sources: dedupeSources(sources)
  };
}

function extractGenerateContentText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";

  return parts
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeStructuredProducts(products, sources) {
  const sourceMap = new Map(
    sources.map((source) => [String(source.id), source])
  );

  const seen = new Set();
  const out = [];

  for (const raw of Array.isArray(products) ? products : []) {
    const source = sourceMap.get(String(raw?.source_id || ""));
    if (!source) continue;

    const price = Number(raw?.price);
    if (!Number.isFinite(price) || price <= 0 || price > 10000000) continue;

    const title = cleanText(raw?.title);
    const store = cleanText(raw?.store);
    if (!title || !store) continue;

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
      url: source.url,
      source_url: source.url,
      source_title: source.title,
      source_origin: "google_grounding_chunk",
      unit_price_text: cleanText(raw?.unit_price_text),
      specs,
      specs_list: Object.entries(specs).map(([label, value]) => ({ label, value }))
    });
  }

  return out;
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
  }

  return out;
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
      values: [...values].sort((a, b) =>
        String(a).localeCompare(String(b), "zh-Hant", { numeric: true })
      )
    }))
    .sort((a, b) => {
      const ai = preferred.indexOf(a.label);
      const bi = preferred.indexOf(b.label);

      if (ai === -1 && bi === -1) {
        return a.label.localeCompare(b.label, "zh-Hant");
      }
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
}

function parseGenerateContentUsage(data) {
  const u = data?.usageMetadata || data?.usage_metadata || {};

  return {
    input_tokens: Number(u.promptTokenCount ?? u.prompt_token_count ?? 0),
    output_tokens: Number(u.candidatesTokenCount ?? u.candidates_token_count ?? 0),
    thought_tokens: Number(u.thoughtsTokenCount ?? u.thoughts_token_count ?? 0),
    tool_use_tokens: Number(u.toolUsePromptTokenCount ?? u.tool_use_prompt_token_count ?? 0),
    total_tokens: Number(u.totalTokenCount ?? u.total_token_count ?? 0)
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    thought_tokens: 0,
    tool_use_tokens: 0,
    total_tokens: 0
  };
}

function combineUsage(a, b, groundingRequests) {
  const inputTokens =
    Number(a?.input_tokens || 0) +
    Number(b?.input_tokens || 0);

  const outputTokens =
    Number(a?.output_tokens || 0) +
    Number(b?.output_tokens || 0);

  const thoughtTokens =
    Number(a?.thought_tokens || 0) +
    Number(b?.thought_tokens || 0);

  const toolUseTokens =
    Number(a?.tool_use_tokens || 0) +
    Number(b?.tool_use_tokens || 0);

  const totalTokens =
    Number(a?.total_tokens || 0) +
    Number(b?.total_tokens || 0);

  const estimatedTokenCostUsd =
    ((inputTokens + toolUseTokens) / 1000000) * INPUT_USD_PER_MILLION_TOKENS +
    ((outputTokens + thoughtTokens) / 1000000) * OUTPUT_USD_PER_MILLION_TOKENS;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    thought_tokens: thoughtTokens,
    tool_use_tokens: toolUseTokens,
    total_tokens: totalTokens,
    google_search_requests: Number(groundingRequests || 0),
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

function dedupeSources(sources) {
  const seen = new Map();

  for (const source of sources) {
    const key = canonicalUrlKey(source.url);
    if (!key) continue;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...source });
      continue;
    }

    existing.evidence = cleanText(
      [existing.evidence, source.evidence].filter(Boolean).join(" | ")
    ).slice(0, 1800);

    if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
    if (!existing.title && source.title) existing.title = source.title;
  }

  return [...seen.values()].map((source, index) => ({
    ...source,
    id: `S${index + 1}`
  }));
}

function sliceByIndices(text, start, end) {
  const s = Number(start);
  const e = Number(end);

  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return "";
  return cleanText(String(text || "").slice(s, e));
}

function normalizeHttpUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function canonicalUrlKey(value) {
  try {
    const u = new URL(String(value || "").trim());
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return host + path;
  } catch {
    return "";
  }
}

function hostLabel(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini 商品整理結果不是有效 JSON");
    return JSON.parse(match[0]);
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
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
    if (now - entry.savedAt > SEARCH_CACHE_TTL_MS) {
      SEARCH_CACHE.delete(key);
    }
  }

  if (SEARCH_CACHE.size > 80) {
    const oldest = [...SEARCH_CACHE.entries()]
      .sort((a, b) => a[1].savedAt - b[1].savedAt)
      .slice(0, SEARCH_CACHE.size - 80);

    for (const [key] of oldest) SEARCH_CACHE.delete(key);
  }
}

async function fetchWithTimeout(input, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Gemini Google Search 查詢逾時");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function throwFriendlyGeminiError(status, text) {
  const lower = String(text || "").toLowerCase();

  if (
    status === 429 &&
    (
      lower.includes("quota") ||
      lower.includes("billing") ||
      lower.includes("exceeded your current quota")
    )
  ) {
    throw new Error(
      "Google Search Grounding 配額不足：請確認 Gemini API 專案已啟用 Paid Tier / Billing。"
    );
  }

  if (status === 429) {
    throw new Error("Gemini 暫時達到速率限制，請稍後再搜尋。");
  }

  throw new Error(
    `Gemini HTTP ${status}: ${String(text || "").slice(0, 260)}`
  );
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
