const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/portfolio.js');

test('normalizeHolding coerces input and falls back to manual pricing', () => {
  const h = P.normalizeHolding({ name: ' Gold ', category: 'metal', quantity: '2', costBasis: '$3,800', priceSource: 'coingecko', priceKey: 'x' });
  assert.equal(h.name, 'Gold');
  assert.equal(h.quantity, 2);
  assert.equal(h.costBasis, 3800);
  assert.equal(h.unit, 'ozt');
  assert.equal(h.priceSource, 'manual', 'coingecko is not a valid source for metals');
  assert.equal(h.currentPrice, null);
});

test('normalizeHolding canonicalises price keys per source', () => {
  assert.equal(P.normalizeHolding({ category: 'stock', priceSource: 'finnhub', priceKey: 'aapl' }).priceKey, 'AAPL');
  assert.equal(P.normalizeHolding({ category: 'crypto', priceSource: 'coingecko', priceKey: 'Bitcoin' }).priceKey, 'bitcoin');
  assert.equal(P.normalizeHolding({ category: 'metal', priceSource: 'metal', priceKey: 'xag' }).priceKey, 'XAG');
});

test('validateHolding reports missing fields', () => {
  const errs = P.validateHolding(P.normalizeHolding({ category: 'crypto', priceSource: 'coingecko', quantity: 0 }));
  assert.equal(errs.length, 3);
  const metal = P.normalizeHolding({ name: 'Bar', category: 'metal', priceSource: 'metal', priceKey: 'XAU', quantity: 1, unit: 'lb' });
  assert.deepEqual(P.validateHolding(metal), ['Metal unit must be ozt, g or kg.']);
});

test('metalPricePerUnit converts troy-ounce spot prices', () => {
  assert.equal(P.metalPricePerUnit(2400, 'ozt'), 2400);
  assert.ok(Math.abs(P.metalPricePerUnit(31.1034768, 'g') - 1) < 1e-9);
  assert.ok(Math.abs(P.metalPricePerUnit(31.1034768, 'kg') - 1000) < 1e-6);
  assert.equal(P.metalPricePerUnit(2400, 'lb'), null);
});

test('summarize totals value, gain and allocation', () => {
  const holdings = [
    P.normalizeHolding({ name: 'A', category: 'stock', quantity: 10, costBasis: 1000, currentPrice: 150 }),
    P.normalizeHolding({ name: 'B', category: 'crypto', quantity: 1, costBasis: 1000, currentPrice: 500 }),
    P.normalizeHolding({ name: 'C', category: 'collectible', quantity: 1, costBasis: 250 }), // unpriced -> cost
  ];
  const s = P.summarize(holdings);
  assert.equal(s.value, 2250);
  assert.equal(s.cost, 2250);
  assert.equal(s.gain, 0);
  assert.deepEqual(s.allocation.map((a) => a.id), ['stock', 'crypto', 'collectible']);
  assert.ok(Math.abs(s.allocation[0].share - 1500 / 2250) < 1e-12);
  assert.equal(s.allocation[1].gain, -500);
});

test('holdingMetrics handles zero cost basis', () => {
  const m = P.holdingMetrics(P.normalizeHolding({ name: 'Gift', category: 'other', quantity: 1, costBasis: 0, currentPrice: 50 }));
  assert.equal(m.gain, 50);
  assert.equal(m.gainPct, null);
});

test('recordSnapshot keeps one point per day, sorted', () => {
  let s = [];
  s = P.recordSnapshot(s, '2024-01-02T10:00:00Z', 100, 90);
  s = P.recordSnapshot(s, '2024-01-01T10:00:00Z', 80, 90);
  s = P.recordSnapshot(s, '2024-01-02T18:00:00Z', 110.555, 90);
  assert.deepEqual(s, [
    { date: '2024-01-01', value: 80, cost: 90 },
    { date: '2024-01-02', value: 110.56, cost: 90 },
  ]);
});

test('toCSV escapes commas and quotes', () => {
  const csv = P.toCSV([P.normalizeHolding({ name: 'Card, "Holo"', category: 'collectible', quantity: 1, costBasis: 10, currentPrice: 12 })]);
  const line = csv.split('\n')[1];
  assert.ok(line.startsWith('"Card, ""Holo""",Collectibles,'));
});

test('parseBackup accepts exports and skips invalid rows', () => {
  const text = JSON.stringify({
    holdings: [{ name: 'Ok', category: 'cash', quantity: 1, costBasis: 5 }, { name: '', quantity: 1 }],
    snapshots: [{ date: '2024-01-01', value: 5 }, { date: 'bad', value: 1 }],
  });
  const r = P.parseBackup(text);
  assert.equal(r.holdings.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.snapshots.length, 1);
  assert.throws(() => P.parseBackup('nope'), /not valid JSON/);
});

test('sample portfolio is valid', () => {
  for (const h of P.sampleHoldings()) assert.deepEqual(P.validateHolding(h), [], h.name);
});
