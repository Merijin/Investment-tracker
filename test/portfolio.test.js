const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/portfolio.js');

const buy = (date, quantity, price, fees = 0) => ({ type: 'buy', date, quantity, price, fees });
const sell = (date, quantity, price, fees = 0) => ({ type: 'sell', date, quantity, price, fees });
const holding = (o) => P.normalizeHolding({ name: 'x', category: 'stock', ...o });

test('v1 holdings migrate to an opening buy transaction', () => {
  const h = P.normalizeHolding({ name: 'Gold', category: 'metal', quantity: '2', costBasis: '$3,800', purchaseDate: '2023-09-01' });
  assert.equal(h.transactions.length, 1);
  assert.deepEqual([h.transactions[0].type, h.transactions[0].date, h.transactions[0].quantity, h.transactions[0].price],
    ['buy', '2023-09-01', 2, 1900]);
  assert.equal(h.unit, 'ozt');
  assert.equal(h.currency, 'USD');
  const pos = P.position(h);
  assert.equal(pos.quantity, 2);
  assert.equal(pos.costBasis, 3800);
});

test('normalizeHolding canonicalises keys and currencies', () => {
  assert.equal(holding({ priceSource: 'finnhub', priceKey: 'aapl' }).priceKey, 'AAPL');
  assert.equal(holding({ category: 'crypto', priceSource: 'coingecko', priceKey: 'Bitcoin' }).priceKey, 'bitcoin');
  assert.equal(holding({ currency: 'eur' }).currency, 'EUR');
  assert.equal(holding({ currency: 'not a currency' }).currency, 'USD');
  assert.equal(holding({ priceSource: 'nope' }).priceSource, 'manual');
  assert.equal(holding({ category: 'cash', priceSource: 'cash', currentPrice: 99 }).currentPrice, 1);
  // any source may be used for any class
  assert.equal(holding({ category: 'other', priceSource: 'coingecko', priceKey: 'x' }).priceSource, 'coingecko');
});

test('position uses average cost for sells and tracks realized gains', () => {
  const h = holding({ transactions: [
    buy('2024-01-01', 10, 100, 10),   // cost 1010
    buy('2024-02-01', 10, 200),       // cost 3010, avg 150.5
    sell('2024-03-01', 5, 300, 5),    // proceeds 1495, cost out 752.5 -> +742.5
    { type: 'income', date: '2024-04-01', amount: 20, fees: 2 },
  ] });
  const pos = P.position(h);
  assert.equal(pos.quantity, 15);
  assert.ok(Math.abs(pos.costBasis - 2257.5) < 1e-9);
  assert.ok(Math.abs(pos.avgCost - 150.5) < 1e-9);
  assert.ok(Math.abs(pos.realized - 742.5) < 1e-9);
  assert.equal(pos.income, 18);
  assert.equal(pos.invested, 3010);
  assert.equal(pos.oversold, null);
});

test('position replays by date regardless of entry order', () => {
  const h = holding({ transactions: [sell('2024-03-01', 5, 10), buy('2024-01-01', 5, 5)] });
  const pos = P.position(h);
  assert.equal(pos.quantity, 0);
  assert.equal(pos.realized, 25);
  assert.equal(pos.oversold, null);
});

test('selling everything closes the position', () => {
  const h = holding({ currentPrice: 12, transactions: [buy('2024-01-01', 3, 10), sell('2024-02-01', 3, 12)] });
  const m = P.holdingMetrics(h);
  assert.equal(m.closed, true);
  assert.equal(m.value, 0);
  assert.equal(m.realized, 6);
});

