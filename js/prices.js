/*
 * Live price providers. Every provider is free and callable straight from the
 * browser (CORS-enabled). `fetch` is injectable so the parsing is testable.
 * All prices are returned in USD per the source's native unit.
 */
(function (root, factory) {
  const api = factory(root.Portfolio || (typeof require === 'function' ? require('./portfolio.js') : null));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Prices = api;
})(typeof self !== 'undefined' ? self : this, function (Portfolio) {
  'use strict';

  async function getJSON(fetchFn, url, headers) {
    const res = await fetchFn(url, headers ? { headers } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return res.json();
  }

  /** CoinGecko: one request for all coins. Returns { coinId: priceUSD }. */
  async function coingecko(ids, { fetchFn }) {
    const unique = [...new Set(ids)];
    const url = 'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' +
      encodeURIComponent(unique.join(','));
    const data = await getJSON(fetchFn, url);
    const out = {};
    for (const id of unique) {
      if (data[id] && Number.isFinite(data[id].usd)) out[id] = data[id].usd;
    }
    return out;
  }

  /** Finnhub quote endpoint (free key). `c` is the current price; 0 means unknown symbol. */
  async function finnhub(symbol, { fetchFn, settings }) {
    if (!settings.finnhubKey) throw new Error('Add a free Finnhub API key in Settings to price stocks.');
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(settings.finnhubKey)}`;
    const data = await getJSON(fetchFn, url);
    if (!data || !(data.c > 0)) throw new Error(`No quote for ${symbol}`);
    return data.c;
  }

  /** gold-api.com spot price per troy ounce, with PAX Gold as a gold fallback. */
  async function metal(symbol, { fetchFn }) {
    try {
      const data = await getJSON(fetchFn, `https://api.gold-api.com/price/${encodeURIComponent(symbol)}`);
      if (data && data.price > 0) return data.price;
      throw new Error(`No spot price for ${symbol}`);
    } catch (err) {
      // PAXG is a token backed 1:1 by a troy ounce of gold, so it tracks spot closely.
      if (symbol !== 'XAU') throw err;
      const prices = await coingecko(['pax-gold'], { fetchFn });
      if (!prices['pax-gold']) throw err;
      return prices['pax-gold'];
    }
  }

  /**
   * Pokémon TCG API: TCGplayer market price. Cards list several print variants
   * (holofoil, normal, reverseHolofoil, 1stEditionHolofoil...); prefer the
   * variant the user named in the subcategory, else the priciest one listed.
   */
  async function pokemontcg(cardId, { fetchFn, settings, holding }) {
    const headers = settings.pokemonKey ? { 'X-Api-Key': settings.pokemonKey } : undefined;
    const data = await getJSON(fetchFn, `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(cardId)}`, headers);
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
      if (named) return named.price;
      if (variants.length) return Math.max(...variants.map((v) => v.price));
    }
    const cm = card && card.cardmarket && card.cardmarket.prices;
    if (cm && cm.trendPrice > 0) return cm.trendPrice; // EUR, better than nothing
    throw new Error('No market price listed for this card');
  }

  /**
   * Refresh every auto-priced holding. Returns new holding objects; failures
   * keep the last known price and record `priceError` instead of throwing.
   */
  async function refreshAll(holdings, { settings = {}, fetchFn = globalThis.fetch.bind(globalThis), now = new Date() } = {}) {
    const ctx = { fetchFn, settings };
    const stamp = now.toISOString();
    const ok = (h, price) => ({ ...h, currentPrice: price, priceUpdatedAt: stamp, priceError: null });
    const fail = (h, err) => ({ ...h, priceError: err.message || String(err) });

    // Batch crypto into one call to stay well inside CoinGecko's free rate limit.
    const cryptoIds = holdings.filter((h) => h.priceSource === 'coingecko').map((h) => h.priceKey);
    let crypto = {};
    let cryptoErr = null;
    if (cryptoIds.length) {
      try { crypto = await coingecko(cryptoIds, ctx); } catch (err) { cryptoErr = err; }
    }

    // Dedupe identical lookups (e.g. two gold holdings) so each hits the API once.
    const cache = new Map();
    const lookup = (key, fn) => {
      if (!cache.has(key)) cache.set(key, fn());
      return cache.get(key);
    };

    const updated = await Promise.all(holdings.map(async (h) => {
      try {
        switch (h.priceSource) {
          case 'coingecko':
            if (cryptoErr) throw cryptoErr;
            if (!(h.priceKey in crypto)) throw new Error(`Unknown CoinGecko id "${h.priceKey}"`);
            return ok(h, crypto[h.priceKey]);
          case 'finnhub':
            return ok(h, await lookup('f:' + h.priceKey, () => finnhub(h.priceKey, ctx)));
          case 'metal': {
            const perOzt = await lookup('m:' + h.priceKey, () => metal(h.priceKey, ctx));
            return ok(h, Portfolio.metalPricePerUnit(perOzt, h.unit));
          }
          case 'pokemontcg':
            return ok(h, await lookup('p:' + h.priceKey + '|' + h.subcategory, () => pokemontcg(h.priceKey, { ...ctx, holding: h })));
          default:
            return h;
        }
      } catch (err) {
        return fail(h, err);
      }
    }));
    return updated;
  }

  return { refreshAll, coingecko, finnhub, metal, pokemontcg, pickPokemonPrice };
});
