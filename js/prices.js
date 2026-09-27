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

  const PROVIDERS = { finnhub, twelvedata, alphavantage, metal, pokemontcg, scryfall, ygoprodeck, custom };

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
          const variant = ['pokemontcg', 'scryfall', 'custom'].includes(h.priceSource) ? '|' + h.subcategory + '|' + h.pricePath : '';
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
      default:
        return [];
    }
  }

  return {
    refreshAll, fetchRates, search, readPath, majorCurrency, pickPokemonPrice, pickScryfallPrice,
    coingeckoBatch, finnhub, twelvedata, alphavantage, metal, pokemontcg, scryfall, ygoprodeck, custom,
  };
});
