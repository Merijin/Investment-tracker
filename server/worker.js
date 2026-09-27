/*
 * Investment Tracker price server — a Cloudflare Worker.
 *
 * The app runs entirely in the browser, but some price sources need secret
 * keys or don't allow browser requests. This worker holds the keys and calls
 * the official APIs for the app:
 *
 *   GET /health                     which sources are configured
 *   GET /ebay?q=&mode=sold|active   median eBay price for a search
 *   GET /pricecharting?id=          PriceCharting prices by grade
 *   GET /pricecharting/search?q=    find PriceCharting products
 *   GET /property?location=&type=   area median property price + history
 *   GET /tcgapi?path=/cards/ID      relay to tcgapi.dev (if the browser can't call it)
 *
 * Secrets (set with `wrangler secret put NAME`):
 *   APP_TOKEN            access code the app must send (recommended)
 *   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET   eBay developer app keys
 *   EBAY_SOLD            "true" once eBay grants Marketplace Insights access
 *   PRICECHARTING_TOKEN  PriceCharting API token (paid subscription)
 *   DOMAIN_API_KEY       Domain developer key (Australian suburb medians)
 *   TCGAPI_KEY           tcgapi.dev key, only needed for the relay
 * Optional: ALLOWED_ORIGIN (default "*"), EBAY_MARKETPLACE (default EBAY_US).
 */

