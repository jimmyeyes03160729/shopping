const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const STORE_FETCH_TIMEOUT_MS = 2800;
const GEMINI_TIMEOUT_MS = 4500;
const MAX_PER_STORE = 4;
const MAX_AI_ITEMS = 48;

const STORE_CONFIGS = {
  momo: {
    name: "momo 購物網",
    homepage: "https://www.momoshop.com.tw/",
    search: "https://www.momoshop.com.tw/search/searchShop.jsp?keyword={keyword}",
  },
  pchome: {
    name: "PChome 24h購物",
    homepage: "https://24h.pchome.com.tw/",
    search: "https://24h.pchome.com.tw/search/?q={keyword}",
  },
  yahoo: {
    name: "Yahoo奇摩購物中心",
    homepage: "https://tw.buy.yahoo.com/",
    search: "https://tw.buy.yahoo.com/search/product?p={keyword}",
  },
  coupang: {
    name: "Coupang 酷澎",
    homepage: "https://www.tw.coupang.com/",
    search: "https://www.tw.coupang.com/search?q={keyword}",
  },
  shopee: {
    name: "蝦皮購物",
    homepage: "https://shopee.tw/",
    search: "https://shopee.tw/search?keyword={keyword}",
  },
  costco: {
    name: "Costco 好市多線上購物",
    homepage: "https://www.costco.com.tw/",
    search: "https://www.costco.com.tw/s?keyword={keyword}",
  },
  uniqlo: {
    name: "UNIQLO 台灣網路商店",
    homepage: "https://www.uniqlo.com/tw/zh_TW/",
    search: "https://www.uniqlo.com/tw/zh_TW/search.html?description={keyword}",
  },
  eslite: {
    name: "誠品線上 (Eslite)",
    homepage: "https://www.eslite.com/",
    search: "https://www.eslite.com/Search?keyword={keyword}",
  },
  pxgo: {
    name: "PXGo! 全聯線上購",
    homepage: "https://shop.pxgo.com.tw/",
    search: "https://shop.pxgo.com.tw/hourArrive/search?keyword={keyword}",
  },
  tk3c: {
    name: "燦坤線上購物 (Tk3C)",
    homepage: "https://www.tk3c.com/",
    search: "https://www.tk3c.com/search.aspx?keyword={keyword}",
  },
  elife: {
    name: "全國電子線上購物",
    homepage: "https://www.elifemall.com.tw/",
    search: "https://www.elifemall.com.tw/search?keyword={keyword}",
  },
  carrefour: {
    name: "家樂福線上",
    homepage: "https://online.carrefour.com.tw/",
    search: "https://online.carrefour.com.tw/zh/search/?q={keyword}",
  },
  watsons: {
    name: "屈臣氏台灣",
    homepage: "https://www.watsons.com.tw/",
    search: "https://www.watsons.com.tw/search?text={keyword}",
  },
  cosmed: {
    name: "康是美網購",
    homepage: "https://shop.cosmed.com.tw/",
    search: "https://shop.cosmed.com.tw/search?keyword={keyword}",
  },
  etmall: {
    name: "東森購物網",
    homepage: "https://www.etmall.com.tw/",
    search: "https://www.etmall.com.tw/Search?keyword={keyword}",
  },
  family: {
    name: "全家",
    homepage: "https://mart.family.com.tw/v2/official",
    search: "https://mart.family.com.tw/v2/official/search?keyword={keyword}",
  },
  seven: {
    name: "統一超商",
    homepage: "https://711go.7-11.com.tw/Home",
    search: "https://711go.7-11.com.tw/Search?keyword={keyword}",
  },
};

const SOURCE_LABELS = Object.fromEntries(
  Object.entries(STORE_CONFIGS).map(([id, cfg]) => [id, cfg.name])
);

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
        model: env.GEMINI_MODEL || "gemini-3.6-flash",
        sources: Object.keys(STORE_CONFIGS),
      });
    }

    if (url.pathname === "/api/search") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleSearch(request, env);
    }

    if (url.pathname === "/api/enrich") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleEnrich(request, env);
    }

    return new Response("Shopping compare API", { status: 200 });
  },
};

