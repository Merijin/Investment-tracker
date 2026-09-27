const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/portfolio.js');
const Prices = require('../js/prices.js');

/** Fake fetch that serves canned JSON by URL prefix and records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const body = routes[hit];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const h = (o) => P.normalizeHolding({ name: 'x', quantity: 1, ...o });
const now = new Date('2025-01-01T00:00:00Z');

test('crypto prices are fetched in a single batched request', async () => {
  const fetchFn = fakeFetch({ 'https://api.coingecko.com/': { bitcoin: { usd: 60000 }, ethereum: { usd: 3000 } } });
  const out = await Prices.refreshAll([
    h({ category: 'crypto', priceSource: 'coingecko', priceKey: 'bitcoin' }),
    h({ category: 'crypto', priceSource: 'coingecko', priceKey: 'ethereum' }),
    h({ category: 'crypto', priceSource: 'coingecko', priceKey: 'notacoin' }),
  ], { fetchFn, now });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(out[0].currentPrice, 60000);
  assert.equal(out[0].priceUpdatedAt, now.toISOString());
  assert.equal(out[1].currentPrice, 3000);
  assert.match(out[2].priceError, /Unknown CoinGecko id/);
});

test('metal prices convert to the holding unit and dedupe requests', async () => {
  const fetchFn = fakeFetch({ 'https://api.gold-api.com/price/XAU': { price: 3110.34768 } });
  const out = await Prices.refreshAll([
    h({ category: 'metal', priceSource: 'metal', priceKey: 'XAU', unit: 'ozt' }),
    h({ category: 'metal', priceSource: 'metal', priceKey: 'XAU', unit: 'g' }),
  ], { fetchFn, now });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(out[0].currentPrice, 3110.34768);
  assert.ok(Math.abs(out[1].currentPrice - 100) < 1e-9);
});

test('gold falls back to PAX Gold when the spot API fails', async () => {
  const fetchFn = fakeFetch({
    'https://api.gold-api.com/': new Error('network down'),
    'https://api.coingecko.com/': { 'pax-gold': { usd: 2500 } },
  });
  const [gold] = await Prices.refreshAll([h({ category: 'metal', priceSource: 'metal', priceKey: 'XAU' })], { fetchFn, now });
  assert.equal(gold.currentPrice, 2500);
});

test('stocks need a Finnhub key; failures keep the last price', async () => {
  const stock = h({ category: 'stock', priceSource: 'finnhub', priceKey: 'AAPL', currentPrice: 100 });
  const [noKey] = await Prices.refreshAll([stock], { fetchFn: fakeFetch({}), now });
  assert.equal(noKey.currentPrice, 100);
  assert.match(noKey.priceError, /Finnhub API key/);

  const fetchFn = fakeFetch({ 'https://finnhub.io/api/v1/quote?symbol=AAPL': { c: 230.1 } });
  const [ok] = await Prices.refreshAll([stock], { fetchFn, now, settings: { finnhubKey: 'k' } });
  assert.equal(ok.currentPrice, 230.1);
  assert.equal(ok.priceError, null);
  assert.ok(fetchFn.calls[0].includes('token=k'));
});

test('manual holdings are left untouched', async () => {
  const manual = h({ category: 'collectible', currentPrice: 42 });
  const [out] = await Prices.refreshAll([manual], { fetchFn: fakeFetch({}), now });
  assert.equal(out, manual);
});

test('Pokémon price prefers the named variant, else the highest market price', () => {
  const card = { tcgplayer: { prices: { normal: { market: 5 }, holofoil: { market: 40 }, reverseHolofoil: { market: 12 } } } };
  assert.equal(Prices.pickPokemonPrice(card, 'Reverse Holofoil'), 12);
  assert.equal(Prices.pickPokemonPrice(card, 'Pokémon card'), 40);
  assert.equal(Prices.pickPokemonPrice({ cardmarket: { prices: { trendPrice: 9 } } }), 9);
  assert.throws(() => Prices.pickPokemonPrice({}), /No market price/);
});

test('Pokémon TCG refresh reads the card endpoint', async () => {
  const fetchFn = fakeFetch({ 'https://api.pokemontcg.io/v2/cards/base1-4': { data: { tcgplayer: { prices: { holofoil: { market: 410 } } } } } });
  const [card] = await Prices.refreshAll([h({ category: 'collectible', priceSource: 'pokemontcg', priceKey: 'base1-4' })], { fetchFn, now });
  assert.equal(card.currentPrice, 410);
});
