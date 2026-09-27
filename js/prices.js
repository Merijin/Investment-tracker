/*
 * Live price providers, exchange rates and symbol search. Every provider is
 * callable straight from the browser (CORS-enabled). `fetch` is injectable so
 * the parsing is testable. Providers return { price, currency }.
 */
(function (root, factory) {
  const api = factory(root.Portfolio || (typeof require === 'function' ? require('./portfolio.js') : null));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Prices = api;
})(typeof self !== 'undefined' ? self : this, function (Portfolio) {
  'use strict';

  async function getJSON(fetchFn, url, headers) {
    const res = await fetchFn(url, headers ? { headers } : undefined);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const qs = (params) => Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  // Some exchanges quote in minor units: London in pence (GBp/GBX), Johannesburg
  // in cents (ZAc), Tel Aviv in agorot (ILA). Convert to the major currency.
  const MINOR_UNITS = { GBP_MINOR: ['GBp', 'GBX'], ZAR_MINOR: ['ZAc', 'ZAX'], ILS_MINOR: ['ILA'] };
  function majorCurrency(code) {
    for (const [k, list] of Object.entries(MINOR_UNITS)) {
      if (list.includes(code)) return { currency: k.slice(0, 3), divisor: 100 };
    }
    return { currency: code ? String(code).toUpperCase() : undefined, divisor: 1 };
  }

  // Finnhub (".L") and Alpha Vantage (".LON") return London prices in pence.
  const PENCE_SUFFIX = { finnhub: /\.L$/, alphavantage: /\.LON$/ };

  function requireKey(settings, name, label) {
    const key = settings.keys && settings.keys[name];
    if (!key) throw new Error(`Add a free ${label} API key in Settings.`);
    return key;
  }

  // ---------- exchange rates ----------

  /**
   * Units of each currency per 1 USD, upper-case codes. Tries the free
   * fawazahmed0 currency API (200+ fiat + crypto), then open.er-api.com.
   */
  async function fetchRates({ fetchFn }) {
    const attempts = [
      ['https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', (d) => d.usd],
      ['https://latest.currency-api.pages.dev/v1/currencies/usd.json', (d) => d.usd],
      ['https://open.er-api.com/v6/latest/USD', (d) => (d.result === 'success' ? d.rates : null)],
    ];
    let lastErr;
    for (const [url, pick] of attempts) {
      try {
        const table = pick(await getJSON(fetchFn, url));
        if (!table) throw new Error('Malformed rates');
        const rates = { USD: 1 };
        for (const [k, v] of Object.entries(table)) {
          if (typeof v === 'number' && v > 0) rates[k.toUpperCase()] = v;
        }
        if (Object.keys(rates).length > 20) return { rates, fetchedAt: new Date().toISOString(), source: new URL(url).hostname };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Exchange rates unavailable');
  }

  // ---------- price providers ----------

  /** CoinGecko: one request for all coins. Returns { coinId: priceUSD }. */
  async function coingeckoBatch(ids, { fetchFn }) {
    const unique = [...new Set(ids)];
    const data = await getJSON(fetchFn, 'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' +
      encodeURIComponent(unique.join(',')));
    const out = {};
    for (const id of unique) if (data[id] && Number.isFinite(data[id].usd)) out[id] = data[id].usd;
    return out;
  }

  /** Finnhub quote (free key). `c` is the current price; 0 means unknown symbol. */
  async function finnhub(symbol, { fetchFn, settings }) {
    const token = requireKey(settings, 'finnhub', 'Finnhub');
    const data = await getJSON(fetchFn, `https://finnhub.io/api/v1/quote?${qs({ symbol, token })}`);
    if (!data || !(data.c > 0)) throw new Error(`No quote for ${symbol}`);
    return { price: data.c };
  }

  /** Twelve Data quote (free key). Key may be "SYMBOL:EXCHANGE"; the quote carries its currency. */
  async function twelvedata(key, { fetchFn, settings }) {
    const apikey = requireKey(settings, 'twelvedata', 'Twelve Data');
    const [symbol, exchange] = key.split(':');
    const data = await getJSON(fetchFn, `https://api.twelvedata.com/quote?${qs({ symbol, exchange, apikey })}`);
    if (data.status === 'error') throw new Error(data.message || `No quote for ${key}`);
    const price = num(data.close);
    if (!(price > 0)) throw new Error(`No quote for ${key}`);
    const { currency, divisor } = majorCurrency(data.currency);
    return { price: price / divisor, currency };
  }

  /** Alpha Vantage GLOBAL_QUOTE (free key, 25 requests/day). */
  async function alphavantage(symbol, { fetchFn, settings }) {
    const apikey = requireKey(settings, 'alphavantage', 'Alpha Vantage');
    const data = await getJSON(fetchFn, `https://www.alphavantage.co/query?${qs({ function: 'GLOBAL_QUOTE', symbol, apikey })}`);
    const limit = data.Note || data.Information || data['Error Message'];
    if (limit) throw new Error(String(limit).slice(0, 120));
    const price = num(data['Global Quote'] && data['Global Quote']['05. price']);
    if (!(price > 0)) throw new Error(`No quote for ${symbol}`);
    return { price };
  }

  /** gold-api.com spot price per troy ounce (USD), with tokenised-metal fallbacks. */
  async function metal(symbol, { fetchFn }) {
    try {
      const data = await getJSON(fetchFn, `https://api.gold-api.com/price/${encodeURIComponent(symbol)}`);
      if (data && data.price > 0) return { price: data.price, currency: 'USD' };
      throw new Error(`No spot price for ${symbol}`);
    } catch (err) {
      // PAXG and KAG are tokens backed 1:1 by a troy ounce of gold / silver.
      const token = { XAU: 'pax-gold', XAG: 'kinesis-silver' }[symbol];
      if (!token) throw err;
      const prices = await coingeckoBatch([token], { fetchFn });
      if (!prices[token]) throw err;
      return { price: prices[token], currency: 'USD' };
    }
  }

  /**
   * Pokémon TCG API: TCGplayer market price (USD). Cards list several print
   * variants (holofoil, normal, reverseHolofoil...); prefer the variant named in
   * the holding's type/details, else the priciest. Falls back to Cardmarket (EUR).
   */
  async function pokemontcg(cardId, { fetchFn, settings, holding }) {
    const key = settings.keys && settings.keys.pokemontcg;
    const data = await getJSON(fetchFn, `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`,
      key ? { 'X-Api-Key': key } : undefined);
    return pickPokemonPrice(data && data.data, holding && holding.subcategory);
  }

  function pickPokemonPrice(card, variantHint) {
    const prices = card && card.tcgplayer && card.tcgplayer.prices;
    if (prices) {
      const variants = Object.entries(prices)
        .map(([name, p]) => ({ name, price: p && (p.market || p.mid) }))
        .filter((v) => v.price > 0);
      const hint = (variantHint || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      // Longest match first, so "reverse holofoil" doesn't settle for "holofoil".
      const named = hint && variants
        .filter((v) => hint.includes(v.name.toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (named) return { price: named.price, currency: 'USD' };
      if (variants.length) return { price: Math.max(...variants.map((v) => v.price)), currency: 'USD' };
    }
    const cm = card && card.cardmarket && card.cardmarket.prices;
    if (cm && cm.trendPrice > 0) return { price: cm.trendPrice, currency: 'EUR' };
    throw new Error('No market price listed for this card');
  }

  /** Scryfall (Magic: The Gathering). Foil prices when type/details mentions foil. */
  async function scryfall(id, { fetchFn, holding }) {
    const card = await getJSON(fetchFn, `https://api.scryfall.com/cards/${encodeURIComponent(id)}`);
    return pickScryfallPrice(card, holding && holding.subcategory);
  }

  function pickScryfallPrice(card, hint) {
    const p = (card && card.prices) || {};
    const h = (hint || '').toLowerCase();
    const foil = /foil/.test(h) && !/non-?foil/.test(h);
    const etched = /etched/.test(h);
    const order = etched ? ['usd_etched', 'eur_etched', 'usd_foil', 'eur_foil']
      : foil ? ['usd_foil', 'eur_foil', 'usd', 'eur'] : ['usd', 'eur', 'usd_foil', 'eur_foil'];
    for (const k of order) {
      const v = num(p[k]);
      if (v > 0) return { price: v, currency: k.startsWith('usd') ? 'USD' : 'EUR' };
    }
    throw new Error('No market price listed for this card');
  }

  /** YGOPRODeck (Yu-Gi-Oh!): TCGplayer price, then Cardmarket (EUR), then eBay. */
  async function ygoprodeck(id, { fetchFn }) {
    const data = await getJSON(fetchFn, `https://db.ygoprodeck.com/api/v7/cardinfo.php?${qs({ id })}`);
    const prices = data && data.data && data.data[0] && data.data[0].card_prices && data.data[0].card_prices[0];
    if (prices) {
      for (const [k, cur] of [['tcgplayer_price', 'USD'], ['cardmarket_price', 'EUR'], ['ebay_price', 'USD']]) {
        const v = num(prices[k]);
        if (v > 0) return { price: v, currency: cur };
      }
    }
    throw new Error('No market price listed for this card');
  }

  /** Read a value from JSON by a path like "data.price" or "result[0].close". */
  function readPath(obj, path) {
    return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
      .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
  }

  async function custom(url, { fetchFn, holding }) {
    const data = await getJSON(fetchFn, url);
    const price = num(readPath(data, holding.pricePath));
    if (!(price > 0)) throw new Error(`No number at "${holding.pricePath}"`);
    return { price };
  }

  // ---------- price server (eBay, PriceCharting, property) ----------

  async function serverGet(settings, fetchFn, path, params) {
    const keys = settings.keys || {};
    if (!keys.priceServerUrl) throw new Error('Set up the price server in Settings to use this source.');
    const url = keys.priceServerUrl.replace(/\/+$/, '') + path + '?' + qs(params);
    const res = await fetchFn(url, keys.priceServerToken ? { headers: { 'X-App-Token': keys.priceServerToken } } : undefined);
    let body = {};
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(body.error || `Price server error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ---------- TCG API (tcgapi.dev) ----------

  const TCGAPI = 'https://api.tcgapi.dev/v1';

  async function tcgapiGet(path, params, { fetchFn, settings }) {
    const key = requireKey(settings, 'tcgapi', 'TCG API');
    const url = TCGAPI + path + (params ? '?' + qs(params) : '');
    try {
      return await getJSON(fetchFn, url, { 'X-API-Key': key });
    } catch (err) {
      // A network-level failure (no HTTP status) usually means the browser blocked a
      // cross-site request; the price server can relay it if one is set up.
      if (err.status || !(settings.keys && settings.keys.priceServerUrl)) throw err;
      return serverGet(settings, fetchFn, '/tcgapi', { path, ...(params || {}) });
    }
  }

  const listOf = (d) => (Array.isArray(d) ? d : (d && (d.data || d.results || d.cards || d.items)) || []);
  const first = (...vals) => vals.map(num).find((v) => v > 0);

  /** All priced printings of a card, whichever response shape the API used. */
  function tcgPrintings(card) {
    const out = [];
    const table = card.prices || card.printings;
    if (Array.isArray(table)) {
      for (const p of table) {
        out.push({ printing: String(p.printing || p.printing_type || p.sub_type || p.type || 'Normal'),
          price: first(p.market_price, p.price, p.median_price, p.low_price) });
      }
    } else if (table && typeof table === 'object') {
      for (const [name, p] of Object.entries(table)) {
        out.push({ printing: name, price: typeof p === 'object' && p ? first(p.market_price, p.price, p.median_price) : num(p) });
      }
    }
    const obj = card.price && typeof card.price === 'object' ? card.price : {};
    const market = first(card.market_price, obj.market_price, typeof card.price === 'object' ? NaN : card.price);
    if (market > 0 && !out.length) out.push({ printing: 'Normal', price: market });
    const foil = first(card.foil_price, obj.foil_price);
    if (foil > 0 && !out.some((p) => /foil|holo/i.test(p.printing))) out.push({ printing: 'Foil', price: foil });
    return out.filter((p) => p.price > 0);
  }

  const PRINTING_MATCH = {
    normal: (n) => /normal|unlimited/.test(n) && !/foil|holo/.test(n),
    foil: (n) => /foil|holo/.test(n) && !/reverse/.test(n),
    reverse: (n) => /reverse/.test(n),
    '1st': (n) => /1st|first/.test(n),
  };

  function pickTcgPrinting(printings, option, hint) {
    if (!printings.length) return null;
    const name = (p) => p.printing.toLowerCase();
    const match = PRINTING_MATCH[option];
    if (match) return printings.find((p) => match(name(p))) || null;
    // "Best match": a printing named in the type/details, else the first listed.
    const h = (hint || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const named = h && printings
      .filter((p) => h.includes(name(p).replace(/[^a-z0-9]/g, '')))
      .sort((a, b) => b.printing.length - a.printing.length)[0];
    return named || printings[0];
  }

  async function tcgapi(id, { fetchFn, settings, holding }) {
    const d = await tcgapiGet(`/cards/${encodeURIComponent(id)}`, null, { fetchFn, settings });
    const card = d && d.data && !Array.isArray(d.data) ? d.data : d;
    const printings = tcgPrintings(card || {});
    const pick = pickTcgPrinting(printings, holding.priceOption || 'auto', holding.subcategory);
    if (!pick) {
      throw new Error(printings.length ? `No ${holding.priceOption} printing priced (have: ${printings.map((p) => p.printing).join(', ')})`
        : 'No market price listed for this card');
    }
    return { price: pick.price, currency: 'USD' };
  }

  async function tcgapiHistory(id, { fetchFn, settings, holding }) {
    const d = await tcgapiGet(`/cards/${encodeURIComponent(id)}/history`, null, { fetchFn, settings });
    const rows = listOf(d && d.data && !Array.isArray(d.data) ? (d.data.history || d.data.prices || []) : d);
    // Keep the printing that the current price uses, when rows say which one they are.
    const printings = [...new Set(rows.map((r) => r.printing).filter(Boolean))].map((printing) => ({ printing, price: 1 }));
    const pick = pickTcgPrinting(printings, holding.priceOption || 'auto', holding.subcategory);
    const chosen = rows.filter((r) => !pick || !r.printing || r.printing === pick.printing);
    return {
      points: dailyPoints(chosen.map((r) => [String(r.date || r.recorded_at || '').slice(0, 10), first(r.market_price, r.price, r.avg_sales_price)])),
      currency: 'USD',
    };
  }

  // Search eBay's site for the holding's currency so prices are local.
  const EBAY_MARKETS = { AUD: 'EBAY_AU', GBP: 'EBAY_GB', EUR: 'EBAY_DE', CAD: 'EBAY_CA' };

  async function ebay(query, { fetchFn, settings, holding }) {
    const d = await serverGet(settings, fetchFn, '/ebay', {
      q: query, mode: holding.priceOption || 'sold', marketplace: EBAY_MARKETS[holding.currency] || 'EBAY_US',
    });
    return { price: d.price, currency: d.currency, detail: d };
  }

  async function pricecharting(id, { fetchFn, settings, holding }) {
    const d = await serverGet(settings, fetchFn, '/pricecharting', { id });
    const grade = holding.priceOption || 'ungraded';
    const price = d.prices && d.prices[grade];
    if (!(price > 0)) {
      const label = (Portfolio.SOURCES.pricecharting.options.find(([v]) => v === grade) || [, grade])[1];
      throw new Error(`No ${label} price for this item on PriceCharting`);
    }
    return { price, currency: d.currency || 'USD', detail: d };
  }

  /** Area median at or before a date (or the earliest one if the date is older). */
  function medianAt(history, date) {
    let best = history[0];
    for (const p of history) if (p.date <= date) best = p;
    return best;
  }

  /**
   * Property: either the area median itself, or the purchase price scaled by
   * how much the area median has moved since the purchase date.
   */
  async function property(location, { fetchFn, settings, holding }) {
    const d = await serverGet(settings, fetchFn, '/property', { location, type: holding.priceOption || 'house' });
    const base = growthBase(holding, d.history || []);
    if (holding.priceMethod === 'growth' && base) {
      return { price: base.price * (d.price / base.median.price), currency: holding.currency, detail: d };
    }
    return { price: d.price, currency: d.currency, detail: d };
  }

  function growthBase(holding, history) {
    const buy = holding.transactions && [...holding.transactions]
      .filter((t) => t.type === 'buy' && t.price > 0).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    if (!buy || !history.length) return null;
    return { price: buy.price, date: buy.date, median: medianAt(history, buy.date) };
  }

  const PROVIDERS = { tcgapi, ebay, pricecharting, property, finnhub, twelvedata, alphavantage, metal, pokemontcg, scryfall, ygoprodeck, custom };

  /**
   * Refresh every auto-priced holding. Returns new holding objects; failures
   * keep the last known price and record `priceError` instead of throwing.
   * `rates` (units per USD) converts quotes into each holding's currency.
   */
  async function refreshAll(holdings, { settings = {}, fetchFn = globalThis.fetch.bind(globalThis), now = new Date(), rates = null } = {}) {
    const ctx = { fetchFn, settings };
    const stamp = now.toISOString();
    const convert = Portfolio.makeConverter(rates);

    // Batch crypto into one call to stay well inside CoinGecko's free rate limit.
    const cryptoIds = holdings.filter((h) => h.priceSource === 'coingecko').map((h) => h.priceKey);
    let crypto = {};
    let cryptoErr = null;
    if (cryptoIds.length) {
      try { crypto = await coingeckoBatch(cryptoIds, ctx); } catch (err) { cryptoErr = err; }
    }

    // Dedupe identical lookups (e.g. two gold holdings) so each hits the API once.
    const cache = new Map();
    const lookup = (key, fn) => {
      if (!cache.has(key)) cache.set(key, fn());
      return cache.get(key);
    };

    return Promise.all(holdings.map(async (h) => {
      if (h.priceSource === 'manual' || h.priceSource === 'cash') return h;
      try {
        let quote;
        if (h.priceSource === 'coingecko') {
          if (cryptoErr) throw cryptoErr;
          if (!(h.priceKey in crypto)) throw new Error(`Unknown CoinGecko id "${h.priceKey}"`);
          quote = { price: crypto[h.priceKey], currency: 'USD' };
        } else {
          const provider = PROVIDERS[h.priceSource];
          if (!provider) return h;
          const variant = ['pokemontcg', 'scryfall', 'custom', 'ebay', 'pricecharting', 'property', 'tcgapi'].includes(h.priceSource)
            ? [h.subcategory, h.pricePath, h.priceOption, h.priceMethod, h.currency, h.id].join('|') : '';
          quote = await lookup(h.priceSource + ':' + h.priceKey + variant, () => provider(h.priceKey, { ...ctx, holding: h }));
          const pence = PENCE_SUFFIX[h.priceSource];
          if (pence && pence.test(h.priceKey)) quote = { price: quote.price / 100, currency: 'GBP' };
        }
        const quoteCurrency = quote.currency || h.currency;
        let price = convert(quote.price, quoteCurrency, h.currency);
        if (price === null) throw new Error(`No exchange rate for ${quoteCurrency} → ${h.currency}`);
        if (h.priceSource === 'metal') price = Portfolio.metalPricePerUnit(price, h.unit);
        return { ...h, currentPrice: price, priceUpdatedAt: stamp, priceError: null };
      } catch (err) {
        return { ...h, priceError: err.message || String(err) };
      }
    }));
  }


  // ---------- price history ----------

  const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  /** One point per day (last wins), sorted. */
  function dailyPoints(pairs) {
    const byDay = new Map();
    for (const [date, price] of pairs) if (price > 0) byDay.set(date, price);
    return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, price]) => ({ date, price }));
  }

  async function coingeckoHistory(id, { fetchFn, days }) {
    // The free public API serves up to 365 days of daily prices.
    const d = await getJSON(fetchFn, `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?${qs({ vs_currency: 'usd', days: Math.min(days, 365), interval: 'daily' })}`);
    return { points: dailyPoints((d.prices || []).map(([ms, price]) => [toDay(ms), price])), currency: 'USD' };
  }

  async function twelvedataHistory(key, { fetchFn, settings, days }) {
    const apikey = requireKey(settings, 'twelvedata', 'Twelve Data');
    const [symbol, exchange] = key.split(':');
    const d = await getJSON(fetchFn, `https://api.twelvedata.com/time_series?${qs({ symbol, exchange, interval: '1day', outputsize: Math.min(days, 5000), apikey })}`);
    if (d.status === 'error') throw new Error(d.message || `No history for ${key}`);
    const { currency, divisor } = majorCurrency(d.meta && d.meta.currency);
    return { points: dailyPoints((d.values || []).map((v) => [v.datetime.slice(0, 10), num(v.close) / divisor])), currency };
  }

  async function alphavantageHistory(symbol, { fetchFn, settings, days }) {
    const apikey = requireKey(settings, 'alphavantage', 'Alpha Vantage');
    // "compact" (last 100 trading days) is the free tier's limit.
    const d = await getJSON(fetchFn, `https://www.alphavantage.co/query?${qs({ function: 'TIME_SERIES_DAILY', symbol, outputsize: days > 100 ? 'full' : 'compact', apikey })}`);
    const limit = d.Note || d.Information || d['Error Message'];
    const series = d['Time Series (Daily)'];
    if (!series) throw new Error(String(limit || `No history for ${symbol}`).slice(0, 120));
    return { points: dailyPoints(Object.entries(series).map(([date, v]) => [date, num(v['4. close'])])), currency: undefined };
  }

  /** Which history source (if any) can serve a holding. */
  function historySource(h, settings = {}) {
    const keys = settings.keys || {};
    switch (h.priceSource) {
      case 'coingecko': return { kind: 'coingecko', id: h.priceKey };
      case 'metal': {
        // Tokens backed 1:1 by a troy ounce track the spot price closely.
        const token = { XAU: 'pax-gold', XAG: 'kinesis-silver' }[h.priceKey];
        return token ? { kind: 'coingecko', id: token } : null;
      }
      case 'property': return keys.priceServerUrl ? { kind: 'property', id: h.priceKey } : null;
      case 'tcgapi': return keys.tcgapi ? { kind: 'tcgapi', id: h.priceKey } : null;
      case 'twelvedata': return keys.twelvedata ? { kind: 'twelvedata', id: h.priceKey } : null;
      case 'alphavantage': return keys.alphavantage ? { kind: 'alphavantage', id: h.priceKey } : null;
      // Finnhub's free tier has no history; borrow another stock source if a key exists.
      case 'finnhub':
        if (keys.twelvedata) return { kind: 'twelvedata', id: h.priceKey.replace(/\.L$/, ':LSE') };
        if (keys.alphavantage) return { kind: 'alphavantage', id: h.priceKey.replace(/\.L$/, '.LON') };
        return null;
      default: return null;
    }
  }

  const HISTORY_FETCHERS = { tcgapi: tcgapiHistory, coingecko: coingeckoHistory, twelvedata: twelvedataHistory, alphavantage: alphavantageHistory };

  /**
   * Daily price history for a holding, in the holding's own currency and unit.
   * Returns null when no free history source exists for it.
   */
  async function fetchHistory(h, { fetchFn = globalThis.fetch.bind(globalThis), settings = {}, rates = null, days = 365 } = {}) {
    const src = historySource(h, settings);
    if (!src) return null;
    const convert = Portfolio.makeConverter(rates);
    if (src.kind === 'property') {
      const d = await serverGet(settings, fetchFn, '/property', { location: h.priceKey, type: h.priceOption || 'house' });
      const history = d.history || [];
      const base = growthBase(h, history);
      if (h.priceMethod === 'growth' && base) {
        return history.map((p) => ({ date: p.date, price: base.price * (p.price / base.median.price) }));
      }
      const rate = convert(1, d.currency, h.currency);
      if (rate === null) throw new Error(`No exchange rate for ${d.currency} → ${h.currency}`);
      return history.map((p) => ({ date: p.date, price: p.price * rate }));
    }
    const { points, currency } = await HISTORY_FETCHERS[src.kind](src.id, { fetchFn, settings, days, holding: h });
    let quoteCurrency = currency || h.currency;
    let divisor = 1;
    const pence = PENCE_SUFFIX[src.kind];
    if (!currency && pence && pence.test(src.id)) { quoteCurrency = 'GBP'; divisor = 100; }
    // Past prices are converted at today's exchange rate.
    const rate = convert(1, quoteCurrency, h.currency);
    if (rate === null) throw new Error(`No exchange rate for ${quoteCurrency} → ${h.currency}`);
    const unit = h.priceSource === 'metal' ? Portfolio.metalPricePerUnit(1, h.unit) : 1;
    return points.map((p) => ({ date: p.date, price: (p.price / divisor) * rate * unit }));
  }

  // ---------- search ----------

  /**
   * Search a source for instruments/cards. Returns up to 20 of
   * { key, name, detail, currency? } — `key` goes into the holding's priceKey.
   */
  async function search(source, query, { fetchFn = globalThis.fetch.bind(globalThis), settings = {} } = {}) {
    const q = query.trim();
    if (!q) return [];
    const notFoundIsEmpty = async (p) => {
      try { return await p; } catch (err) { if (err.status === 404 || err.status === 400) return null; throw err; }
    };
    switch (source) {
      case 'coingecko': {
        const d = await getJSON(fetchFn, `https://api.coingecko.com/api/v3/search?${qs({ query: q })}`);
        return (d.coins || []).slice(0, 20).map((c) => ({
          key: c.id, name: c.name, detail: `${c.symbol}${c.market_cap_rank ? ' · rank #' + c.market_cap_rank : ''}`,
        }));
      }
      case 'finnhub': {
        const token = requireKey(settings, 'finnhub', 'Finnhub');
        const d = await getJSON(fetchFn, `https://finnhub.io/api/v1/search?${qs({ q, token })}`);
        return (d.result || []).slice(0, 20).map((r) => ({ key: r.symbol, name: r.description, detail: `${r.displaySymbol} · ${r.type || ''}` }));
      }
      case 'twelvedata': {
        const d = await getJSON(fetchFn, `https://api.twelvedata.com/symbol_search?${qs({ symbol: q, outputsize: 20 })}`);
        return (d.data || []).slice(0, 20).map((r) => ({
          key: `${r.symbol}:${r.exchange}`, name: r.instrument_name,
          detail: `${r.symbol} · ${r.exchange} · ${r.country || ''} · ${r.instrument_type || ''}`, currency: majorCurrency(r.currency).currency,
        }));
      }
      case 'alphavantage': {
        const apikey = requireKey(settings, 'alphavantage', 'Alpha Vantage');
        const d = await getJSON(fetchFn, `https://www.alphavantage.co/query?${qs({ function: 'SYMBOL_SEARCH', keywords: q, apikey })}`);
        if (d.Note || d.Information) throw new Error(String(d.Note || d.Information).slice(0, 120));
        return (d.bestMatches || []).slice(0, 20).map((r) => ({
          key: r['1. symbol'], name: r['2. name'], detail: `${r['1. symbol']} · ${r['4. region']} · ${r['3. type']}`, currency: majorCurrency(r['8. currency']).currency,
        }));
      }
      case 'pokemontcg': {
        const words = q.replace(/"/g, '').split(/\s+/);
        const expr = words.length === 1 ? `name:${words[0]}*` : `name:"${words.join(' ')}"`;
        const key = settings.keys && settings.keys.pokemontcg;
        const d = await notFoundIsEmpty(getJSON(fetchFn,
          `https://api.pokemontcg.io/v2/cards?${qs({ q: expr, pageSize: 20, orderBy: '-set.releaseDate', select: 'id,name,number,set,rarity' })}`,
          key ? { 'X-Api-Key': key } : undefined));
        return ((d && d.data) || []).map((c) => ({
          key: c.id, name: c.name, detail: `${c.set ? c.set.name : ''} · #${c.number}${c.rarity ? ' · ' + c.rarity : ''}`,
        }));
      }
      case 'scryfall': {
        const d = await notFoundIsEmpty(getJSON(fetchFn, `https://api.scryfall.com/cards/search?${qs({ q, unique: 'prints', order: 'released' })}`));
        return ((d && d.data) || []).slice(0, 20).map((c) => ({
          key: c.id, name: c.name, detail: `${c.set_name} · #${c.collector_number}${c.prices && c.prices.usd ? ' · $' + c.prices.usd : ''}`,
        }));
      }
      case 'ygoprodeck': {
        const d = await notFoundIsEmpty(getJSON(fetchFn, `https://db.ygoprodeck.com/api/v7/cardinfo.php?${qs({ fname: q, num: 20, offset: 0 })}`));
        return ((d && d.data) || []).map((c) => ({ key: String(c.id), name: c.name, detail: c.type || '' }));
      }
      case 'tcgapi': {
        const d = await tcgapiGet('/search', { q, limit: 20 }, { fetchFn, settings });
        return listOf(d).slice(0, 20).map((c) => {
          const set = typeof c.set === 'object' && c.set ? c.set.name : c.set || c.set_name;
          const game = typeof c.game === 'object' && c.game ? c.game.name : c.game || c.game_name;
          const price = first(c.market_price, c.price && typeof c.price === 'object' ? c.price.market_price : c.price);
          return {
            key: String(c.id), name: c.name,
            detail: [game, set, c.number ? '#' + c.number : '', c.rarity, price ? '$' + price.toFixed(2) : ''].filter(Boolean).join(' · '),
          };
        });
      }
      case 'pricecharting': {
        const d = await serverGet(settings, fetchFn, '/pricecharting/search', { q });
        return (d.products || []).map((p) => ({ key: p.id, name: p.name, detail: p.set }));
      }
      default:
        return [];
    }
  }

  /**
   * Try a lookup without saving it, so the user can check an eBay search or
   * a property location. Returns { price, currency, summary, items }.
   */
  async function test(source, key, holding, { fetchFn = globalThis.fetch.bind(globalThis), settings = {} } = {}) {
    const provider = PROVIDERS[source];
    if (!provider) throw new Error('Nothing to test for this source.');
    const { price, currency, detail } = await provider(key, { fetchFn, settings, holding });
    const d = detail || {};
    if (source === 'ebay') {
      return {
        price, currency,
        summary: `Median of ${d.count} ${d.mode === 'sold' ? 'sold items' : 'current listings'}` +
          (d.low ? ` (range ${d.low}–${d.high} ${d.currency})` : '') + (d.dropped ? `, ${d.dropped} outliers ignored` : '') +
          (d.note ? `. ${d.note}` : ''),
        items: (d.samples || []).map((i) => ({ name: i.title, detail: `${i.price} ${i.currency}${i.date ? ' · sold ' + i.date : ''}`, url: i.url })),
      };
    }
    if (source === 'property') {
      return {
        price, currency,
        summary: `${d.area}: latest ${d.currency} ${Math.round(d.price).toLocaleString()} (${d.period}). ${d.source}.` +
          (holding.priceMethod === 'growth' ? ' Your value is your purchase price × the change in the area price since you bought.' : ''),
        items: (d.history || []).slice(-8).reverse().map((p) => ({ name: p.date, detail: `${d.currency} ${Math.round(p.price).toLocaleString()}` })),
      };
    }
    return { price, currency, summary: '', items: [] };
  }

  return {
    refreshAll, fetchRates, search, test, tcgPrintings, pickTcgPrinting, readPath, majorCurrency, fetchHistory, historySource, medianAt, pickPokemonPrice, pickScryfallPrice,
    coingeckoBatch, finnhub, twelvedata, alphavantage, metal, pokemontcg, scryfall, ygoprodeck, custom,
  };
});
