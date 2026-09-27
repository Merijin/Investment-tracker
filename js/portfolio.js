/*
 * Portfolio model and calculations. Pure functions only — no DOM, no network —
 * so the same file runs in the browser and under `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Portfolio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fixed order: each category owns its color slot, so a color never moves
  // when another category is added, removed or filtered out.
  const CATEGORIES = [
    { id: 'stock',       label: 'Stocks',          slot: 1, defaultUnit: 'shares', sources: ['finnhub', 'manual'] },
    { id: 'crypto',      label: 'Crypto',          slot: 2, defaultUnit: 'coins',  sources: ['coingecko', 'manual'] },
    { id: 'etf',         label: 'ETFs & funds',    slot: 3, defaultUnit: 'shares', sources: ['finnhub', 'manual'] },
    { id: 'metal',       label: 'Precious metals', slot: 4, defaultUnit: 'ozt',    sources: ['metal', 'manual'] },
    { id: 'collectible', label: 'Collectibles',    slot: 5, defaultUnit: 'items',  sources: ['pokemontcg', 'manual'] },
    { id: 'real_estate', label: 'Real estate',     slot: 6, defaultUnit: 'units',  sources: ['manual'] },
    { id: 'bond',        label: 'Bonds',           slot: 7, defaultUnit: 'units',  sources: ['manual'] },
    { id: 'cash',        label: 'Cash & savings',  slot: 8, defaultUnit: 'units',  sources: ['manual'] },
    { id: 'other',       label: 'Other',           slot: 0, defaultUnit: 'units',  sources: ['manual'] },
  ];

  const SOURCES = {
    manual:     { label: 'Manual valuation' },
    coingecko:  { label: 'CoinGecko (crypto)', keyLabel: 'CoinGecko coin id', keyHint: 'e.g. bitcoin, ethereum, solana' },
    finnhub:    { label: 'Finnhub (stocks/ETFs)', keyLabel: 'Ticker symbol', keyHint: 'e.g. AAPL, VOO — needs a free Finnhub API key in Settings' },
    metal:      { label: 'Spot price (metals)', keyLabel: 'Metal', keyHint: 'XAU gold, XAG silver, XPT platinum, XPD palladium' },
    pokemontcg: { label: 'Pokémon TCG market price', keyLabel: 'Pokémon TCG card id', keyHint: 'e.g. base1-4 (Base Set Charizard) — from pokemontcg.io' },
  };

  const METALS = { XAU: 'Gold', XAG: 'Silver', XPT: 'Platinum', XPD: 'Palladium' };

  // Metal quantities can be entered in any of these; spot prices are per troy ounce.
  const GRAMS_PER_TROY_OUNCE = 31.1034768;
  const METAL_UNITS = { ozt: 1, g: 1 / GRAMS_PER_TROY_OUNCE, kg: 1000 / GRAMS_PER_TROY_OUNCE };

  function categoryById(id) {
    return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
  }

  function toNumber(value, fallback = 0) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s$]/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }

  function newId() {
    return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Normalise raw form/import input into a holding record. */
  function normalizeHolding(raw) {
    const category = categoryById(raw.category).id;
    const cat = categoryById(category);
    const source = cat.sources.includes(raw.priceSource) ? raw.priceSource : 'manual';
    const holding = {
      id: raw.id || newId(),
      name: String(raw.name || '').trim(),
      category,
      subcategory: String(raw.subcategory || '').trim(),
      quantity: toNumber(raw.quantity, 0),
      unit: String(raw.unit || cat.defaultUnit).trim(),
      costBasis: toNumber(raw.costBasis, 0),
      purchaseDate: raw.purchaseDate || '',
      priceSource: source,
      priceKey: String(raw.priceKey || '').trim(),
      currentPrice: raw.currentPrice === '' || raw.currentPrice === undefined || raw.currentPrice === null
        ? null
        : toNumber(raw.currentPrice, null),
      priceUpdatedAt: raw.priceUpdatedAt || null,
      priceError: raw.priceError || null,
      notes: String(raw.notes || '').trim(),
    };
    if (source === 'metal') holding.priceKey = holding.priceKey.toUpperCase();
    if (source === 'finnhub') holding.priceKey = holding.priceKey.toUpperCase();
    if (source === 'coingecko') holding.priceKey = holding.priceKey.toLowerCase();
    return holding;
  }

  function validateHolding(h) {
    const errors = [];
    if (!h.name) errors.push('Name is required.');
    if (!(h.quantity > 0)) errors.push('Quantity must be greater than 0.');
    if (h.costBasis < 0) errors.push('Cost basis cannot be negative.');
    if (h.priceSource !== 'manual' && !h.priceKey) {
      errors.push(`${SOURCES[h.priceSource].keyLabel} is required for automatic pricing.`);
    }
    if (h.priceSource === 'metal' && !METALS[h.priceKey]) errors.push('Choose a metal (XAU, XAG, XPT or XPD).');
    if (h.priceSource === 'metal' && !METAL_UNITS[h.unit]) errors.push('Metal unit must be ozt, g or kg.');
    return errors;
  }

  /** Convert a per-troy-ounce spot price into a price per the holding's unit. */
  function metalPricePerUnit(pricePerOzt, unit) {
    const factor = METAL_UNITS[unit];
    return factor ? pricePerOzt * factor : null;
  }

  function holdingValue(h) {
    // Without any valuation yet, fall back to cost so totals aren't understated.
    return h.currentPrice === null || h.currentPrice === undefined ? h.costBasis : h.quantity * h.currentPrice;
  }

  function holdingMetrics(h) {
    const value = holdingValue(h);
    const gain = value - h.costBasis;
    return {
      value,
      gain,
      gainPct: h.costBasis > 0 ? gain / h.costBasis : null,
      avgCost: h.quantity > 0 ? h.costBasis / h.quantity : 0,
      priced: h.currentPrice !== null && h.currentPrice !== undefined,
    };
  }

  function summarize(holdings) {
    let value = 0;
    let cost = 0;
    const byCategory = new Map();
    for (const h of holdings) {
      const m = holdingMetrics(h);
      value += m.value;
      cost += h.costBasis;
      const entry = byCategory.get(h.category) || { value: 0, cost: 0, count: 0 };
      entry.value += m.value;
      entry.cost += h.costBasis;
      entry.count += 1;
      byCategory.set(h.category, entry);
    }
    const allocation = CATEGORIES
      .filter((c) => byCategory.has(c.id))
      .map((c) => {
        const e = byCategory.get(c.id);
        return { ...c, ...e, share: value > 0 ? e.value / value : 0, gain: e.value - e.cost };
      })
      .sort((a, b) => b.value - a.value);
    const gain = value - cost;
    return { value, cost, gain, gainPct: cost > 0 ? gain / cost : null, count: holdings.length, allocation };
  }

  /** Keep one snapshot per day (latest wins), sorted, capped to ~5 years. */
  function recordSnapshot(snapshots, date, value, cost) {
    const day = date.slice(0, 10);
    const next = snapshots.filter((s) => s.date !== day);
    next.push({ date: day, value: round2(value), cost: round2(cost) });
    next.sort((a, b) => (a.date < b.date ? -1 : 1));
    return next.slice(-1850);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(holdings) {
    const header = ['Name', 'Category', 'Subcategory', 'Quantity', 'Unit', 'Cost basis', 'Purchase date',
      'Current price', 'Value', 'Gain/loss', 'Price source', 'Price key', 'Price updated', 'Notes'];
    const rows = holdings.map((h) => {
      const m = holdingMetrics(h);
      return [h.name, categoryById(h.category).label, h.subcategory, h.quantity, h.unit, h.costBasis,
        h.purchaseDate, h.currentPrice, round2(m.value), round2(m.gain), h.priceSource, h.priceKey,
        h.priceUpdatedAt, h.notes];
    });
    return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  }

  /** Validate an imported backup; returns { holdings, snapshots } or throws. */
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('File is not valid JSON.');
    }
    const list = Array.isArray(data) ? data : data && data.holdings;
    if (!Array.isArray(list)) throw new Error('No holdings found in file.');
    const holdings = list.map(normalizeHolding).filter((h) => validateHolding(h).length === 0);
    const snapshots = Array.isArray(data.snapshots)
      ? data.snapshots.filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && Number.isFinite(s.value))
      : [];
    return { holdings, snapshots, skipped: list.length - holdings.length };
  }

  function sampleHoldings() {
    const raw = [
      { name: 'Apple', category: 'stock', quantity: 15, costBasis: 2250, priceSource: 'finnhub', priceKey: 'AAPL', currentPrice: 228.5, purchaseDate: '2023-03-14' },
      { name: 'Vanguard S&P 500 ETF', category: 'etf', quantity: 10, costBasis: 3900, priceSource: 'finnhub', priceKey: 'VOO', currentPrice: 530, purchaseDate: '2022-11-02' },
      { name: 'Bitcoin', category: 'crypto', quantity: 0.12, costBasis: 4100, priceSource: 'coingecko', priceKey: 'bitcoin', currentPrice: 64000, purchaseDate: '2023-01-20' },
      { name: 'Ethereum', category: 'crypto', quantity: 1.5, costBasis: 2400, priceSource: 'coingecko', priceKey: 'ethereum', currentPrice: 3100, purchaseDate: '2023-06-08' },
      { name: '1 oz Gold Maple Leaf', category: 'metal', subcategory: 'Bullion coin', quantity: 2, unit: 'ozt', costBasis: 3800, priceSource: 'metal', priceKey: 'XAU', currentPrice: 2400, purchaseDate: '2023-09-01' },
      { name: 'Silver bar', category: 'metal', subcategory: 'Bullion bar', quantity: 500, unit: 'g', costBasis: 420, priceSource: 'metal', priceKey: 'XAG', currentPrice: 0.95, purchaseDate: '2024-02-11' },
      { name: 'Charizard — Base Set Holo', category: 'collectible', subcategory: 'Pokémon card', quantity: 1, costBasis: 350, priceSource: 'pokemontcg', priceKey: 'base1-4', currentPrice: 420, purchaseDate: '2021-05-30', notes: 'Raw, near mint' },
      { name: 'Rolex Submariner', category: 'collectible', subcategory: 'Watch', quantity: 1, costBasis: 9500, priceSource: 'manual', currentPrice: 11200, purchaseDate: '2020-08-15' },
      { name: 'High-yield savings', category: 'cash', quantity: 1, costBasis: 8000, priceSource: 'manual', currentPrice: 8240 },
    ];
    return raw.map((h) => normalizeHolding({ ...h, priceUpdatedAt: new Date().toISOString() }));
  }

  return {
    CATEGORIES, SOURCES, METALS, METAL_UNITS, GRAMS_PER_TROY_OUNCE,
    categoryById, toNumber, normalizeHolding, validateHolding, metalPricePerUnit,
    holdingValue, holdingMetrics, summarize, recordSnapshot, toCSV, parseBackup, sampleHoldings,
  };
});
