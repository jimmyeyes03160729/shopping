const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const SOURCE_LABELS = {
  pchome: "PChome 24h",
  momo: "momo購物網",
  shopee: "蝦皮購物",
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
        model: env.GEMINI_MODEL || "gemini-3.8-flash",
        fallback_models: ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
      });
    }

    if (url.pathname === "/api/search") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleSearch(request, env);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Shopping compare API", { status: 200 });
  },
};

async function handleSearch(request, env) {
  try {
    const body = await request.json();
    const keyword = String(body.keyword || "").trim();
    const requestedSources = Array.isArray(body.sources)
      ? body.sources.filter((x) => SOURCE_LABELS[x])
      : Object.keys(SOURCE_LABELS);

    if (!keyword) return json({ error: "請輸入商品關鍵字" }, 400);
    if (!requestedSources.length) return json({ error: "至少選擇一個商城" }, 400);
    if (!env.GEMINI_API_KEY) return json({ error: "後端尚未設定 GEMINI_API_KEY" }, 500);

    const jobs = requestedSources.map(async (source) => {
      try {
        const items =
          source === "pchome"
            ? await searchPchome(keyword)
            : source === "momo"
              ? await searchMomo(keyword)
              : await searchShopee(keyword);
        return { source, ok: true, items };
      } catch (error) {
        return { source, ok: false, items: [], error: cleanError(error) };
      }
    });

    const sourceResults = await Promise.all(jobs);
    let rawItems = sourceResults.flatMap((x) => x.items);

    rawItems = dedupeRawItems(rawItems)
      .filter((x) => Number.isFinite(x.price) && x.price > 0 && x.title)
      .slice(0, 72);

    if (!rawItems.length) {
      return json({
        keyword,
        items: [],
        dimensions: [],
        sources: sourceResults.map(sourceStatus),
        message: "目前沒有取得可驗證的商城商品資料。",
      });
    }

    const normalized = await normalizeSpecsWithGemini(keyword, rawItems, env);
    const normalizedMap = new Map(normalized.map((x) => [String(x.id), x]));

    const items = rawItems
      .map((raw) => {
        const ai = normalizedMap.get(raw.id);
        if (!ai || ai.match === false) return null;
        return {
          id: raw.id,
          store_id: raw.store_id,
          store_name: raw.store_name,
          title: raw.title,
          canonical_name: String(ai.canonical_name || raw.title),
          price: raw.price,
          currency: "TWD",
          url: raw.url,
          specs: sanitizeSpecs(ai.specs),
          fetched_at: new Date().toISOString(),
        };
      })
      .filter(Boolean);

    const dimensions = buildDimensions(items);

    return json({
      keyword,
      items,
      dimensions,
      sources: sourceResults.map(sourceStatus),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return json({ error: cleanError(error) }, 500);
  }
}

function sourceStatus(result) {
  return {
    id: result.source,
    name: SOURCE_LABELS[result.source],
    ok: result.ok,
    count: result.items.length,
    error: result.ok ? null : result.error,
  };
}

async function searchPchome(keyword) {
  const endpoint = new URL("https://ecshweb.pchome.com.tw/search/v3.3/all/results");
  endpoint.searchParams.set("q", keyword);
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("sort", "rnk/dc");

  const response = await fetch(endpoint, {
    headers: browserHeaders("https://24h.pchome.com.tw/"),
  });
  if (!response.ok) throw new Error(`PChome HTTP ${response.status}`);

  const data = await response.json();
  const products = Array.isArray(data.prods) ? data.prods : [];

  return products.slice(0, 24).map((p, index) => {
    const productId = String(p.Id || p.id || "");
    return {
      id: `pchome-${productId || index}`,
      store_id: "pchome",
      store_name: SOURCE_LABELS.pchome,
      title: String(p.name || ""),
      price: parsePrice(p.price),
      url: productId
        ? `https://24h.pchome.com.tw/prod/${encodeURIComponent(productId)}`
        : `https://24h.pchome.com.tw/search/?q=${encodeURIComponent(keyword)}`,
    };
  });
}

async function searchMomo(keyword) {
  const endpoint = "https://apisearch.momoshop.com.tw/momoSearchCloud/moec/textSearch";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...browserHeaders("https://www.momoshop.com.tw/"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      host: "momoshop",
      flag: "searchEngine",
      data: {
        searchValue: keyword,
        curPage: "1",
        priceS: "0",
        priceE: "9999999",
        searchType: "1",
      },
    }),
  });

  if (!response.ok) throw new Error(`momo HTTP ${response.status}`);
  const data = await response.json();
  const products = data?.rtnSearchData?.goodsInfoList || [];

  return products.slice(0, 24).map((p, index) => {
    const code = String(
      p.goodsCode || p.goodsNo || p.i_code || p.goodsId || p.goodsID || ""
    );
    return {
      id: `momo-${code || index}`,
      store_id: "momo",
      store_name: SOURCE_LABELS.momo,
      title: String(p.goodsName || p.name || ""),
      price: parsePrice(p.goodsPrice ?? p.salePrice ?? p.price),
      url: code
        ? `https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=${encodeURIComponent(code)}`
        : `https://www.momoshop.com.tw/search/searchShop.jsp?keyword=${encodeURIComponent(keyword)}`,
    };
  });
}