const CACHE_SECONDS = { '/tcgapi': 6 * 3600, '/ebay': 6 * 3600, '/pricecharting': 12 * 3600, '/pricecharting/search': 86400, '/property': 86400 };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJSON(fetchFn, url, init) {
  const res = await fetchFn(url, init);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new HttpError(res.status === 404 ? 404 : 502, `${new URL(url).hostname} returned ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

// ---------- statistics ----------

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median after dropping outliers: anything under 1/2.5 or over 2.5 times the
 * raw median (mislabelled lots, damaged copies, silly asking prices).
 */
export function robustStats(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = median(v);
  const kept = v.filter((x) => x >= m / 2.5 && x <= m * 2.5);
  return { median: median(kept), low: kept[0], high: kept[kept.length - 1], count: kept.length, dropped: v.length - kept.length };
}

// ---------- eBay ----------

let ebayToken = null; // { value, scope, expires }

async function ebayAuth(env, fetchFn, scope) {
  if (ebayToken && ebayToken.scope === scope && ebayToken.expires > Date.now() + 60000) return ebayToken.value;
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) throw new HttpError(501, 'eBay keys are not set on the price server.');
  const res = await fetchFn('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
  });
  if (!res.ok) throw new HttpError(502, `eBay sign-in failed (${res.status}). Check the eBay keys.`);
  const d = await res.json();
  ebayToken = { value: d.access_token, scope, expires: Date.now() + d.expires_in * 1000 };
  return ebayToken.value;
}

/**
 * Median eBay price for a search. mode=sold uses Marketplace Insights (sold
 * items, needs eBay approval); mode=active uses the Browse API (current
 * Buy It Now listings). eBay's own search syntax works: "-word" excludes.
 */
export async function ebay(params, env, fetchFn) {
  const q = (params.get('q') || '').trim();
  if (!q) throw new HttpError(400, 'Missing search text.');
  const wantSold = params.get('mode') !== 'active';
  const sold = wantSold && env.EBAY_SOLD === 'true';
  const marketplace = params.get('marketplace') || env.EBAY_MARKETPLACE || 'EBAY_US';
  const headers = { 'X-EBAY-C-MARKETPLACE-ID': marketplace };
  let items;
  if (sold) {
    const token = await ebayAuth(env, fetchFn, 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights');
    const d = await getJSON(fetchFn, `https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?q=${encodeURIComponent(q)}&limit=100`,
      { headers: { ...headers, Authorization: `Bearer ${token}` } });
    items = (d.itemSales || []).map((i) => ({
      title: i.title, price: Number(i.lastSoldPrice && i.lastSoldPrice.value), currency: i.lastSoldPrice && i.lastSoldPrice.currency,
      date: i.lastSoldDate ? i.lastSoldDate.slice(0, 10) : null, url: i.itemWebUrl,
    }));
  } else {
    const token = await ebayAuth(env, fetchFn, 'https://api.ebay.com/oauth/api_scope');
    const filter = 'buyingOptions:{FIXED_PRICE}';
    const d = await getJSON(fetchFn, `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&limit=100`,
      { headers: { ...headers, Authorization: `Bearer ${token}` } });
    items = (d.itemSummaries || []).map((i) => ({
      title: i.title, price: Number(i.price && i.price.value), currency: i.price && i.price.currency, date: null, url: i.itemWebUrl,
    }));
  }
  // Use the most common currency so prices are comparable.
  const counts = {};
  for (const i of items) if (i.currency) counts[i.currency] = (counts[i.currency] || 0) + 1;
  const currency = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const same = items.filter((i) => i.currency === currency && i.price > 0);
  const stats = robustStats(same.map((i) => i.price));
  if (!stats) throw new HttpError(404, `No eBay ${sold ? 'sales' : 'listings'} found for "${q}".`);
  return {
    price: stats.median, currency, low: stats.low, high: stats.high, count: stats.count, dropped: stats.dropped,
    mode: sold ? 'sold' : 'active',
    note: wantSold && !sold ? 'Sold prices need eBay Marketplace Insights access; showing current listings instead.' : undefined,
    samples: same.slice(0, 10),
  };
}

// ---------- PriceCharting ----------

// PriceCharting reuses its video-game columns for card grades.
export const PC_GRADES = {
  ungraded: 'loose-price', grade7: 'cib-price', grade8: 'new-price', grade9: 'graded-price',
  'grade9.5': 'box-only-price', psa10: 'manual-only-price', bgs10: 'bgs-10-price', cgc10: 'condition-17-price', sgc10: 'condition-18-price',
};

function pcToken(env) {
  if (!env.PRICECHARTING_TOKEN) throw new HttpError(501, 'PriceCharting token is not set on the price server.');
  return env.PRICECHARTING_TOKEN;
}

export async function pricecharting(params, env, fetchFn) {
  const id = params.get('id');
  if (!id) throw new HttpError(400, 'Missing PriceCharting product id.');
  const d = await getJSON(fetchFn, `https://www.pricecharting.com/api/product?t=${encodeURIComponent(pcToken(env))}&id=${encodeURIComponent(id)}`);
  if (d.status !== 'success') throw new HttpError(404, d['error-message'] || 'Product not found.');
  const prices = {};
  for (const [grade, field] of Object.entries(PC_GRADES)) {
    if (d[field] > 0) prices[grade] = d[field] / 100; // API returns pennies
  }
  return { id: String(d.id), name: d['product-name'], set: d['console-name'], currency: 'USD', prices };
}

export async function pricechartingSearch(params, env, fetchFn) {
  const q = (params.get('q') || '').trim();
  if (!q) return { products: [] };
  const d = await getJSON(fetchFn, `https://www.pricecharting.com/api/products?t=${encodeURIComponent(pcToken(env))}&q=${encodeURIComponent(q)}`);
  return {
    products: (d.products || []).slice(0, 20).map((p) => ({ id: String(p.id), name: p['product-name'], set: p['console-name'] })),
  };
}

// ---------- property ----------

const AU_STATES = ['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

/** "Melbourne, VIC 3000" -> AU suburb; anything else is treated as a UK area name. */
export function parseLocation(text) {
  const t = String(text || '').trim();
  const au = t.match(new RegExp(`^(.+?)[,\\s]+(${AU_STATES.join('|')})[,\\s]+(\\d{4})$`, 'i'));
  if (au) return { country: 'AU', suburb: au[1].trim(), state: au[2].toUpperCase(), postcode: au[3] };
  if (t) return { country: 'UK', region: t.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') };
  return null;
}

/** Domain suburb performance statistics: quarterly median sold price, last 10 years. */
async function domainMedian(loc, type, env, fetchFn) {
  if (!env.DOMAIN_API_KEY) throw new HttpError(501, 'Domain API key is not set on the price server.');
  const category = type === 'unit' ? 'unit' : 'house';
  const url = `https://api.domain.com.au/v2/suburbPerformanceStatistics/${loc.state}/${encodeURIComponent(loc.suburb)}/${loc.postcode}` +
    `?propertyCategory=${category}&chronologicalSpan=3&tPlusFrom=1&tPlusTo=40`;
  const d = await getJSON(fetchFn, url, { headers: { 'X-Api-Key': env.DOMAIN_API_KEY, Accept: 'application/json' } });
  const series = ((d.series && d.series.seriesInfo) || [])
    .filter((s) => s.values && s.values.medianSoldPrice > 0)
    .map((s) => ({
      // A quarter ending in `month` is dated to its last day.
      date: new Date(Date.UTC(s.year, s.month, 0)).toISOString().slice(0, 10),
      price: s.values.medianSoldPrice,
      sales: s.values.numberSold,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!series.length) throw new HttpError(404, `No ${category} sales data for ${loc.suburb} ${loc.state} ${loc.postcode}.`);
  const last = series[series.length - 1];
  return {
    price: last.price, currency: 'AUD', period: last.date, history: series.map(({ date, price }) => ({ date, price })),
    area: `${loc.suburb} ${loc.state} ${loc.postcode}`, source: 'Domain — median sold price, quarterly',
  };
}

const UK_FIELDS = {
  all: 'averagePrice', house: 'averagePrice', detached: 'averagePriceDetached', semi: 'averagePriceSemiDetached',
  terraced: 'averagePriceTerraced', flat: 'averagePriceFlatMaisonette', unit: 'averagePriceFlatMaisonette',
};

/** HM Land Registry UK House Price Index (open data, no key): average price, monthly. */
async function ukHpi(loc, type, fetchFn) {
  const field = UK_FIELDS[type] || 'averagePrice';
  const month = (d) => d.toISOString().slice(0, 7);
  const get = async (ym) => {
    try {
      const d = await getJSON(fetchFn, `https://landregistry.data.gov.uk/data/ukhpi/region/${loc.region}/month/${ym}.json`);
      const t = d.result && d.result.primaryTopic;
      return t && t[field] > 0 ? { date: `${ym}-01`, price: t[field] } : null;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  };
  // The index is published about two months in arrears; step back to the latest.
  const now = new Date();
  let latest = null;
  for (let back = 1; back <= 6 && !latest; back++) {
    latest = await get(month(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))));
  }
  if (!latest) throw new HttpError(404, `No UK House Price Index data for "${loc.region}". Use a region or local authority name, e.g. Manchester.`);
  // Same month in each of the previous 10 years gives a yearly history.
  const [y, m] = latest.date.split('-').map(Number);
  const years = await Promise.all(Array.from({ length: 10 }, (_, i) => get(`${y - 10 + i}-${String(m).padStart(2, '0')}`)));
  const history = [...years.filter(Boolean), latest];
  return {
    price: latest.price, currency: 'GBP', period: latest.date, history,
    area: loc.region, source: 'HM Land Registry UK House Price Index — average price, monthly',
  };
}

export async function property(params, env, fetchFn) {
  const loc = parseLocation(params.get('location'));
  if (!loc) throw new HttpError(400, 'Missing location.');
  const type = params.get('type') || 'house';
  return loc.country === 'AU' ? domainMedian(loc, type, env, fetchFn) : ukHpi(loc, type, fetchFn);
}

/** Relay to tcgapi.dev for browsers that can't call it directly. Card and search paths only. */
export async function tcgapiRelay(params, env, fetchFn) {
  if (!env.TCGAPI_KEY) throw new HttpError(501, 'TCG API key is not set on the price server.');
  const path = params.get('path') || '';
  if (!/^\/(search|cards\/[\w.-]+(\/history)?)$/.test(path)) throw new HttpError(400, 'Unsupported TCG API path.');
  const rest = new URLSearchParams(params);
  rest.delete('path');
  const query = rest.toString();
  return getJSON(fetchFn, `https://api.tcgapi.dev/v1${path}${query ? '?' + query : ''}`, { headers: { 'X-API-Key': env.TCGAPI_KEY } });
}

function health(params, env) {
  return {
    ok: true,
    sources: {
      ebay: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
      ebaySold: env.EBAY_SOLD === 'true',
      pricecharting: !!env.PRICECHARTING_TOKEN,
      domain: !!env.DOMAIN_API_KEY,
      tcgapi: !!env.TCGAPI_KEY,
      ukhpi: true,
    },
  };
}

export const ROUTES = {
  '/health': health, '/ebay': ebay, '/pricecharting': pricecharting,
  '/pricecharting/search': pricechartingSearch, '/property': property, '/tcgapi': tcgapiRelay,
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-App-Token',
    'Access-Control-Max-Age': '86400',
  };
}

export async function handle(request, env, fetchFn = fetch, cache = null) {
  const cors = corsHeaders(env);
  const reply = (body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return reply({ error: 'Only GET is supported.' }, 405);
  if (env.APP_TOKEN && request.headers.get('X-App-Token') !== env.APP_TOKEN) {
    return reply({ error: 'Wrong access code for this price server.' }, 401);
  }
  const url = new URL(request.url);
  const route = ROUTES[url.pathname];
  if (!route) return reply({ error: 'Not found.' }, 404);

  const maxAge = CACHE_SECONDS[url.pathname] || 0;
  const cacheKey = new Request(url.toString());
  if (cache && maxAge) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  try {
    const res = reply(await route(url.searchParams, env, fetchFn), 200, maxAge);
    if (cache && maxAge) await cache.put(cacheKey, res.clone());
    return res;
  } catch (err) {
    return reply({ error: err.message || String(err) }, err.status || 502);
  }
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, fetch, typeof caches !== 'undefined' ? caches.default : null);
  },
};
