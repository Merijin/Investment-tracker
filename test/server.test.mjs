import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, robustStats, parseLocation } from '../server/worker.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const hit = Object.keys(routes).find((p) => url.startsWith(p));
    if (!hit) return new Response('nope', { status: 404 });
    const body = typeof routes[hit] === 'function' ? routes[hit](url, init) : routes[hit];
    return new Response(JSON.stringify(body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const get = (path, env, fetchFn, headers = {}) =>
  handle(new Request('https://prices.example' + path, { headers }), env, fetchFn).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));

const EBAY_ENV = { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' };
const token = { 'https://api.ebay.com/identity/v1/oauth2/token': { access_token: 'tok', expires_in: 7200 } };

test('robustStats drops outliers before taking the median', () => {
  const s = robustStats([10, 11, 12, 13, 14, 500, 0.5]);
  assert.equal(s.median, 12);
  assert.equal(s.dropped, 2);
  assert.equal(robustStats([]), null);
  assert.equal(robustStats([7]).median, 7);
});

test('parseLocation recognises Australian suburbs and UK areas', () => {
  assert.deepEqual(parseLocation('Melbourne, VIC 3000'), { country: 'AU', suburb: 'Melbourne', state: 'VIC', postcode: '3000' });
  assert.deepEqual(parseLocation('st kilda vic 3182'), { country: 'AU', suburb: 'st kilda', state: 'VIC', postcode: '3182' });
  assert.deepEqual(parseLocation('Brighton & Hove'), { country: 'UK', region: 'brighton-and-hove' });
});

test('access code is enforced and CORS preflight is answered', async () => {
  const env = { APP_TOKEN: 'secret-code' };
  assert.equal((await get('/health', env, fakeFetch({}))).status, 401);
  const ok = await get('/health', env, fakeFetch({}), { 'X-App-Token': 'secret-code' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sources.ukhpi, true);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  const pre = await handle(new Request('https://prices.example/ebay', { method: 'OPTIONS' }), env, fakeFetch({}));
  assert.equal(pre.status, 204);
});

test('eBay active listings: median in the most common currency', async () => {
  const fetchFn = fakeFetch({
    ...token,
    'https://api.ebay.com/buy/browse/v1/item_summary/search': {
      itemSummaries: [
        { title: 'A', price: { value: '100.00', currency: 'USD' } },
        { title: 'B', price: { value: '110.00', currency: 'USD' } },
        { title: 'C', price: { value: '120.00', currency: 'USD' } },
        { title: 'D', price: { value: '5000.00', currency: 'USD' } },
        { title: 'E', price: { value: '90.00', currency: 'GBP' } },
      ],
    },
  });
  const r = await get('/ebay?q=charizard%20base%20set%20-proxy&mode=sold', EBAY_ENV, fetchFn);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'active');
  assert.match(r.body.note, /Marketplace Insights/);
  assert.equal(r.body.currency, 'USD');
  assert.equal(r.body.price, 110);
  const search = fetchFn.calls.find((c) => c.url.includes('item_summary'));
  assert.ok(search.url.includes('q=charizard%20base%20set%20-proxy'));
  assert.equal(search.init.headers.Authorization, 'Bearer tok');
});

test('eBay sold prices use Marketplace Insights when enabled', async () => {
  const fetchFn = fakeFetch({
    ...token,
    'https://api.ebay.com/buy/marketplace_insights/': {
      itemSales: [
        { title: 'Sold 1', lastSoldPrice: { value: '40', currency: 'AUD' }, lastSoldDate: '2026-09-01T10:00:00Z' },
        { title: 'Sold 2', lastSoldPrice: { value: '60', currency: 'AUD' }, lastSoldDate: '2026-09-10T10:00:00Z' },
      ],
    },
  });
  const r = await get('/ebay?q=x&marketplace=EBAY_AU', { ...EBAY_ENV, EBAY_SOLD: 'true' }, fetchFn);
  assert.deepEqual([r.body.mode, r.body.price, r.body.currency, r.body.samples[1].date], ['sold', 50, 'AUD', '2026-09-10']);
  assert.equal(fetchFn.calls.at(-1).init.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_AU');
});

test('missing keys give a clear 501', async () => {
  const r = await get('/ebay?q=x', {}, fakeFetch({}));
  assert.equal(r.status, 501);
  assert.match(r.body.error, /eBay keys/);
  assert.equal((await get('/pricecharting?id=1', {}, fakeFetch({}))).status, 501);
});

test('PriceCharting converts pennies and maps card grades', async () => {
  const fetchFn = fakeFetch({
    'https://www.pricecharting.com/api/product?': { status: 'success', id: 6910, 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set', 'loose-price': 45000, 'graded-price': 150000, 'manual-only-price': 1200000 },
    'https://www.pricecharting.com/api/products?': { products: [{ id: 6910, 'product-name': 'Charizard #4', 'console-name': 'Pokemon Base Set' }] },
  });
  const env = { PRICECHARTING_TOKEN: 'pc' };
  const r = await get('/pricecharting?id=6910', env, fetchFn);
  assert.deepEqual(r.body.prices, { ungraded: 450, grade9: 1500, psa10: 12000 });
  const s = await get('/pricecharting/search?q=charizard', env, fetchFn);
  assert.deepEqual(s.body.products[0], { id: '6910', name: 'Charizard #4', set: 'Pokemon Base Set' });
});

test('Australian suburb median from Domain, with quarterly history', async () => {
  const fetchFn = fakeFetch({
    'https://api.domain.com.au/v2/suburbPerformanceStatistics/VIC/Melbourne/3000': {
      series: { seriesInfo: [
        { year: 2026, month: 6, values: { medianSoldPrice: 1000000, numberSold: 12 } },
        { year: 2026, month: 3, values: { medianSoldPrice: 950000, numberSold: 9 } },
        { year: 2025, month: 12, values: { medianSoldPrice: null } },
      ] },
    },
  });
  const r = await get('/property?location=' + encodeURIComponent('Melbourne, VIC 3000') + '&type=house', { DOMAIN_API_KEY: 'k' }, fetchFn);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.price, r.body.currency, r.body.period], [1000000, 'AUD', '2026-06-30']);
  assert.deepEqual(r.body.history.map((h) => h.price), [950000, 1000000]);
  assert.ok(fetchFn.calls[0].url.includes('propertyCategory=house'));
  assert.equal(fetchFn.calls[0].init.headers['X-Api-Key'], 'k');
});

test('UK House Price Index: latest published month plus yearly history', async () => {
  const fetchFn = fakeFetch({
    'https://landregistry.data.gov.uk/data/ukhpi/region/manchester/month/': (url) => {
      const ym = url.match(/month\/(\d{4}-\d{2})/)[1];
      const now = new Date();
      const recent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 7);
      if (ym > recent) return { result: { primaryTopic: {} } }; // not published yet
      const year = Number(ym.slice(0, 4));
      return { result: { primaryTopic: { averagePrice: 100000 + (year - 2015) * 10000, averagePriceDetached: 400000 } } };
    },
  });
  const r = await get('/property?location=Manchester&type=all', {}, fetchFn);
  assert.equal(r.status, 200);
  assert.equal(r.body.currency, 'GBP');
  assert.equal(r.body.history.length, 11);
  assert.ok(r.body.history[0].price < r.body.price);
  const det = await get('/property?location=Manchester&type=detached', {}, fetchFn);
  assert.equal(det.body.price, 400000);
});