test('validateTransaction rejects overselling and bad amounts', () => {
  const h = holding({ transactions: [buy('2024-01-01', 2, 10)] });
  const tooMany = P.normalizeTransaction(sell('2024-02-01', 3, 10));
  assert.match(P.validateTransaction(tooMany, h)[0], /can't sell more/);
  const early = P.normalizeTransaction(sell('2023-12-01', 1, 10));
  assert.match(P.validateTransaction(early, h)[0], /can't sell more/);
  assert.deepEqual(P.validateTransaction(P.normalizeTransaction(sell('2024-02-01', 2, 10)), h), []);
  assert.equal(P.validateTransaction(P.normalizeTransaction({ type: 'income', amount: 0 })).length, 1);
  assert.equal(P.validateTransaction(P.normalizeTransaction(buy('2024-01-01', 0, 1))).length, 1);
});

test('validateHolding reports missing lookup fields', () => {
  assert.deepEqual(P.validateHolding(holding({ name: '' })), ['Name is required.']);
  assert.match(P.validateHolding(holding({ category: 'crypto', priceSource: 'coingecko' }))[0], /coin id is required/);
  const metal = holding({ category: 'metal', priceSource: 'metal', priceKey: 'XAU', unit: 'lb' });
  assert.deepEqual(P.validateHolding(metal), ['Metal unit must be ozt, g or kg.']);
  const custom = holding({ priceSource: 'custom', priceKey: 'http://x' });
  assert.equal(P.validateHolding(custom).length, 2);
});

test('metalPricePerUnit converts troy-ounce spot prices', () => {
  assert.equal(P.metalPricePerUnit(2400, 'ozt'), 2400);
  assert.ok(Math.abs(P.metalPricePerUnit(31.1034768, 'g') - 1) < 1e-9);
  assert.ok(Math.abs(P.metalPricePerUnit(31.1034768, 'kg') - 1000) < 1e-6);
  assert.equal(P.metalPricePerUnit(2400, 'lb'), null);
});

test('makeConverter crosses through USD and reports missing rates', () => {
  const convert = P.makeConverter({ EUR: 0.5, GBP: 0.25 });
  assert.equal(convert(10, 'EUR', 'USD'), 20);
  assert.equal(convert(10, 'USD', 'GBP'), 2.5);
  assert.equal(convert(10, 'EUR', 'GBP'), 5);
  assert.equal(convert(10, 'JPY', 'USD'), null);
  assert.equal(convert(10, 'JPY', 'JPY'), 10);
  assert.equal(P.makeConverter(null)(5, 'EUR', 'USD'), null);
});

test('summarize converts to the base currency and splits open/closed', () => {
  const convert = P.makeConverter({ EUR: 0.5 });
  const holdings = [
    holding({ name: 'A', currentPrice: 150, transactions: [buy('2024-01-01', 10, 100)] }),                       // USD 1500 / 1000
    holding({ name: 'B', category: 'cash', priceSource: 'cash', currency: 'EUR', transactions: [buy('2024-01-01', 100, 1)] }), // EUR 100 = USD 200
    holding({ name: 'C', category: 'collectible', transactions: [buy('2024-01-01', 1, 250)] }),                    // unpriced -> cost
    holding({ name: 'D', currentPrice: 5, transactions: [buy('2024-01-01', 1, 2), sell('2024-02-01', 1, 5)] }),   // closed, +3
    holding({ name: 'E', currency: 'JPY', currentPrice: 1, transactions: [buy('2024-01-01', 1, 1)] }),             // no rate
  ];
  const s = P.summarize(holdings, convert, 'USD');
  assert.equal(s.value, 1500 + 200 + 250);
  assert.equal(s.cost, 1000 + 200 + 250);
  assert.equal(s.gain, 500);
  assert.equal(s.realized, 3);
  assert.equal(s.count, 3);
  assert.equal(s.closed, 1);
  assert.equal(s.unconverted, 1);
  assert.deepEqual(s.allocation.map((a) => a.id), ['stock', 'collectible', 'cash']);

  const inEur = P.summarize(holdings.slice(0, 2), convert, 'EUR');
  assert.equal(inEur.value, 750 + 100);
});

test('recordSnapshot keeps one point per day, sorted, with currency', () => {
  let s = [];
  s = P.recordSnapshot(s, '2024-01-02T10:00:00Z', 100, 90);
  s = P.recordSnapshot(s, '2024-01-01T10:00:00Z', 80, 90, 'EUR');
  s = P.recordSnapshot(s, '2024-01-02T18:00:00Z', 110.555, 90);
  assert.deepEqual(s, [
    { date: '2024-01-01', value: 80, cost: 90, currency: 'EUR' },
    { date: '2024-01-02', value: 110.56, cost: 90, currency: 'USD' },
  ]);
});

test('CSV exports escape values and list every transaction', () => {
  const h = holding({ name: 'Card, "Holo"', category: 'collectible', currentPrice: 12,
    transactions: [buy('2024-01-01', 2, 10), sell('2024-02-01', 1, 15, 1)] });
  const csv = P.holdingsCSV([h], P.makeConverter({}), 'USD');
  assert.ok(csv.split('\n')[1].startsWith('"Card, ""Holo""",Collectibles,'));
  const tx = P.transactionsCSV([h]).split('\n');
  assert.equal(tx.length, 3);
  assert.ok(tx[2].startsWith('2024-02-01,"Card, ""Holo""",Sell,1,15,1,,14,USD'));
});

test('parseBackup accepts v1 and v2 files and skips invalid rows', () => {
  const v1 = JSON.stringify({
    holdings: [{ name: 'Ok', category: 'cash', quantity: 1, costBasis: 5 }, { name: '', quantity: 1 }],
    snapshots: [{ date: '2024-01-01', value: 5 }, { date: 'bad', value: 1 }],
  });
  const r = P.parseBackup(v1);
  assert.equal(r.holdings.length, 1);
  assert.equal(r.holdings[0].transactions.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.snapshots.length, 1);
  const v2 = JSON.stringify({ version: 2, holdings: [holding({ name: 'T', transactions: [buy('2024-01-01', 1, 1)] })] });
  assert.equal(P.parseBackup(v2).holdings[0].transactions[0].quantity, 1);
  assert.throws(() => P.parseBackup('nope'), /not valid JSON/);
});

test('sample portfolio is valid and exercises every transaction type', () => {
  const sample = P.sampleHoldings();
  for (const h of sample) {
    assert.deepEqual(P.validateHolding(h), [], h.name);
    assert.equal(P.position(h).oversold, null, h.name);
  }
  const types = new Set(sample.flatMap((h) => h.transactions.map((t) => t.type)));
  assert.deepEqual([...types].sort(), ['buy', 'income', 'sell']);
  assert.ok(sample.some((h) => h.currency !== 'USD'));
});

test('buildHistory replays trades day by day using market history', () => {
  const h = holding({ category: 'crypto', priceSource: 'coingecko', priceKey: 'x', currentPrice: 120, transactions: [
    buy('2025-01-01', 2, 100), sell('2025-01-03', 1, 110),
  ] });
  const series = [{ date: '2025-01-01', price: 100 }, { date: '2025-01-02', price: 105 }, { date: '2025-01-03', price: 110 }];
  const { points, estimated } = P.buildHistory([h], { histories: { [h.id]: series }, end: '2025-01-05' });
  assert.deepEqual(points.map((p) => [p.date, p.value, p.flow]), [
    ['2025-01-01', 200, 200], ['2025-01-02', 210, 0], ['2025-01-03', 110, -110],
    ['2025-01-04', 110, 0],   // carried forward over a gap
    ['2025-01-05', 120, 0],   // today's price
  ]);
  assert.equal(points[2].cost, 100);
  assert.deepEqual(estimated, []);
});

test('buildHistory interpolates manual assets between valuations and converts currency', () => {
  const h = holding({ category: 'collectible', currency: 'EUR', currentPrice: 300,
    valuations: [{ date: '2025-01-03', price: 200 }], transactions: [buy('2025-01-01', 1, 100)] });
  const { points, estimated } = P.buildHistory([h], { convert: P.makeConverter({ EUR: 0.5 }), base: 'USD', end: '2025-01-05' });
  assert.deepEqual(points.map((p) => p.value), [200, 300, 400, 500, 600]);
  assert.deepEqual(estimated, ['x']);
  const ranged = P.buildHistory([h], { end: '2025-01-05', start: '2025-01-04' });
  assert.deepEqual(ranged.points.map((p) => p.date), ['2025-01-04', '2025-01-05']);
});

test('performance ignores deposits and withdrawals (time-weighted)', () => {
  const pts = [
    { date: 'd1', value: 100, flow: 100 },
    { date: 'd2', value: 110, flow: 0 },     // +10%
    { date: 'd3', value: 1110, flow: 1000 }, // deposit only: 0%
    { date: 'd4', value: 1221, flow: 0 },    // +10%
    { date: 'd5', value: 0, flow: -1221 },   // sold everything at that price: 0%
  ];
  const perf = P.performance(pts);
  assert.ok(Math.abs(perf[1].pct - 0.10) < 1e-12);
  assert.ok(Math.abs(perf[2].pct - 0.10) < 1e-12);
  assert.ok(Math.abs(perf[3].pct - 0.21) < 1e-12);
  assert.ok(Math.abs(perf[4].pct - 0.21) < 1e-12);
  assert.ok(Math.abs(perf[4].gain - 121) < 1e-9);
  const ch = P.periodChange(pts, 'd3');
  assert.ok(Math.abs(ch.pct - 0.10) < 1e-12);
  assert.equal(P.periodChange(pts, 'd9'), null);
});

test('income counts as return, not as a loss of value', () => {
  const pts = [{ date: 'a', value: 100, flow: 100 }, { date: 'b', value: 100, flow: -5 }];
  assert.ok(Math.abs(P.performance(pts)[1].pct - 0.05) < 1e-12);
});

test('addValuation keeps one value per day', () => {
  const v = P.addValuation({ valuations: [{ date: '2025-01-02', price: 5 }] }, '2025-01-01', 3);
  assert.deepEqual(P.addValuation({ valuations: v }, '2025-01-02', 7), [{ date: '2025-01-01', price: 3 }, { date: '2025-01-02', price: 7 }]);
});

test('estimates before market history join up with its first price', () => {
  const h = holding({ category: 'crypto', priceSource: 'coingecko', priceKey: 'x', currentPrice: 500,
    transactions: [buy('2025-01-01', 1, 100)] });
  const m = P.priceModel(h, [{ date: '2025-01-05', price: 300 }], '2025-01-09');
  assert.equal(m.priceOn('2025-01-03'), 200);
  assert.equal(m.priceOn('2025-01-05'), 300);
  assert.equal(m.priceOn('2025-01-09'), 500);
});

test('ids from imported data are sanitised before reaching the page', () => {
  const h = P.normalizeHolding({ id: '"><img src=x onerror=alert(1)>', name: 'x',
    transactions: [{ id: 'ok_id-1', type: 'buy', quantity: 1, price: 1 }, { id: 'bad"id', type: 'buy', quantity: 1, price: 1 }] });
  assert.match(h.id, /^h_[a-z0-9]+$/);
  assert.equal(h.transactions[0].id, 'ok_id-1');
  assert.match(h.transactions[1].id, /^t_[a-z0-9]+$/);
});