async function handleSearch(request, env) {
  try {
    const body = await request.json();
    const keyword = String(body.keyword || "").trim();
    const requestedSources = Array.isArray(body.sources)
      ? body.sources.filter((id) => STORE_CONFIGS[id])
      : Object.keys(STORE_CONFIGS);

    if (!keyword) return json({ error: "請輸入商品關鍵字" }, 400);
    if (!requestedSources.length) return json({ error: "沒有可搜尋的賣場" }, 400);

    const cacheKey = makeCacheKey(keyword, requestedSources);
    const cached = SEARCH_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < SEARCH_CACHE_TTL_MS) {
      return json({ ...cached.payload, cache_hit: true });
    }

    const sourceResults = await Promise.all(
      requestedSources.map(async (source) => {
        try {
          const items = await searchStore(source, keyword);
          return { source, ok: true, items };
        } catch (error) {
          return { source, ok: false, items: [], error: cleanError(error) };
        }
      })
    );

    let rawItems = sourceResults
      .flatMap((result) => result.items.slice(0, MAX_PER_STORE))
      .filter((item) => Number.isFinite(item.price) && item.price > 0 && item.title);

    rawItems = dedupeRawItems(rawItems).slice(0, MAX_AI_ITEMS);

    if (!rawItems.length) {
      const payload = {
        keyword,
        items: [],
        dimensions: [],
        sources: sourceResults.map((x) => sourceStatus(x, keyword)),
        message: "目前沒有取得可驗證的商品價格。",
        updated_at: new Date().toISOString(),
        cache_hit: false,
      };
      SEARCH_CACHE.set(cacheKey, { savedAt: Date.now(), payload });
      return json(payload);
    }

    // 快速搜尋階段不等待 Gemini。先用本地規則整理規格，
    // 前端顯示價格後再呼叫 /api/enrich 背景精修。
    const normalized = fallbackNormalize(keyword, rawItems);
    const normalizedMap = new Map(normalized.map((x) => [String(x.id), x]));
    const items = rawItems
      .map((raw) => {
        const ai = normalizedMap.get(raw.id);
        if (!ai) return null;
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

    const payload = {
      keyword,
      items,
      dimensions: buildDimensions(items),
      sources: sourceResults.map((x) => sourceStatus(x, keyword)),
      updated_at: new Date().toISOString(),
      cache_hit: false,
      quick_mode: true,
      specs_pending: Boolean(env.GEMINI_API_KEY && items.length),
    };

    SEARCH_CACHE.set(cacheKey, { savedAt: Date.now(), payload });
    cleanupSearchCache();
    return json(payload);
  } catch (error) {
    return json({ error: cleanError(error) }, 500);
  }
}

async function handleEnrich(request, env) {
  try {
    if (!env.GEMINI_API_KEY) return json({ error: "後端尚未設定 GEMINI_API_KEY" }, 400);

    const body = await request.json();
    const keyword = String(body.keyword || "").trim();
    const inputItems = Array.isArray(body.items) ? body.items.slice(0, MAX_AI_ITEMS) : [];

    if (!keyword || !inputItems.length) {
      return json({ error: "缺少 keyword 或 items" }, 400);
    }

    const rawItems = inputItems
      .map((x) => ({
        id: String(x.id || ""),
        store_id: String(x.store_id || ""),
        store_name: String(x.store_name || ""),
        title: cleanText(x.title),
        price: parsePrice(x.price),
        url: String(x.url || ""),
      }))
      .filter((x) => x.id && x.title);

    const normalized = await normalizeSpecsWithGemini(keyword, rawItems, env);
    return json({ items: normalized });
  } catch (error) {
    return json({ error: cleanError(error) }, 500);
  }
}

function sourceStatus(result, keyword) {
  const cfg = STORE_CONFIGS[result.source];
  return {
    id: result.source,
    name: cfg?.name || result.source,
    ok: result.ok,
    count: result.items.length,
    error: result.ok ? null : result.error,
    manual_url: cfg ? buildSearchUrl(cfg, keyword) : null,
  };
}

async function searchStore(source, keyword) {
  if (source === "pchome") return searchPchome(keyword);
  if (source === "momo") return searchMomo(keyword);
  if (source === "costco") return searchCostco(keyword);
  if (source === "yahoo") return searchYahoo(keyword);
  if (source === "coupang") return searchCoupang(keyword);
  if (source === "carrefour") return searchCarrefour(keyword);
  if (source === "tk3c") return searchTk3c(keyword);
  if (source === "shopee") {
    try {
      return await searchShopee(keyword);
    } catch {
      return searchGenericStore(source, keyword);
    }
  }
  return searchGenericStore(source, keyword);
}

async function fetchStoreHtml(source, keyword, timeoutMs = 4200) {
  const cfg = STORE_CONFIGS[source];
  const searchUrl = buildSearchUrl(cfg, keyword);
  const response = await fetchWithTimeout(
    searchUrl,
    {
      headers: {
        ...browserHeaders(cfg.homepage),
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      redirect: "follow",
    },
    timeoutMs
  );

  if (!response.ok) throw new Error(`${cfg.name} HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`${cfg.name} 回傳非 HTML 搜尋頁`);
  }

  let html = await response.text();
  if (html.length > 1_600_000) html = html.slice(0, 1_600_000);
  return { html, searchUrl };
}

async function searchCostco(keyword) {
  const { html, searchUrl } = await fetchStoreHtml("costco", keyword, 5000);
  const candidates = [
    ...extractJsonLdProducts(html, "costco", searchUrl),
    ...extractEmbeddedJsonProducts(html, "costco", searchUrl),
    ...extractWideAnchorProducts(html, "costco", searchUrl, keyword, {
      hrefPattern: /\/p\/|\/c\//i,
      priceLabels: /\$|NT\$|價格/i,
    }),
    ...extractKeywordWindowProducts(html, "costco", searchUrl, keyword),
  ];
  return rankAndDedupe(candidates, keyword).slice(0, MAX_PER_STORE);
}

async function searchYahoo(keyword) {
  const { html, searchUrl } = await fetchStoreHtml("yahoo", keyword, 5000);
  const candidates = [
    ...extractYahooGridProducts(html, "yahoo", searchUrl, keyword),
    ...extractJsonLdProducts(html, "yahoo", searchUrl),
    ...extractEmbeddedJsonProducts(html, "yahoo", searchUrl),
    ...extractWideAnchorProducts(html, "yahoo", searchUrl, keyword, {
      hrefPattern: /\/gdsale\//i,
      priceLabels: /\$|售價|優惠價/i,
    }),
  ];
  return rankAndDedupe(candidates, keyword).slice(0, MAX_PER_STORE);
}

async function searchCoupang(keyword) {
  const { html, searchUrl } = await fetchStoreHtml("coupang", keyword, 5200);
  const candidates = [
    ...extractCoupangProducts(html, searchUrl, keyword),
    ...extractJsonLdProducts(html, "coupang", searchUrl),
    ...extractEmbeddedJsonProducts(html, "coupang", searchUrl),
    ...extractWideAnchorProducts(html, "coupang", searchUrl, keyword, {
      hrefPattern: /\/vp\/products\//i,
      priceLabels: /\$|折扣後價格|首購折扣價/i,
    }),
  ];
  return rankAndDedupe(candidates, keyword).slice(0, MAX_PER_STORE);
}

async function searchCarrefour(keyword) {
  const { html, searchUrl } = await fetchStoreHtml("carrefour", keyword, 4800);
  const candidates = [
    ...extractJsonLdProducts(html, "carrefour", searchUrl),
    ...extractEmbeddedJsonProducts(html, "carrefour", searchUrl),
    ...extractWideAnchorProducts(html, "carrefour", searchUrl, keyword, {
      hrefPattern: /\/zh\//i,
      priceLabels: /\$|特價|售價/i,
    }),
    ...extractKeywordWindowProducts(html, "carrefour", searchUrl, keyword),
  ];
  return rankAndDedupe(candidates, keyword).slice(0, MAX_PER_STORE);
}

async function searchTk3c(keyword) {
  const { html, searchUrl } = await fetchStoreHtml("tk3c", keyword, 4200);
  const candidates = [
    ...extractJsonLdProducts(html, "tk3c", searchUrl),
    ...extractEmbeddedJsonProducts(html, "tk3c", searchUrl),
    ...extractWideAnchorProducts(html, "tk3c", searchUrl, keyword, {
      hrefPattern: /ptview\.aspx|dic\d?\.aspx/i,
      priceLabels: /網路價|會員價|\$/i,
    }),
    ...extractKeywordWindowProducts(html, "tk3c", searchUrl, keyword),
  ];
  return rankAndDedupe(candidates, keyword).slice(0, MAX_PER_STORE);
}

async function searchPchome(keyword) {
  const endpoint = new URL("https://ecshweb.pchome.com.tw/search/v3.3/all/results");
  endpoint.searchParams.set("q", keyword);
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("sort", "rnk/dc");

  const response = await fetchWithTimeout(endpoint, {
    headers: browserHeaders("https://24h.pchome.com.tw/"),
  });

  if (!response.ok) throw new Error(`PChome HTTP ${response.status}`);
  const data = await response.json();
  const products = Array.isArray(data.prods) ? data.prods : [];

  return products.slice(0, MAX_PER_STORE).map((p, index) => {
    const productId = String(p.Id || p.id || "");
    return {
      id: `pchome-${productId || index}`,
      store_id: "pchome",
      store_name: SOURCE_LABELS.pchome,
      title: cleanText(p.name),
      price: parsePrice(p.price),
      url: productId
        ? `https://24h.pchome.com.tw/prod/${encodeURIComponent(productId)}`
        : buildSearchUrl(STORE_CONFIGS.pchome, keyword),
    };
  });
}

