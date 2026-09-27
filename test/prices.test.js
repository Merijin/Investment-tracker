const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/portfolio.js');
const Prices = require('../js/prices.js');

/** Fake fetch that serves canned JSON by URL prefix and records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const body = routes[hit];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const h = (o) => P.normalizeHolding({ name: 'x', transactions: [{ type: 'buy', quantity: 1, price: 1 }], ...o });
const now = new Date('2025-01-01T00:00:00Z');
const keys = { finnhub: 'fk', twelvedata: 'tk', alphavantage: 'ak' };

test('crypto prices are fetched in one batched request', async () => {
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

test('USD quotes are converted into the holding currency', async () => {
  const fetchFn = fakeFetch({ 'https://api.coingecko.com/': { bitcoin: { usd: 60000 } } });
  const [eur, jpy] = await Prices.refreshAll([
    h({ category: 'crypto', priceSource: 'coingecko', priceKey: 'bitcoin', currency: 'EUR' }),
    h({ category: 'crypto', priceSource: 'coingecko', priceKey: 'bitcoin', currency: 'JPY' }),
  ], { fetchFn, now, rates: { EUR: 0.9 } });
  assert.equal(eur.currentPrice, 54000);
  assert.match(jpy.priceError, /No exchange rate for USD → JPY/);
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

test('gold and silver fall back to tokenised metals when the spot API fails', async () => {
  const fetchFn = fakeFetch({
    'https://api.gold-api.com/': new Error('network down'),
    'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=pax-gold': { 'pax-gold': { usd: 2500 } },
    'https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=kinesis-silver': { 'kinesis-silver': { usd: 30 } },
  });
  const [gold, silver, plat] = await Prices.refreshAll([
    h({ category: 'metal', priceSource: 'metal', priceKey: 'XAU' }),
    h({ category: 'metal', priceSource: 'metal', priceKey: 'XAG' }),
    h({ category: 'metal', priceSource: 'metal', priceKey: 'XPT' }),
  ], { fetchFn, now });
  assert.equal(gold.currentPrice, 2500);
  assert.equal(silver.currentPrice, 30);
  assert.match(plat.priceError, /network down/);
});

test('Finnhub needs a key; failures keep the last price', async () => {
  const stock = h({ priceSource: 'finnhub', priceKey: 'AAPL', currentPrice: 100 });
  const [noKey] = await Prices.refreshAll([stock], { fetchFn: fakeFetch({}), now });
  assert.equal(noKey.currentPrice, 100);
  assert.match(noKey.priceError, /Finnhub API key/);

  const fetchFn = fakeFetch({ 'https://finnhub.io/api/v1/quote?symbol=AAPL': { c: 230.1 } });
  const [ok] = await Prices.refreshAll([stock], { fetchFn, now, settings: { keys } });
  assert.equal(ok.currentPrice, 230.1);
  assert.equal(ok.priceError, null);
  assert.ok(fetchFn.calls[0].url.includes('token=fk'));
});

test('Twelve Data splits SYMBOL:EXCHANGE and uses the quote currency', async () => {
  const fetchFn = fakeFetch({ 'https://api.twelvedata.com/quote?symbol=VOD&exchange=LSE': { close: '0.70', currency: 'GBP' } });
  const [vod] = await Prices.refreshAll([h({ priceSource: 'twelvedata', priceKey: 'vod:lse', currency: 'USD' })],
    { fetchFn, now, settings: { keys }, rates: { GBP: 0.8 } });
  assert.ok(Math.abs(vod.currentPrice - 0.875) < 1e-9);
  const errFetch = fakeFetch({ 'https://api.twelvedata.com/': { status: 'error', message: 'symbol not found' } });
  const [bad] = await Prices.refreshAll([h({ priceSource: 'twelvedata', priceKey: 'ZZZ' })], { fetchFn: errFetch, now, settings: { keys } });
  assert.match(bad.priceError, /symbol not found/);
});

test('Alpha Vantage parses GLOBAL_QUOTE and surfaces rate-limit notes', async () => {
  const ok = fakeFetch({ 'https://www.alphavantage.co/': { 'Global Quote': { '05. price': '123.4500' } } });
  assert.deepEqual(await Prices.alphavantage('IBM', { fetchFn: ok, settings: { keys } }), { price: 123.45 });
  const limited = fakeFetch({ 'https://www.alphavantage.co/': { Information: 'rate limit reached' } });
  await assert.rejects(Prices.alphavantage('IBM', { fetchFn: limited, settings: { keys } }), /rate limit/);
});

test('manual and cash holdings are left untouched', async () => {
  const manual = h({ category: 'collectible', currentPrice: 42 });
  const cash = h({ category: 'cash', priceSource: 'cash', currency: 'EUR' });
  const out = await Prices.refreshAll([manual, cash], { fetchFn: fakeFetch({}), now });
  assert.equal(out[0], manual);
  assert.equal(out[1], cash);
});

test('Pokémon price prefers the named variant, else the highest; Cardmarket is EUR', () => {
  const card = { tcgplayer: { prices: { normal: { market: 5 }, holofoil: { market: 40 }, reverseHolofoil: { market: 12 } } } };
  assert.deepEqual(Prices.pickPokemonPrice(card, 'Reverse Holofoil'), { price: 12, currency: 'USD' });
  assert.deepEqual(Prices.pickPokemonPrice(card, 'Pokémon card'), { price: 40, currency: 'USD' });
  assert.deepEqual(Prices.pickPokemonPrice({ cardmarket: { prices: { trendPrice: 9 } } }), { price: 9, currency: 'EUR' });
  assert.throws(() => Prices.pickPokemonPrice({}), /No market price/);
});

test('Scryfall picks foil / non-foil prices', () => {
  const card = { prices: { usd: '1.50', usd_foil: '4.00', eur: '1.20', usd_etched: null } };
  assert.deepEqual(Prices.pickScryfallPrice(card, ''), { price: 1.5, currency: 'USD' });
  assert.deepEqual(Prices.pickScryfallPrice(card, 'MTG card — Foil'), { price: 4, currency: 'USD' });
  assert.deepEqual(Prices.pickScryfallPrice(card, 'non-foil'), { price: 1.5, currency: 'USD' });
  assert.deepEqual(Prices.pickScryfallPrice({ prices: { eur: '2' } }, ''), { price: 2, currency: 'EUR' });
});

test('YGOPRODeck and custom JSON sources', async () => {
  const ygo = fakeFetch({ 'https://db.ygoprodeck.com/': { data: [{ card_prices: [{ tcgplayer_price: '0.00', cardmarket_price: '3.10' }] }] } });
  assert.deepEqual(await Prices.ygoprodeck('46986414', { fetchFn: ygo }), { price: 3.1, currency: 'EUR' });

  const custom = fakeFetch({ 'https://example.com/api': { result: [{ close: 42.5 }] } });
  const [c] = await Prices.refreshAll([h({ priceSource: 'custom', priceKey: 'https://example.com/api', pricePath: 'result[0].close', currency: 'CHF' })],
    { fetchFn: custom, now });
  assert.equal(c.currentPrice, 42.5);
  assert.equal(Prices.readPath({ a: { b: [1, { c: 7 }] } }, 'a.b[1].c'), 7);
});

test('fetchRates normalises codes and falls back between providers', async () => {
  const table = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['c' + String.fromCharCode(97 + (i % 26)) + i, 1 + i]));
  const primary = fakeFetch({ 'https://cdn.jsdelivr.net/': { date: '2025-01-01', usd: { eur: 0.9, gbp: 0.8, ...table } } });
  const r = await Prices.fetchRates({ fetchFn: primary });
  assert.equal(r.rates.EUR, 0.9);
  assert.equal(r.rates.USD, 1);

  const fallback = fakeFetch({ 'https://open.er-api.com/': { result: 'success', rates: { EUR: 0.91, ...table } } });
  const r2 = await Prices.fetchRates({ fetchFn: fallback });
  assert.equal(r2.rates.EUR, 0.91);
  assert.equal(fallback.calls.length, 3);
});

test('search maps each provider to { key, name, detail }', async () => {
  const fetchFn = fakeFetch({
    'https://api.coingecko.com/api/v3/search': { coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', market_cap_rank: 1 }] },
    'https://api.twelvedata.com/symbol_search': { data: [{ symbol: 'VOD', instrument_name: 'Vodafone', exchange: 'LSE', country: 'UK', instrument_type: 'Common Stock', currency: 'GBp' }] },
    'https://api.pokemontcg.io/v2/cards?': { data: [{ id: 'base1-4', name: 'Charizard', number: '4', set: { name: 'Base' }, rarity: 'Rare Holo' }] },
    'https://api.scryfall.com/cards/search': { data: [{ id: 'abc', name: 'Black Lotus', set_name: 'Alpha', collector_number: '232', prices: { usd: null } }] },
  });
  assert.deepEqual((await Prices.search('coingecko', 'bit', { fetchFn }))[0], { key: 'bitcoin', name: 'Bitcoin', detail: 'BTC · rank #1' });
  const td = (await Prices.search('twelvedata', 'vod', { fetchFn }))[0];
  assert.equal(td.key, 'VOD:LSE');
  assert.equal(td.currency, 'GBP', 'pence listings map to pounds');
  const poke = await Prices.search('pokemontcg', 'charizard', { fetchFn });
  assert.equal(poke[0].key, 'base1-4');
  assert.ok(fetchFn.calls.find((c) => c.url.startsWith('https://api.pokemontcg.io')).url.includes(encodeURIComponent('name:charizard*')));
  assert.equal((await Prices.search('scryfall', 'lotus', { fetchFn }))[0].key, 'abc');
  // 404 "no results" from card APIs is an empty list, not an error
  assert.deepEqual(await Prices.search('ygoprodeck', 'zzzz', { fetchFn }), []);
  await assert.rejects(Prices.search('finnhub', 'apple', { fetchFn }), /Finnhub API key/);
});

test('prices quoted in pence are converted to pounds', async () => {
  const td = fakeFetch({ 'https://api.twelvedata.com/quote': { close: '250', currency: 'GBp' } });
  const [a] = await Prices.refreshAll([h({ priceSource: 'twelvedata', priceKey: 'TSCO:LSE', currency: 'GBP' })], { fetchFn: td, now, settings: { keys } });
  assert.equal(a.currentPrice, 2.5);
  const av = fakeFetch({ 'https://www.alphavantage.co/': { 'Global Quote': { '05. price': '250' } } });
  const [b] = await Prices.refreshAll([h({ priceSource: 'alphavantage', priceKey: 'TSCO.LON', currency: 'GBP' })], { fetchFn: av, now, settings: { keys } });
  assert.equal(b.currentPrice, 2.5);
  assert.deepEqual(Prices.majorCurrency('ZAc'), { currency: 'ZAR', divisor: 100 });
  assert.deepEqual(Prices.majorCurrency('usd'), { currency: 'USD', divisor: 1 });
});

test('fetchHistory: crypto, metals via tokens, stocks via Twelve Data, pence and currency', async () => {
  const fetchFn = fakeFetch({
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart': { prices: [[Date.UTC(2025, 0, 1), 100], [Date.UTC(2025, 0, 1, 12), 101], [Date.UTC(2025, 0, 2), 110]] },
    'https://api.coingecko.com/api/v3/coins/pax-gold/market_chart': { prices: [[Date.UTC(2025, 0, 1), 3110.34768]] },
    'https://api.twelvedata.com/time_series?symbol=TSCO&exchange=LSE': { meta: { currency: 'GBp' }, values: [{ datetime: '2025-01-02', close: '300' }, { datetime: '2025-01-01', close: '250' }] },
  });
  const btc = await Prices.fetchHistory(h({ category: 'crypto', priceSource: 'coingecko', priceKey: 'bitcoin', currency: 'EUR' }), { fetchFn, rates: { EUR: 0.5 } });
  assert.deepEqual(btc, [{ date: '2025-01-01', price: 50.5 }, { date: '2025-01-02', price: 55 }]);
  const gold = await Prices.fetchHistory(h({ category: 'metal', priceSource: 'metal', priceKey: 'XAU', unit: 'g' }), { fetchFn });
  assert.ok(Math.abs(gold[0].price - 100) < 1e-9);
  const tsco = await Prices.fetchHistory(h({ priceSource: 'twelvedata', priceKey: 'TSCO:LSE', currency: 'GBP' }), { fetchFn, settings: { keys } });
  assert.deepEqual(tsco, [{ date: '2025-01-01', price: 2.5 }, { date: '2025-01-02', price: 3 }]);
});

test('historySource picks what the free tiers can serve', () => {
  assert.equal(Prices.historySource(h({ priceSource: 'finnhub', priceKey: 'AAPL' }), {}), null);
  assert.deepEqual(Prices.historySource(h({ priceSource: 'finnhub', priceKey: 'VOD.L' }), { keys: { twelvedata: 'k' } }), { kind: 'twelvedata', id: 'VOD:LSE' });
  assert.equal(Prices.historySource(h({ category: 'metal', priceSource: 'metal', priceKey: 'XPT' }), {}), null);
  assert.equal(Prices.historySource(h({ category: 'collectible', priceSource: 'pokemontcg', priceKey: 'base1-4' }), {}), null);
});

const server = { keys: { priceServerUrl: 'https://prices.example/', priceServerToken: 'code' } };

test('server sources need the price server configured', async () => {
  const [card] = await Prices.refreshAll([h({ category: 'collectible', priceSource: 'ebay', priceKey: 'charizard' })], { fetchFn: fakeFetch({}), now });
  assert.match(card.priceError, /price server/);
});

test('eBay prices use the local marketplace and convert currency', async () => {
  const fetchFn = fakeFetch({ 'https://prices.example/ebay?': { price: 150, currency: 'AUD', count: 12, mode: 'sold', samples: [] } });
  const [card] = await Prices.refreshAll([h({ category: 'collectible', priceSource: 'ebay', priceKey: 'charizard psa 9', currency: 'AUD' })],
    { fetchFn, now, settings: server });
  assert.equal(card.currentPrice, 150);
  const call = fetchFn.calls[0];
  assert.ok(call.url.includes('marketplace=EBAY_AU') && call.url.includes('mode=sold') && call.url.includes('q=charizard%20psa%209'));
  assert.equal(call.opts.headers['X-App-Token'], 'code');
});

test('PriceCharting picks the chosen grade', async () => {
  const fetchFn = fakeFetch({ 'https://prices.example/pricecharting?': { currency: 'USD', prices: { ungraded: 450, psa10: 12000 } } });
  const [psa, g9] = await Prices.refreshAll([
    h({ category: 'collectible', priceSource: 'pricecharting', priceKey: '6910', priceOption: 'psa10' }),
    h({ category: 'collectible', priceSource: 'pricecharting', priceKey: '6910', priceOption: 'grade9' }),
  ], { fetchFn, now, settings: server });
  assert.equal(psa.currentPrice, 12000);
  assert.match(g9.priceError, /No Grade 9 price/);
  assert.equal(P.normalizeHolding({ priceSource: 'pricecharting', priceOption: 'bogus' }).priceOption, 'ungraded');
});

test('property: area median, or purchase price grown with the area', async () => {
  const body = { price: 1100000, currency: 'AUD', period: '2026-06-30', area: 'Melbourne VIC 3000', source: 'Domain',
    history: [{ date: '2020-03-31', price: 800000 }, { date: '2023-06-30', price: 1000000 }, { date: '2026-06-30', price: 1100000 }] };
  const fetchFn = fakeFetch({ 'https://prices.example/property?': body });
  const house = (method) => h({ category: 'real_estate', priceSource: 'property', priceKey: 'Melbourne, VIC 3000', currency: 'AUD',
    priceMethod: method, transactions: [{ type: 'buy', date: '2023-08-01', quantity: 1, price: 900000 }] });
  const [median, growth] = await Prices.refreshAll([house('median'), house('growth')], { fetchFn, now, settings: server });
  assert.equal(median.currentPrice, 1100000);
  assert.ok(Math.abs(growth.currentPrice - 990000) < 1e-6); // 900k × 1.1M / 1.0M
  const hist = await Prices.fetchHistory(house('growth'), { fetchFn, settings: server });
  assert.deepEqual(hist.map((p) => Math.round(p.price)), [720000, 900000, 990000]);
  const t = await Prices.test('property', 'Melbourne, VIC 3000', house('growth'), { fetchFn, settings: server });
  assert.match(t.summary, /Melbourne VIC 3000/);
  assert.equal(t.items.length, 3);
});

test('pricecharting search goes through the server', async () => {
  const fetchFn = fakeFetch({ 'https://prices.example/pricecharting/search?': { products: [{ id: '6910', name: 'Charizard #4', set: 'Pokemon Base Set' }] } });
  assert.deepEqual(await Prices.search('pricecharting', 'charizard', { fetchFn, settings: server }),
    [{ key: '6910', name: 'Charizard #4', detail: 'Pokemon Base Set' }]);
});
