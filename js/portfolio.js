/*
 * Portfolio model and calculations. Pure functions only — no DOM, no network —
 * so the same file runs in the browser and under `node --test`.
 *
 * A holding is an asset plus its transaction history (buy / sell / income).
 * Quantity, cost basis and realized gains are derived from the transactions
 * using the average-cost method. Prices and transactions are in the holding's
 * own currency; totals are converted to the portfolio's base currency.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Portfolio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fixed order: each category owns its color slot, so a color never moves
  // when another category is added, removed or filtered out.
  // `sources` lists the price sources suggested first for that class; every
  // source can still be picked for any class.
  const CATEGORIES = [
    { id: 'stock',       label: 'Stocks',          slot: 1, defaultUnit: 'shares', sources: ['finnhub', 'twelvedata', 'alphavantage', 'manual'] },
    { id: 'crypto',      label: 'Crypto',          slot: 2, defaultUnit: 'coins',  sources: ['coingecko', 'manual'] },
    { id: 'etf',         label: 'ETFs & funds',    slot: 3, defaultUnit: 'shares', sources: ['finnhub', 'twelvedata', 'alphavantage', 'manual'] },
    { id: 'metal',       label: 'Precious metals', slot: 4, defaultUnit: 'ozt',    sources: ['metal', 'manual'] },
    { id: 'collectible', label: 'Collectibles',    slot: 5, defaultUnit: 'items',  sources: ['pokemontcg', 'scryfall', 'ygoprodeck', 'manual'] },
    { id: 'real_estate', label: 'Real estate',     slot: 6, defaultUnit: 'units',  sources: ['manual'] },
    { id: 'bond',        label: 'Bonds',           slot: 7, defaultUnit: 'units',  sources: ['manual', 'twelvedata'] },
    { id: 'cash',        label: 'Cash & savings',  slot: 8, defaultUnit: '',       sources: ['cash', 'manual'] },
    { id: 'other',       label: 'Other',           slot: 0, defaultUnit: 'units',  sources: ['manual', 'custom'] },
  ];

  // `quoteCurrency` is the currency a source returns; 'holding' means the
  // price is already in the holding's currency (e.g. a stock's listing currency).
  const SOURCES = {
    manual:       { label: 'Manual valuation', quoteCurrency: 'holding' },
    cash:         { label: 'Cash balance (1 unit = 1 of its currency)', quoteCurrency: 'holding' },
    coingecko:    { label: 'CoinGecko — crypto', keyLabel: 'CoinGecko coin id', keyHint: 'e.g. bitcoin, ethereum — use Find to search', search: true, quoteCurrency: 'USD' },
    finnhub:      { label: 'Finnhub — US stocks & ETFs', keyLabel: 'Ticker', keyHint: 'e.g. AAPL, VOO. Needs a free Finnhub key (Settings).', search: true, needsKey: 'finnhub', quoteCurrency: 'holding' },
    twelvedata:   { label: 'Twelve Data — global stocks, ETFs, funds', keyLabel: 'Symbol[:exchange]', keyHint: 'e.g. AAPL, VOD:LSE, SHOP:TSX. Needs a free Twelve Data key.', search: true, needsKey: 'twelvedata', quoteCurrency: 'quote' },
    alphavantage: { label: 'Alpha Vantage — stocks & ETFs', keyLabel: 'Symbol', keyHint: 'e.g. IBM, TSCO.LON. Needs a free Alpha Vantage key (25 calls/day).', search: true, needsKey: 'alphavantage', quoteCurrency: 'holding' },
    metal:        { label: 'Spot price — precious metals', keyLabel: 'Metal', keyHint: 'Spot price per troy ounce, converted to your unit', quoteCurrency: 'USD' },
    pokemontcg:   { label: 'Pokémon TCG — card market price', keyLabel: 'Card id', keyHint: 'e.g. base1-4 — use Find to search by name', search: true, quoteCurrency: 'quote' },
    scryfall:     { label: 'Scryfall — Magic: The Gathering', keyLabel: 'Scryfall card id', keyHint: 'Use Find to search. Add "foil" to type/details for foil prices.', search: true, quoteCurrency: 'quote' },
    ygoprodeck:   { label: 'YGOPRODeck — Yu-Gi-Oh!', keyLabel: 'Card id', keyHint: 'Use Find to search by card name', search: true, quoteCurrency: 'quote' },
    custom:       { label: 'Custom JSON API (advanced)', keyLabel: 'URL', keyHint: 'Any CORS-enabled URL returning JSON; price read from the path below, in the holding currency', quoteCurrency: 'holding' },
  };

  const METALS = { XAU: 'Gold', XAG: 'Silver', XPT: 'Platinum', XPD: 'Palladium' };

  // Metal quantities can be entered in any of these; spot prices are per troy ounce.
  const GRAMS_PER_TROY_OUNCE = 31.1034768;
  const METAL_UNITS = { ozt: 1, g: 1 / GRAMS_PER_TROY_OUNCE, kg: 1000 / GRAMS_PER_TROY_OUNCE };

  const TX_TYPES = { buy: 'Buy', sell: 'Sell', income: 'Income' };

  function categoryById(id) {
    return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
  }

  function toNumber(value, fallback = 0) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s$€£¥]/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }

  function newId(prefix = 'h') {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normCurrency(c, fallback = 'USD') {
    const s = String(c || '').trim().toUpperCase();
    return /^[A-Z]{3,5}$/.test(s) ? s : fallback;
  }

  function normalizeTransaction(raw) {
    const type = TX_TYPES[raw.type] ? raw.type : 'buy';
    const tx = {
      id: raw.id || newId('t'),
      type,
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : new Date().toISOString().slice(0, 10),
      quantity: type === 'income' ? 0 : toNumber(raw.quantity, 0),
      price: type === 'income' ? 0 : toNumber(raw.price, 0),
      fees: toNumber(raw.fees, 0),
      amount: type === 'income' ? toNumber(raw.amount, 0) : 0,
      note: String(raw.note || '').trim(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
    return tx;
  }

  /**
   * Normalise raw form/import input into a holding record. Accepts the v1
   * shape (quantity + costBasis, no transactions) and migrates it to an
   * opening buy transaction.
   */
  function normalizeHolding(raw) {
    const category = categoryById(raw.category).id;
    const cat = categoryById(category);
    const source = SOURCES[raw.priceSource] ? raw.priceSource : 'manual';
    let transactions = Array.isArray(raw.transactions) ? raw.transactions.map(normalizeTransaction) : null;
    if (!transactions) {
      const qty = toNumber(raw.quantity, 0);
      const cost = toNumber(raw.costBasis, 0);
      transactions = qty > 0
        ? [normalizeTransaction({ type: 'buy', date: raw.purchaseDate, quantity: qty, price: cost / qty, updatedAt: raw.updatedAt })]
        : [];
    }
    const holding = {
      id: raw.id || newId('h'),
      name: String(raw.name || '').trim(),
      category,
      subcategory: String(raw.subcategory || '').trim(),
      currency: normCurrency(raw.currency),
      unit: String(raw.unit ?? cat.defaultUnit).trim(),
      priceSource: source,
      priceKey: String(raw.priceKey || '').trim(),
      pricePath: String(raw.pricePath || '').trim(),
      currentPrice: raw.currentPrice === '' || raw.currentPrice === undefined || raw.currentPrice === null
        ? null
        : toNumber(raw.currentPrice, null),
      priceUpdatedAt: raw.priceUpdatedAt || null,
      priceError: raw.priceError || null,
      notes: String(raw.notes || '').trim(),
      transactions,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
    if (source === 'metal' || source === 'finnhub' || source === 'alphavantage' || source === 'twelvedata') {
      holding.priceKey = holding.priceKey.toUpperCase();
    }
    if (source === 'coingecko') holding.priceKey = holding.priceKey.toLowerCase();
    if (source === 'cash') holding.currentPrice = 1;
    return holding;
  }

  /**
   * Replay transactions in date order with the average-cost method.
   * Returns the open position plus realized results.
   */
  function position(h) {
    const txs = h.transactions
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (a.t.date === b.t.date ? a.i - b.i : a.t.date < b.t.date ? -1 : 1))
      .map((x) => x.t);
    let quantity = 0;
    let cost = 0;
    let realized = 0;
    let income = 0;
    let invested = 0;
    let oversold = null;
    for (const t of txs) {
      if (t.type === 'buy') {
        quantity += t.quantity;
        cost += t.quantity * t.price + t.fees;
        invested += t.quantity * t.price + t.fees;
      } else if (t.type === 'sell') {
        const q = Math.min(t.quantity, quantity);
        if (t.quantity > quantity + 1e-9) oversold = oversold || t;
        const costOut = quantity > 0 ? (cost / quantity) * q : 0;
        realized += q * t.price - t.fees - costOut;
        cost -= costOut;
        quantity -= q;
        if (quantity < 1e-12) { quantity = 0; cost = 0; }
      } else if (t.type === 'income') {
        income += t.amount - t.fees;
      }
    }
    return {
      quantity,
      costBasis: cost,
      avgCost: quantity > 0 ? cost / quantity : 0,
      realized,
      income,
      invested,
      oversold,
      firstDate: txs.length ? txs[0].date : null,
    };
  }

  function validateHolding(h) {
    const errors = [];
    if (!h.name) errors.push('Name is required.');
    const src = SOURCES[h.priceSource];
    if (!['manual', 'cash'].includes(h.priceSource) && !h.priceKey) {
      errors.push(`${src.keyLabel} is required for automatic pricing.`);
    }
    if (h.priceSource === 'metal' && !METALS[h.priceKey]) errors.push('Choose a metal (XAU, XAG, XPT or XPD).');
    if (h.priceSource === 'metal' && !METAL_UNITS[h.unit]) errors.push('Metal unit must be ozt, g or kg.');
    if (h.priceSource === 'custom' && !/^https:\/\//.test(h.priceKey)) errors.push('Custom source URL must start with https://');
    if (h.priceSource === 'custom' && !h.pricePath) errors.push('Enter the JSON path of the price, e.g. data.price');
    return errors;
  }

  function validateTransaction(tx, holding) {
    const errors = [];
    if (tx.type === 'income') {
      if (!(tx.amount > 0)) errors.push('Amount must be greater than 0.');
    } else {
      if (!(tx.quantity > 0)) errors.push('Quantity must be greater than 0.');
      if (tx.price < 0) errors.push('Price cannot be negative.');
    }
    if (tx.fees < 0) errors.push('Fees cannot be negative.');
    if (holding && tx.type === 'sell' && !errors.length) {
      const others = holding.transactions.filter((t) => t.id !== tx.id);
      const pos = position({ transactions: [...others, tx] });
      if (pos.oversold) errors.push(`You can't sell more than you held on ${pos.oversold.date}.`);
    }
    return errors;
  }

  /** Convert a per-troy-ounce spot price into a price per the holding's unit. */
  function metalPricePerUnit(pricePerOzt, unit) {
    const factor = METAL_UNITS[unit];
    return factor ? pricePerOzt * factor : null;
  }

  /**
   * rates: units of each currency per 1 USD (USD = 1). Returns
   * convert(amount, from, to) -> number, or null when a rate is missing.
   */
  function makeConverter(rates) {
    return function convert(amount, from, to) {
      if (from === to || amount === 0) return amount;
      const rf = from === 'USD' ? 1 : rates && rates[from];
      const rt = to === 'USD' ? 1 : rates && rates[to];
      if (!(rf > 0) || !(rt > 0)) return null;
      return (amount / rf) * rt;
    };
  }

  /** Per-holding figures in the holding's own currency (native) and in base currency. */
  function holdingMetrics(h, convert, base) {
    const pos = position(h);
    const priced = h.currentPrice !== null && h.currentPrice !== undefined;
    // Without any valuation yet, fall back to cost so totals aren't understated.
    const nativeValue = priced ? pos.quantity * h.currentPrice : pos.costBasis;
    const conv = (n) => (convert ? convert(n, h.currency, base) : n);
    const value = conv(nativeValue);
    const cost = conv(pos.costBasis);
    const realized = conv(pos.realized + pos.income);
    const fxMissing = value === null || cost === null || realized === null;
    const gain = fxMissing ? 0 : value - cost;
    return {
      ...pos,
      priced,
      closed: pos.quantity === 0 && h.transactions.length > 0,
      nativeValue,
      nativeGain: nativeValue - pos.costBasis,
      value: fxMissing ? 0 : value,
      cost: fxMissing ? 0 : cost,
      gain,
      gainPct: !fxMissing && cost > 0 ? gain / cost : null,
      realizedBase: fxMissing ? 0 : realized,
      fxMissing,
    };
  }

  function summarize(holdings, convert, base = 'USD') {
    let value = 0;
    let cost = 0;
    let realized = 0;
    let open = 0;
    let closed = 0;
    let unconverted = 0;
    const byCategory = new Map();
    for (const h of holdings) {
      const m = holdingMetrics(h, convert, base);
      if (m.fxMissing) { unconverted += 1; continue; }
      realized += m.realizedBase;
      if (m.closed) { closed += 1; continue; }
      open += 1;
      value += m.value;
      cost += m.cost;
      const entry = byCategory.get(h.category) || { value: 0, cost: 0, count: 0 };
      entry.value += m.value;
      entry.cost += m.cost;
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
    return {
      value, cost, gain, gainPct: cost > 0 ? gain / cost : null, realized,
      count: open, closed, unconverted, allocation,
    };
  }

  /** Keep one snapshot per day (latest wins), sorted, capped to ~5 years. */
  function recordSnapshot(snapshots, date, value, cost, currency = 'USD') {
    const day = date.slice(0, 10);
    const next = snapshots.filter((s) => s.date !== day);
    next.push({ date: day, value: round2(value), cost: round2(cost), currency });
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

  function toCSV(rows) {
    return rows.map((r) => r.map(csvCell).join(',')).join('\n');
  }

  function holdingsCSV(holdings, convert, base) {
    const header = ['Name', 'Category', 'Type', 'Currency', 'Quantity', 'Unit', 'Avg cost', 'Cost basis',
      'Current price', 'Value', 'Unrealized gain', 'Realized gain + income', `Value (${base})`,
      'Price source', 'Price key', 'Price updated', 'Notes'];
    const rows = holdings.map((h) => {
      const m = holdingMetrics(h, convert, base);
      return [h.name, categoryById(h.category).label, h.subcategory, h.currency, m.quantity, h.unit,
        round2(m.avgCost), round2(m.costBasis), h.currentPrice, round2(m.nativeValue), round2(m.nativeGain),
        round2(m.realized + m.income), m.fxMissing ? '' : round2(m.value), h.priceSource, h.priceKey,
        h.priceUpdatedAt, h.notes];
    });
    return toCSV([header, ...rows]);
  }

  function transactionsCSV(holdings) {
    const header = ['Date', 'Holding', 'Type', 'Quantity', 'Price', 'Fees', 'Amount', 'Total', 'Currency', 'Note'];
    const rows = [];
    for (const h of holdings) {
      for (const t of h.transactions) {
        const total = t.type === 'income' ? t.amount - t.fees
          : t.type === 'buy' ? t.quantity * t.price + t.fees : t.quantity * t.price - t.fees;
        rows.push([t.date, h.name, TX_TYPES[t.type], t.quantity || '', t.price || '', t.fees || '',
          t.amount || '', round2(total), h.currency, t.note]);
      }
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return toCSV([header, ...rows]);
  }

  /** Validate an imported backup (v1 or v2); returns { holdings, snapshots, skipped } or throws. */
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
    const buy = (date, quantity, price, fees = 0) => ({ type: 'buy', date, quantity, price, fees });
    const sell = (date, quantity, price, fees = 0) => ({ type: 'sell', date, quantity, price, fees });
    const income = (date, amount, note) => ({ type: 'income', date, amount, note });
    const raw = [
      { name: 'Apple', category: 'stock', priceSource: 'finnhub', priceKey: 'AAPL', currentPrice: 228.5,
        transactions: [buy('2023-03-14', 10, 150, 1), buy('2024-01-10', 5, 185, 1), income('2024-08-15', 3.75, 'Dividend')] },
      { name: 'Vanguard S&P 500 ETF', category: 'etf', priceSource: 'finnhub', priceKey: 'VOO', currentPrice: 530,
        transactions: [buy('2022-11-02', 10, 390)] },
      { name: 'Bitcoin', category: 'crypto', priceSource: 'coingecko', priceKey: 'bitcoin', currentPrice: 64000,
        transactions: [buy('2023-01-20', 0.12, 34000, 5)] },
      { name: 'Ethereum', category: 'crypto', priceSource: 'coingecko', priceKey: 'ethereum', currentPrice: 3100,
        transactions: [buy('2023-06-08', 2, 1600, 4), sell('2024-03-12', 0.5, 3900, 2)] },
      { name: '1 oz Gold Maple Leaf', category: 'metal', subcategory: 'Bullion coin', unit: 'ozt', priceSource: 'metal', priceKey: 'XAU', currentPrice: 2400,
        transactions: [buy('2023-09-01', 2, 1900)] },
      { name: 'Silver bar', category: 'metal', subcategory: 'Bullion bar', unit: 'g', priceSource: 'metal', priceKey: 'XAG', currentPrice: 0.95,
        transactions: [buy('2024-02-11', 500, 0.84)] },
      { name: 'Charizard — Base Set Holo', category: 'collectible', subcategory: 'Pokémon card', priceSource: 'pokemontcg', priceKey: 'base1-4', currentPrice: 420,
        notes: 'Raw, near mint', transactions: [buy('2021-05-30', 1, 350)] },
      { name: 'Rolex Submariner', category: 'collectible', subcategory: 'Watch', priceSource: 'manual', currentPrice: 11200,
        transactions: [buy('2020-08-15', 1, 9500)] },
      { name: 'Euro savings account', category: 'cash', subcategory: 'Savings account', currency: 'EUR', priceSource: 'cash',
        transactions: [buy('2024-01-01', 7000, 1), buy('2024-06-01', 500, 1), income('2024-12-31', 210, 'Interest')] },
    ];
    const stamp = new Date().toISOString();
    return raw.map((h) => normalizeHolding({ ...h, priceUpdatedAt: stamp }));
  }

  return {
    CATEGORIES, SOURCES, METALS, METAL_UNITS, GRAMS_PER_TROY_OUNCE, TX_TYPES,
    categoryById, toNumber, newId, normCurrency, normalizeHolding, normalizeTransaction,
    position, validateHolding, validateTransaction, metalPricePerUnit, makeConverter,
    holdingMetrics, summarize, recordSnapshot, holdingsCSV, transactionsCSV, parseBackup, sampleHoldings,
  };
});