async function searchMomo(keyword) {
  const endpoint = "https://apisearch.momoshop.com.tw/momoSearchCloud/moec/textSearch";
  const response = await fetchWithTimeout(endpoint, {
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

  return products.slice(0, MAX_PER_STORE).map((p, index) => {
    const code = String(
      p.goodsCode || p.goodsNo || p.i_code || p.goodsId || p.goodsID || ""
    );
    return {
      id: `momo-${code || index}`,
      store_id: "momo",
      store_name: SOURCE_LABELS.momo,
      title: cleanText(p.goodsName || p.name),
      price: parsePrice(p.goodsPrice ?? p.salePrice ?? p.price),
      url: code
        ? `https://www.momoshop.com.tw/goods/GoodsDetail.jsp?i_code=${encodeURIComponent(code)}`
        : buildSearchUrl(STORE_CONFIGS.momo, keyword),
    };
  });
}

async function searchShopee(keyword) {
  const endpoint = new URL("https://shopee.tw/api/v4/search/search_items");
  endpoint.searchParams.set("by", "relevancy");
  endpoint.searchParams.set("keyword", keyword);
  endpoint.searchParams.set("limit", String(MAX_PER_STORE));
  endpoint.searchParams.set("newest", "0");
  endpoint.searchParams.set("order", "desc");
  endpoint.searchParams.set("page_type", "search");
  endpoint.searchParams.set("scenario", "PAGE_GLOBAL_SEARCH");
  endpoint.searchParams.set("version", "2");

  const response = await fetchWithTimeout(endpoint, {
    headers: {
      ...browserHeaders(buildSearchUrl(STORE_CONFIGS.shopee, keyword)),
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

  return rows.slice(0, MAX_PER_STORE).map((row, index) => {
    const p = row.item_basic || row;
    const itemId = String(p.itemid || p.item_id || "");
    const shopId = String(p.shopid || p.shop_id || "");
    const price = normalizeShopeePrice(p.price_min ?? p.price ?? p.price_max);
    return {
      id: `shopee-${shopId || "s"}-${itemId || index}`,
      store_id: "shopee",
      store_name: SOURCE_LABELS.shopee,
      title: cleanText(p.name),
      price,
      url:
        itemId && shopId
          ? `https://shopee.tw/product/${encodeURIComponent(shopId)}/${encodeURIComponent(itemId)}`
          : buildSearchUrl(STORE_CONFIGS.shopee, keyword),
    };
  });
}

async function searchGenericStore(source, keyword) {
  const cfg = STORE_CONFIGS[source];
  const searchUrl = buildSearchUrl(cfg, keyword);
  const response = await fetchWithTimeout(searchUrl, {
    headers: browserHeaders(cfg.homepage),
    redirect: "follow",
  });

  if (!response.ok) throw new Error(`${cfg.name} HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`${cfg.name} 回傳非 HTML 搜尋頁`);
  }

  let html = await response.text();
  if (html.length > 900_000) html = html.slice(0, 900_000);

  const candidates = [
    ...extractJsonLdProducts(html, source, searchUrl),
    ...extractEmbeddedJsonProducts(html, source, searchUrl),
    ...extractHtmlAnchorProducts(html, source, searchUrl),
  ];

  const filtered = candidates
    .filter((item) => item.title && Number.isFinite(item.price) && item.price > 0)
    .filter((item) => isLikelyRelevantTitle(item.title, keyword));

  return dedupeRawItems(filtered).slice(0, MAX_PER_STORE);
}

function extractJsonLdProducts(html, source, baseUrl) {
  const results = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scripts = 0;

  while ((match = regex.exec(html)) && scripts++ < 16 && results.length < 20) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[1].trim()));
      collectProductObjects(parsed, source, baseUrl, results, 0, { count: 0 });
    } catch {}
  }

  return results;
}

function extractEmbeddedJsonProducts(html, source, baseUrl) {
  const results = [];
  const regex = /<script[^>]*(?:type=["']application\/json["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scripts = 0;

  while ((match = regex.exec(html)) && scripts++ < 8 && results.length < 20) {
    const text = match[1].trim();
    if (!text || text.length > 1_200_000) continue;
    try {
      const parsed = JSON.parse(decodeHtmlEntities(text));
      collectProductObjects(parsed, source, baseUrl, results, 0, { count: 0 });
    } catch {}
  }

  return results;
}

function collectProductObjects(value, source, baseUrl, results, depth, state) {
  if (results.length >= 20 || depth > 9 || state.count++ > 5000 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectProductObjects(item, source, baseUrl, results, depth + 1, state);
    return;
  }

  if (typeof value !== "object") return;

  const candidate = productCandidateFromObject(value, source, baseUrl, results.length);
  if (candidate) results.push(candidate);

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectProductObjects(child, source, baseUrl, results, depth + 1, state);
    }
  }
}

function productCandidateFromObject(obj, source, baseUrl, index) {
  const type = String(obj["@type"] || "");
  const title = firstText(obj, [
    "name", "title", "productName", "goodsName", "itemName", "displayName",
  ]);

  let priceValue = firstValue(obj, [
    "salePrice", "sellingPrice", "finalPrice", "discountPrice",
    "currentPrice", "price", "lowPrice",
  ]);

  if (priceValue == null && obj.offers) {
    const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
    if (offers && typeof offers === "object") {
      priceValue = firstValue(offers, ["price", "lowPrice", "salePrice", "priceValue"]);
    }
  }

  if (!title || priceValue == null) return null;
  if (type && !/Product|Offer|ListItem/i.test(type) && !looksProductishObject(obj)) return null;

  const price = parsePrice(priceValue);
  if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) return null;

  let urlValue = firstText(obj, ["url", "link", "href", "productUrl", "goodsUrl", "detailUrl"]);
  if (!urlValue && obj.item && typeof obj.item === "object") {
    urlValue = firstText(obj.item, ["url", "link", "href"]);
  }

  return makeRawItem(
    source,
    title,
    price,
    absoluteUrl(urlValue, baseUrl) || baseUrl,
    `json-${index}`
  );
}

function looksProductishObject(obj) {
  const keys = Object.keys(obj).join("|").toLowerCase();
  return /(product|goods|item|sku)/.test(keys);
}

function extractHtmlAnchorProducts(html, source, baseUrl) {
  const results = [];
  const regex = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]{0,900}?)<\/a>/gi;
  let match;
  let inspected = 0;

  while ((match = regex.exec(html)) && inspected++ < 450 && results.length < 24) {
    const attrs = `${match[1]} ${match[3]}`;
    const body = match[4];
    const attrTitle = getHtmlAttribute(attrs, "title") || getHtmlAttribute(attrs, "aria-label");
    const title = cleanText(attrTitle || stripTags(body));
    if (!title || title.length < 4 || title.length > 240) continue;

    const nearby = html.slice(regex.lastIndex, Math.min(html.length, regex.lastIndex + 700));
    const price = extractPriceFromText(stripTags(body + " " + nearby));
    if (!Number.isFinite(price)) continue;

    const url = absoluteUrl(match[2], baseUrl);
    if (!url) continue;

    results.push(makeRawItem(source, title, price, url, `html-${results.length}`));
  }

  return results;
}

function extractYahooGridProducts(html, source, baseUrl, keyword) {
  const results = [];
  const regex = /<li\b[^>]*class=["'][^"']*BaseGridItem[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  let inspected = 0;

  while ((match = regex.exec(html)) && inspected++ < 120 && results.length < 16) {
    const block = match[1];
    const hrefMatch = block.match(/<a\b[^>]*href=["']([^"']+)["']/i);
    const text = stripTags(block);
    const price = extractPriceFromText(text);
    if (!hrefMatch || !Number.isFinite(price)) continue;

    const title = deriveTitleFromText(text, keyword);
    if (!title || !isLikelyRelevantTitle(title, keyword)) continue;

    results.push(makeRawItem(
      source,
      title,
      price,
      absoluteUrl(hrefMatch[1], baseUrl) || baseUrl,
      `yahoo-${results.length}`
    ));
  }
  return results;
}

function extractCoupangProducts(html, baseUrl, keyword) {
  const results = [];
  const regex = /<a\b([^>]*?)href=["']([^"']*\/vp\/products\/[^"']+)["']([^>]*)>([\s\S]{0,2600}?)<\/a>/gi;
  let match;
  let inspected = 0;

  while ((match = regex.exec(html)) && inspected++ < 180 && results.length < 18) {
    const text = stripTags(match[4]);
    const price = extractPriceFromText(text);
    if (!Number.isFinite(price)) continue;

    const title = deriveTitleFromText(text, keyword);
    if (!title || !isLikelyRelevantTitle(title, keyword)) continue;

    results.push(makeRawItem(
      "coupang",
      title,
      price,
      absoluteUrl(match[2], baseUrl) || baseUrl,
      `coupang-${results.length}`
    ));
  }
  return results;
}

function extractWideAnchorProducts(html, source, baseUrl, keyword, options = {}) {
  const results = [];
  const regex = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]{0,2200}?)<\/a>/gi;
  let match;
  let inspected = 0;

  while ((match = regex.exec(html)) && inspected++ < 900 && results.length < 24) {
    const href = match[2];
    if (options.hrefPattern && !options.hrefPattern.test(href)) continue;

    const attrs = `${match[1]} ${match[3]}`;
    const body = match[4];
    const after = html.slice(regex.lastIndex, Math.min(html.length, regex.lastIndex + 1000));
    const text = stripTags(body + " " + after);

    if (options.priceLabels && !options.priceLabels.test(text)) continue;

    const price = extractPriceFromText(text);
    if (!Number.isFinite(price)) continue;

    const attrTitle =
      getHtmlAttribute(attrs, "title") ||
      getHtmlAttribute(attrs, "aria-label") ||
      getHtmlAttribute(attrs, "data-name");

    const title = cleanText(attrTitle || deriveTitleFromText(stripTags(body), keyword));
    if (!title || title.length < 3 || title.length > 220) continue;
    if (!isLikelyRelevantTitle(title, keyword)) continue;

    const url = absoluteUrl(href, baseUrl);
    if (!url) continue;

    results.push(makeRawItem(source, title, price, url, `wide-${results.length}`));
  }

  return results;
}

function extractKeywordWindowProducts(html, source, baseUrl, keyword) {
  const results = [];
  const normalizedKeyword = cleanText(keyword);
  if (!normalizedKeyword) return results;

  const lowerHtml = html.toLowerCase();
  const probes = buildKeywordProbes(normalizedKeyword);

  for (const probe of probes) {
    let from = 0;
    let hits = 0;
    while (hits++ < 18) {
      const pos = lowerHtml.indexOf(probe.toLowerCase(), from);
      if (pos < 0) break;
      from = pos + probe.length;

      const start = Math.max(0, pos - 1100);
      const end = Math.min(html.length, pos + 1800);
      const windowHtml = html.slice(start, end);
      const windowText = stripTags(windowHtml);
      const price = extractPriceFromText(windowText);
      if (!Number.isFinite(price)) continue;

      const links = [...windowHtml.matchAll(/href=["']([^"']+)["']/gi)];
      const link = links.length ? links[Math.floor(links.length / 2)]?.[1] : "";
      const url = absoluteUrl(link, baseUrl) || baseUrl;

      const title = deriveTitleFromText(windowText, keyword);
      if (!title || !isLikelyRelevantTitle(title, keyword)) continue;

      results.push(makeRawItem(source, title, price, url, `window-${results.length}`));
      if (results.length >= 16) return results;
    }
  }
  return results;
}

function buildKeywordProbes(keyword) {
  const compact = normalizeForMatch(keyword);
  const probes = [keyword];
  const chinese = compact.replace(/[a-z0-9]/g, "");
  if (chinese.length >= 2) probes.push(chinese.slice(0, Math.min(4, chinese.length)));
  const tokens = keyword.split(/[\s,，/\\|+()\-_]+/).filter((x) => x.length >= 2);
  probes.push(...tokens);
  return [...new Set(probes.filter(Boolean))];
}

function deriveTitleFromText(text, keyword) {
  let value = cleanText(text);
  if (!value) return "";

  value = value
    .replace(/^(含運|免運|活動|折扣|推薦|熱銷|新品|限時)+\s*/g, "")
    .replace(/(?:折扣後價格|首購折扣價|網路價|會員價|優惠價|售價|特價)?\s*(?:NT\$|\$)\s*[\d,]+[\s\S]*$/i, "")
    .replace(/\s+(?:明天|今天|預計送達|免運|免費退貨|滿額|活動券|加入購物車)[\s\S]*$/i, "")
    .trim();

  if (value.length > 220) {
    const k = normalizeForMatch(keyword);
    const parts = value.split(/\s{2,}|\|/).map((x) => x.trim()).filter(Boolean);
    const relevant = parts.find((part) => normalizeForMatch(part).includes(k));
    if (relevant) value = relevant;
  }

  return value.slice(0, 220);
}

function rankAndDedupe(items, keyword) {
  const scored = items
    .filter((item) => item && item.title && Number.isFinite(item.price) && item.price > 0)
    .map((item) => ({
      item,
      score: relevanceScore(item.title, keyword),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price)
    .map((x) => x.item);

  return dedupeRawItems(scored);
}

function relevanceScore(title, keyword) {
  const t = normalizeForMatch(title);
  const k = normalizeForMatch(keyword);
  if (!t || !k) return 0;
  if (t.includes(k)) return 100;

  let score = 0;
  for (const probe of buildKeywordProbes(keyword)) {
    const p = normalizeForMatch(probe);
    if (p && t.includes(p)) score += Math.max(8, p.length * 4);
  }
  return score;
}

function makeRawItem(source, title, price, url, suffix) {
  return {
    id: `${source}-${simpleHash(title + "|" + price + "|" + suffix)}`,
    store_id: source,
    store_name: SOURCE_LABELS[source],
    title: cleanText(title),
    price: Number(price),
    url,
  };
}

function extractPriceFromText(text) {
  const matches = [];
  const regex = /(?:NT\$|NTD\s*\$?|售價[:：]?|特價[:：]?|優惠價[:：]?|價格[:：]?|\$)\s*([0-9][0-9,]{1,8})/gi;
  let match;
  while ((match = regex.exec(text)) && matches.length < 8) {
    const n = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 10 && n <= 10_000_000) matches.push(n);
  }
  return matches.length ? Math.min(...matches) : NaN;
}

async function normalizeSpecsWithGemini(keyword, rawItems, env) {
  const model = env.GEMINI_MODEL || "gemini-3.6-flash";
  const prompt = [
    "你是商品規格正規化引擎，不得提供、猜測或修改價格與網址。",
    `使用者搜尋主商品：「${keyword}」`,
    "只根據 title 判斷是否為使用者搜尋的主商品本體，型號必須吻合；排除配件、保護殼、貼膜、充電器、二手零件與不同型號。",
    "整理 canonical_name 與動態 specs。規格鍵名用繁體中文且一致，例如：容量、顏色、尺寸、版本、記憶體、儲存空間、連線版本。",
    "容量統一成 256GB、512GB、1TB 等格式。未知規格不要填入，不得新增輸入不存在的商品。",
    '回傳 JSON：{"items":[{"id":"輸入id","match":true,"canonical_name":"標準商品名","specs":{"容量":"256GB","顏色":"黑色"}}]}',
    "輸入：",
    JSON.stringify(rawItems.map((x) => ({ id: x.id, store: x.store_name, title: x.title }))),
  ].join("\n");

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
    GEMINI_TIMEOUT_MS
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${detail.slice(0, 180)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini 沒有回傳規格分析結果");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini 回傳不是有效 JSON");
    parsed = JSON.parse(match[0]);
  }

  return Array.isArray(parsed?.items) ? parsed.items : [];
}

function fallbackNormalize(keyword, rawItems) {
  // 商城自己的搜尋結果先全部保留，避免因標題格式差異造成整家商城被誤刪。
  // 是否高度吻合只作為參考，不在快速階段刪除商品。
  return rawItems.map((item) => ({
    id: item.id,
    match: true,
    local_relevant: isLikelyRelevantTitle(item.title, keyword),
    canonical_name: item.title,
    specs: extractLocalSpecs(item.title),
  }));
}

function extractLocalSpecs(title) {
  const specs = {};
  const text = String(title || "");

  const ram = text.match(/(\d+(?:\.\d+)?)\s*GB\s*(?:RAM|記憶體)/i);
  if (ram) specs["記憶體"] = `${ram[1]}GB`;

  const storageMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(TB|GB)\b/gi)]
    .map((m) => ({ raw: m[0], value: Number(m[1]), unit: m[2].toUpperCase(), index: m.index || 0 }))
    .filter((x) => !ram || !x.raw.toUpperCase().includes(String(ram[0]).toUpperCase()));

  if (storageMatches.length) {
    const best = storageMatches
      .map((x) => ({ ...x, normalized: x.unit === "TB" ? x.value * 1024 : x.value }))
      .sort((a, b) => b.normalized - a.normalized)[0];
    specs["容量"] = `${best.value}${best.unit}`;
  }

  const size = text.match(/(\d+(?:\.\d+)?)\s*(吋|寸|inch)/i);
  if (size) specs["尺寸"] = `${size[1]}${size[2] === "inch" ? "吋" : size[2]}`;

  const version = text.match(/\b(5G|4G|LTE|Wi-?Fi)\b/i);
  if (version) specs["版本"] = version[1].toUpperCase().replace("WIFI", "Wi-Fi");

  const color = text.match(
    /(原色鈦金屬|沙漠色鈦金屬|黑色鈦金屬|白色鈦金屬|宇宙橙色|藏藍色|霧藍色|天藍色|星夜黑|星辰黑|曜石黑|午夜黑|玫瑰金|香檳金|冷白色|雲白色|月霜白|嫩粉色|晨曦粉|[深淺墨霧曜星宇玫瑰香檳冷雲月嫩晨曦]?[黑白藍紅粉銀金灰綠紫橙黃]色)/
  );
  if (color) specs["顏色"] = color[1];

  return specs;
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
    .map(([label, values]) => ({ key: label, label, values: [...values].sort(naturalSpecSort) }))
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
  const toGb = (v) => {
    const m = String(v).toUpperCase().match(/([\d.]+)\s*(TB|GB|MB)/);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === "TB" ? n * 1024 : m[2] === "GB" ? n : n / 1024;
  };
  const av = toGb(a);
  const bv = toGb(b);
  if (av !== null && bv !== null) return av - bv;
  return String(a).localeCompare(String(b), "zh-Hant", { numeric: true });
}

function isLikelyRelevantTitle(title, keyword) {
  const cleanTitle = cleanText(title);
  const t = normalizeForMatch(cleanTitle);
  const k = normalizeForMatch(keyword);
  if (!t || !k) return false;
  if (t.includes(k)) return true;

  const rawTokens = String(keyword)
    .toLowerCase()
    .split(/[\s,，/\\|+()\-_]+/)
    .map((x) => normalizeForMatch(x))
    .filter((x) => x.length >= 2);

  // 中文沒有空格時，除了整串關鍵字，也拆成 2 字片段。
  // 例如「舒潔衛生紙」=> 舒潔 / 潔衛 / 衛生 / 生紙。
  const chineseBigrams = [];
  const chinese = k.replace(/[a-z0-9]/g, "");
  if (chinese.length >= 4) {
    for (let i = 0; i < chinese.length - 1; i++) {
      chineseBigrams.push(chinese.slice(i, i + 2));
    }
  }

  const tokens = [...new Set([...rawTokens, ...chineseBigrams])];
  if (!tokens.length) return false;

  const hits = tokens.filter((token) => t.includes(token)).length;

  // 有品牌字或核心詞命中即可保留；多詞搜尋要求約一半命中。
  if (rawTokens.some((token) => token.length >= 2 && t.includes(token))) return true;
  return hits >= Math.max(1, Math.ceil(tokens.length * 0.45));
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function firstText(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return cleanText(value);
  }
  return "";
}

function firstValue(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" || typeof value === "string") return value;
    if (value && typeof value === "object") {
      const nested = firstValue(value, ["value", "amount", "price"]);
      if (nested != null) return nested;
    }
  }
  return null;
}

function getHtmlAttribute(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? decodeHtmlEntities(match[1]) : "";
}

function stripTags(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(String(value), baseUrl).href;
  } catch {
    return "";
  }
}

function buildSearchUrl(cfg, keyword) {
  return cfg.search.replace("{keyword}", encodeURIComponent(keyword));
}

function cleanText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
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

function dedupeRawItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.store_id}|${normalizeForMatch(item.title)}|${item.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function browserHeaders(referer) {
  return {
    accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
    "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
    referer,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  };
}

async function fetchWithTimeout(input, options = {}, timeoutMs = STORE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("連線逾時");
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function makeCacheKey(keyword, sources) {
  return String(keyword).trim().toLowerCase() + "|" + [...sources].sort().join(",");
}

function cleanupSearchCache() {
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