async function searchShopee(keyword) {
  const endpoint = new URL("https://shopee.tw/api/v4/search/search_items");
  endpoint.searchParams.set("by", "relevancy");
  endpoint.searchParams.set("keyword", keyword);
  endpoint.searchParams.set("limit", "24");
  endpoint.searchParams.set("newest", "0");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("page_type", "search");
  endpoint.searchParams.set("scenario", "PAGE_GLOBAL_SEARCH");
  endpoint.searchParams.set("version", "2");

  const response = await fetch(endpoint, {
    headers: {
      ...browserHeaders(`https://shopee.tw/search?keyword=${encodeURIComponent(keyword)}`),
      "x-api-source": "pc",
      "x-requested-with": "XMLHttpRequest",
    },
  });

  if (!response.ok) throw new Error(`Shopee HTTP ${response.status}`);
  const data = await response.json();
  const rows = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.data?.items)
      ? data.data.items
      : [];

  return rows.slice(0, 24).map((row, index) => {
    const p = row.item_basic || row;
    const itemId = String(p.itemid || p.item_id || "");
    const shopId = String(p.shopid || p.shop_id || "");
    const rawPrice = p.price_min ?? p.price ?? p.price_max;
    const price = normalizeShopeePrice(rawPrice);

    return {
      id: `shopee-${shopId || "s"}-${itemId || index}`,
      store_id: "shopee",
      store_name: SOURCE_LABELS.shopee,
      title: String(p.name || ""),
      price,
      url:
        itemId && shopId
          ? `https://shopee.tw/product/${encodeURIComponent(shopId)}/${encodeURIComponent(itemId)}`
          : `https://shopee.tw/search?keyword=${encodeURIComponent(keyword)}`,
    };
  });
}

async function normalizeSpecsWithGemini(keyword, rawItems, env) {
  const primaryModel = env.GEMINI_MODEL || "gemini-3.8-flash";
  const modelCandidates = [
    primaryModel,
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
  ].filter((model, index, arr) => model && arr.indexOf(model) === index);

  const prompt = [
    "你是商品規格正規化引擎。你不能提供、猜測或修改價格與網址。",
    `使用者搜尋主商品：「${keyword}」`,
    "請只根據每筆商品的 title 判斷它是否為主商品本體，排除保護殼、貼膜、充電器、配件、二手零件等不相關商品。",
    "對符合的商品，整理 canonical_name 與 specs。",
    "specs 必須是動態物件，鍵名使用繁體中文、短且一致，例如：容量、顏色、尺寸、版本、記憶體、儲存空間、連線版本。",
    "容量值請統一格式，例如 256GB、512GB、1TB；同義顏色請盡量統一，但不要憑空猜測沒有出現在標題中的規格。",
    "未知規格不要填入。絕對不要新增輸入中不存在的商品。",
    "回傳 JSON 物件，格式必須是：",
    '{"items":[{"id":"輸入id","match":true,"canonical_name":"標準商品名","specs":{"容量":"256GB","顏色":"黑色"}}]}',
    "輸入商品：",
    JSON.stringify(
      rawItems.map((x) => ({
        id: x.id,
        store: x.store_name,
        title: x.title,
      }))
    ),
  ].join("\n");

  let lastError = null;

  for (const model of modelCandidates) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response;
      try {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
              },
            }),
          }
        );
      } catch (error) {
        lastError = new Error(`Gemini ${model} network error: ${cleanError(error)}`);
        if (attempt < 2) {
          await sleep(900 * attempt);
          continue;
        }
        break;
      }

      if (response.ok) {
        const data = await response.json();
        const text =
          data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

        if (!text) {
          lastError = new Error(`Gemini ${model} 沒有回傳規格分析結果`);
          break;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) {
            lastError = new Error(`Gemini ${model} 回傳不是有效 JSON`);
            break;
          }
          parsed = JSON.parse(match[0]);
        }

        return Array.isArray(parsed?.items) ? parsed.items : [];
      }

      const detail = await response.text();
      lastError = new Error(
        `Gemini ${model} HTTP ${response.status}: ${detail.slice(0, 180)}`
      );

      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (retryable && attempt < 2) {
        await sleep(1200 * attempt);
        continue;
      }

      // 429/5xx：換下一個備援模型；404 等也換下一個，避免單一模型失效拖垮搜尋。
      break;
    }
  }

  throw lastError || new Error("所有 Gemini 備援模型皆無法使用");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDimensions(items) {
  const map = new Map();
  for (const item of items) {
    for (const [label, value] of Object.entries(item.specs || {})) {
      if (!value) continue;
      if (!map.has(label)) map.set(label, new Set());
      map.get(label).add(String(value));
    }
  }

  const preferred = ["容量", "儲存空間", "顏色", "尺寸", "版本", "記憶體", "連線版本"];
  return [...map.entries()]
    .map(([label, values]) => ({
      key: label,
      label,
      values: [...values].sort(naturalSpecSort),
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

function sanitizeSpecs(specs) {
  if (!specs || typeof specs !== "object" || Array.isArray(specs)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(specs)) {
    const key = String(rawKey || "").trim().slice(0, 20);
    const value = String(rawValue ?? "").trim().slice(0, 80);
    if (key && value && value !== "未知" && value !== "N/A") out[key] = value;
  }
  return out;
}

function naturalSpecSort(a, b) {
  const unit = (v) => {
    const m = String(v).toUpperCase().match(/([\d.]+)\s*(TB|GB|MB)/);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === "TB" ? n * 1024 : m[2] === "GB" ? n : n / 1024;
  };
  const av = unit(a);
  const bv = unit(b);
  if (av !== null && bv !== null) return av - bv;
  return String(a).localeCompare(String(b), "zh-Hant", { numeric: true });
}

function dedupeRawItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.store_id}|${item.title}|${item.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parsePrice(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").replace(/,/g, "");
  const match = text.match(/[\d.]+/);
  return match ? Number(match[0]) : NaN;
}

function normalizeShopeePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n >= 100000 ? n / 100000 : n;
}

function browserHeaders(referer) {
  return {
    accept: "application/json,text/plain,*/*",
    "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
    referer,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  };
}

function cleanError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(),
      "cache-control": "no-store",
    },
  });
}
