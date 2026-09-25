const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const LLM_TIMEOUT_MS = 8000;
const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source_id: { type: "string" },
          canonical_name: { type: "string" },
          is_target_match: { type: "boolean" },
          specs: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { type: "string" } },
              required: ["label", "value"],
              additionalProperties: false
            }
          }
        },
        required: ["source_id", "canonical_name", "is_target_match", "specs"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "products"],
  additionalProperties: false
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
        serpapi: Boolean(env.SERPAPI_API_KEY),
        groq: Boolean(env.GROQ_API_KEY),
        gemini: Boolean(env.GEMINI_API_KEY),
        mode: "serpapi-google-shopping-with-groq-gemini-fallback",
        groq_model: getGroqModel(env),
        gemini_model: env.GEMINI_MODEL || "gemini-3.6-flash"
      });
    }
    if (url.pathname === "/api/search") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return search(request, env);
    }
    return new Response("Shopping compare API");
  }
};

async function search(request, env) {
  try {
    if (!env.SERPAPI_API_KEY) throw new Error("後端尚未設定 SERPAPI_API_KEY");
    if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
      throw new Error("後端至少需設定 GROQ_API_KEY 或 GEMINI_API_KEY");
    }
    const keyword = clean((await request.json()).keyword);
    if (!keyword) return json({ error: "請輸入商品關鍵字" }, 400);
    const cacheKey = normalize(keyword);
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      return json({ ...cached.payload, cache_hit: true });
    }
    const candidates = await shoppingSearch(keyword, env.SERPAPI_API_KEY);
    const parsed = candidates.length
      ? await parseProducts(keyword, candidates, env)
      : { data: { summary: "", products: [] }, provider: "無", model: "無", fallback: false };
    const products = merge(candidates, parsed.data.products).sort((a, b) => a.price - b.price);
    const payload = makePayload(keyword, candidates, products, parsed);
    CACHE.set(cacheKey, { time: Date.now(), payload });
    cleanupCache();
    return json(payload);
  } catch (error) {
    return json({ error: cleanError(error) }, 500);
  }
}

function makePayload(keyword, candidates, products, parsed) {
  return {
    keyword,
    summary: clean(parsed.data.summary) || (candidates.length
      ? "已從 Google Shopping 整理 " + products.length + " 筆商品。"
      : "Google Shopping 沒有回傳可用的商品價格。"),
    products,
    items: products,
    dimensions: dimensions(products),
    sources: candidates.map((item) => ({
      id: item.source_id,
      title: item.source_title || item.store_name,
      url: item.source_url
    })),
    source_count: candidates.length,
    updated_at: new Date().toISOString(),
    cache_hit: false,
    model: parsed.model,
    parser: parsed.provider,
    mode: "serpapi-google-shopping-with-llm-normalization",
    usage: {
      serpapi_searches: 1,
      llm_provider: parsed.provider,
      fallback_used: parsed.fallback
    },
    verification: {
      candidate_products: candidates.length,
      verified_products: products.length,
      citation_sources: candidates.length
    }
  };
}

async function shoppingSearch(keyword, apiKey) {
  const query = new URLSearchParams({
    engine: "google_shopping",
    q: keyword,
    gl: "tw",
    hl: "zh-TW",
    api_key: apiKey,
    no_cache: "false"
  });
  const response = await timedFetch(
    "https://serpapi.com/search.json?" + query,
    {},
    20000,
    "SerpAPI Google Shopping 查詢逾時"
  );
  const text = await response.text();
  if (!response.ok) throw new Error("SerpAPI HTTP " + response.status + ": " + text.slice(0, 240));
  const data = JSON.parse(text);
  if (data.error) throw new Error("SerpAPI：" + clean(data.error));

  const seen = new Set();
  return (Array.isArray(data.shopping_results) ? data.shopping_results : [])
    .map((row, index) => {
      const price = priceNumber(row.extracted_price || row.price);
      const url = httpUrl(row.link || row.product_link);
      const title = clean(row.title);
      const store = clean(row.source || row.merchant || host(url));
      if (!title || !url || !store || !Number.isFinite(price) || price <= 0) return null;
      const key = urlKey(url) + "|" + price;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        source_id: "S" + (index + 1),
        source_title: title,
        source_url: url,
        store_name: store,
        title,
        price,
        currency: clean(row.currency) || "TWD",
        unit_price_text: clean((row.extensions || []).find((value) => new RegExp("每|/", "i").test(value))),
        hints: (row.extensions || []).slice(0, 8)
      };
    })
    .filter(Boolean)
    .slice(0, 30);
}

async function parseProducts(keyword, candidates, env) {
  const rows = candidates.map((item) => ({
    source_id: item.source_id,
    store: item.store_name,
    title: item.title,
    price: item.price,
    currency: item.currency,
    hints: item.hints
  }));
  const prompt = [
    "你是電商商品資料整理器。只能使用下面 JSON 商品列，禁止上網，禁止改寫 price、currency、store 或自行新增商品。",
    "使用者搜尋：" + keyword,
    "請判斷是否為主商品、整理 canonical_name 與可辨識規格。配件、二手、不同商品設 is_target_match=false。",
    "規格可為容量、顏色、層數、抽數、包數、尺寸等；無法確認時 specs 為空陣列。",
    "商品列：" + JSON.stringify(rows)
  ].join("\\n");

  if (env.GROQ_API_KEY) {
    try {
      return {
        data: await groq(prompt, env.GROQ_API_KEY, getGroqModel(env)),
        provider: "Groq",
        model: getGroqModel(env),
        fallback: false
      };
    } catch (error) {
      if (!shouldUseGemini(error) || !env.GEMINI_API_KEY) {
        return {
          data: ruleBasedProducts(keyword, candidates),
          provider: "規則備援",
          model: "Groq 暫時無回應",
          fallback: true
        };
      }
    }
  }
  if (!env.GEMINI_API_KEY) throw new Error("Groq 無法使用，且未設定 GEMINI_API_KEY 備援");
  try {
    return {
      data: await gemini(prompt, env.GEMINI_API_KEY, env.GEMINI_MODEL || "gemini-3.6-flash"),
      provider: "Gemini",
      model: env.GEMINI_MODEL || "gemini-3.6-flash",
      fallback: Boolean(env.GROQ_API_KEY)
    };
  } catch {
    return {
      data: ruleBasedProducts(keyword, candidates),
      provider: "規則備援",
      model: "不使用模型",
      fallback: true
    };
  }
}

async function groq(prompt, apiKey, model) {
  const response = await timedFetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "輸出必須符合指定 JSON Schema。" },
          { role: "user", content: prompt }
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "shopping_products", strict: true, schema: SCHEMA }
        }
      })
    },
    LLM_TIMEOUT_MS,
    "Groq 商品解析逾時"
  );
  const text = await response.text();
  if (!response.ok) throw new Error("Groq HTTP " + response.status + ": " + text.slice(0, 240));
  return jsonParse(JSON.parse(text).choices?.[0]?.message?.content);
}

async function gemini(prompt, apiKey, model) {
  const response = await timedFetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseJsonSchema: SCHEMA
        }
      })
    },
    LLM_TIMEOUT_MS,
    "Gemini 商品解析逾時"
  );
  const text = await response.text();
  if (!response.ok) throw new Error("Gemini HTTP " + response.status + ": " + text.slice(0, 240));
  const parts = JSON.parse(text).candidates?.[0]?.content?.parts || [];
  return jsonParse(parts.map((part) => part.text || "").join(""));
}

function merge(candidates, structured) {
  const sourceMap = new Map(candidates.map((item) => [item.source_id, item]));
  const seen = new Set();
  return (Array.isArray(structured) ? structured : []).map((item) => {
    const source = sourceMap.get(clean(item?.source_id));
    if (!source || item?.is_target_match !== true) return null;
    const specs = cleanSpecs(item.specs);
    const key = urlKey(source.source_url) + "|" + source.price + "|" + JSON.stringify(specs);
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      id: hash(key),
      store_id: hash(source.store_name),
      store_name: source.store_name,
      store: source.store_name,
      title: source.title,
      canonical_name: clean(item.canonical_name) || source.title,
      price: source.price,
      currency: source.currency.toUpperCase(),
      url: source.source_url,
      source_url: source.source_url,
      source_title: source.source_title,
      source_origin: "serpapi_google_shopping",
      unit_price_text: source.unit_price_text,
      specs,
      specs_list: Object.entries(specs).map(([label, value]) => ({ label, value }))
    };
  }).filter(Boolean);
}

function cleanSpecs(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const label = clean(item?.label).slice(0, 24);
    const value = clean(item?.value).slice(0, 80);
    if (label && value && value !== "未知") out[label] = value;
  }
  return out;
}

function ruleBasedProducts(keyword, candidates) {
  const excluded = /二手|中古|配件|保護殼|保護貼|充電線|支架|替換|維修/;
  const products = candidates.map((candidate) => ({
    source_id: candidate.source_id,
    canonical_name: candidate.title,
    is_target_match: !excluded.test(candidate.title),
    specs: []
  }));
  return {
    summary: "AI 解析服務暫時無回應，以下保留 Google Shopping 已提供價格與連結的商品。",
    products
  };
}

function shouldUseGemini(error) {
  const message = cleanError(error).toLowerCase();
  return message.includes("http 429") ||
    message.includes("quota") ||
    message.includes("billing") ||
    message.includes("rate limit");
}

function dimensions(products) {
  const map = new Map();
  for (const product of products) {
    for (const [label, value] of Object.entries(product.specs || {})) {
      if (!map.has(label)) map.set(label, new Set());
      map.get(label).add(String(value));
    }
  }
  return [...map.entries()].map(([label, values]) => ({
    key: label,
    label,
    values: [...values].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }))
  }));
}

function priceNumber(value) {
  const match = String(value ?? "").split(",").join("").match(/[0-9]+(?:[.][0-9]+)?/);
  return match ? Number(match[0]) : NaN;
}

function jsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\\{[\\s\\S]*\\}/);
    if (!match) throw new Error("模型商品整理結果不是有效 JSON");
    return JSON.parse(match[0]);
  }
}

function clean(value) {
  return String(value ?? "").split(/\s+/).join(" ").trim();
}

function getGroqModel(env) {
  const configured = clean(env.GROQ_MODEL);
  return configured.includes("/") ? configured : "openai/gpt-oss-20b";
}

function normalize(value) {
  return clean(value).toLowerCase().replace(new RegExp("[^a-z0-9\\u4e00-\\u9fff]+", "g"), "");
}

function httpUrl(value) {
  try {
    const url = new URL(clean(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function urlKey(value) {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase().replace("www.", "") +
      (url.pathname.replace(new RegExp("/+$"), "") || "/");
  } catch {
    return "";
  }
}

function host(value) {
  try {
    return new URL(value).hostname.replace("www.", "");
  } catch {
    return "";
  }
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || "")) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function cleanupCache() {
  const now = Date.now();
  for (const [key, entry] of CACHE.entries()) {
    if (now - entry.time > CACHE_TTL) CACHE.delete(key);
  }
}

async function timedFetch(input, options, timeout, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
    headers: { ...JSON_HEADERS, ...corsHeaders(), "cache-control": "no-store" }
  });
}
