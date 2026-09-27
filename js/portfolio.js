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
    { id: 'collectible', label: 'Collectibles',    slot: 5, defaultUnit: 'items',  sources: ['tcgapi', 'pricecharting', 'ebay', 'pokemontcg', 'scryfall', 'ygoprodeck', 'manual'] },
    { id: 'real_estate', label: 'Real estate',     slot: 6, defaultUnit: 'properties', sources: ['property', 'manual'] },
    { id: 'bond',        label: 'Bonds',           slot: 7, defaultUnit: 'units',  sources: ['manual', 'twelvedata'] },
    { id: 'cash',        label: 'Cash & savings',  slot: 8, defaultUnit: '',       sources: ['cash', 'manual'] },
    { id: 'other',       label: 'Other',           slot: 0, defaultUnit: 'units',  sources: ['manual', 'ebay', 'custom'] },
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
    tcgapi: {
      label: 'TCG API — 89+ card games (TCGplayer market price)', keyLabel: 'TCG API card id',
      keyHint: 'Pokémon, Magic, Yu-Gi-Oh!, One Piece, Lorcana and more. Use Find to search. Needs a free TCG API key (Settings).',
      search: 'find', needsKey: 'tcgapi', quoteCurrency: 'USD',
      optionLabel: 'Printing',
      options: [['auto', 'Best match'], ['normal', 'Normal / unlimited'], ['foil', 'Foil / holofoil'], ['reverse', 'Reverse holofoil'], ['1st', '1st edition']],
    },
    pricecharting: {
      label: 'PriceCharting — sold-price guide (cards, comics, games)', keyLabel: 'PriceCharting product id',
      keyHint: 'Use Find to search, then pick the grade. Needs the price server.', search: 'find', server: true, quoteCurrency: 'quote',
      optionLabel: 'Grade',
      options: [['ungraded', 'Ungraded'], ['grade7', 'Grade 7'], ['grade8', 'Grade 8'], ['grade9', 'Grade 9'], ['grade9.5', 'Grade 9.5'],
        ['psa10', 'PSA 10'], ['bgs10', 'BGS 10'], ['cgc10', 'CGC 10'], ['sgc10', 'SGC 10']],
    },
    ebay: {
      label: 'eBay — median of recent sales', keyLabel: 'eBay search words',
      keyHint: 'Describe it the way sellers do, e.g. "charizard base set holo psa 9". Add -word to exclude (-proxy -lot). Use Test to see the matches.',
      search: 'test', server: true, quoteCurrency: 'quote',
      optionLabel: 'Use', options: [['sold', 'Sold prices'], ['active', 'Current listings']],
    },
    property: {
      label: 'Area property prices (AU suburb median, UK index)', keyLabel: 'Location',
      keyHint: 'Australia: suburb, state and postcode, e.g. "Melbourne, VIC 3000". UK: region or council, e.g. "Manchester".',
      search: 'test', server: true, quoteCurrency: 'quote',
      optionLabel: 'Property type',
      options: [['house', 'House'], ['unit', 'Unit / flat'], ['detached', 'Detached (UK)'], ['semi', 'Semi-detached (UK)'], ['terraced', 'Terraced (UK)']],
      methodLabel: 'Value it as',
      methods: [['growth', 'My price, grown with the area'], ['median', 'The area median price']],
    },
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

  // Ids end up in HTML attributes, so anything unusual (e.g. from an edited backup) is replaced.
  const safeId = (id, prefix) => (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId(prefix));

  function normCurrency(c, fallback = 'USD') {
    const s = String(c || '').trim().toUpperCase();
    return /^[A-Z]{3,5}$/.test(s) ? s : fallback;
  }

  function normalizeTransaction(raw) {
    const type = TX_TYPES[raw.type] ? raw.type : 'buy';
    const tx = {
      id: safeId(raw.id, 't'),
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
      id: safeId(raw.id, 'h'),
      name: String(raw.name || '').trim(),
      category,
      subcategory: String(raw.subcategory || '').trim(),
      currency: normCurrency(raw.currency),
      unit: String(raw.unit ?? cat.defaultUnit).trim(),
      priceSource: source,
      priceKey: String(raw.priceKey || '').trim(),
      pricePath: String(raw.pricePath || '').trim(),
      priceOption: String(raw.priceOption || '').trim(),
      priceMethod: String(raw.priceMethod || '').trim(),
      currentPrice: raw.currentPrice === '' || raw.currentPrice === undefined || raw.currentPrice === null
        ? null
        : toNumber(raw.currentPrice, null),
      priceUpdatedAt: raw.priceUpdatedAt || null,
      priceError: raw.priceError || null,
      notes: String(raw.notes || '').trim(),
      transactions,
      // Dated manual valuations, so a manually priced asset has a price history too.
      valuations: Array.isArray(raw.valuations)
        ? raw.valuations
          .filter((v) => v && /^\d{4}-\d{2}-\d{2}$/.test(v.date) && Number.isFinite(Number(v.price)))
          .map((v) => ({ date: v.date, price: Number(v.price) }))
          .sort((a, b) => (a.date < b.date ? -1 : 1))
        : [],
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
    if (source === 'metal' || source === 'finnhub' || source === 'alphavantage' || source === 'twelvedata') {
      holding.priceKey = holding.priceKey.toUpperCase();
    }
    if (source === 'coingecko') holding.priceKey = holding.priceKey.toLowerCase();
    if (source === 'cash') holding.currentPrice = 1;
    const src = SOURCES[source];
    if (src.options && !src.options.some(([v]) => v === holding.priceOption)) holding.priceOption = src.options[0][0];
    if (!src.options) holding.priceOption = '';
    if (src.methods && !src.methods.some(([v]) => v === holding.priceMethod)) holding.priceMethod = src.methods[0][0];
    if (!src.methods) holding.priceMethod = '';
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


  // ---------- history & performance ----------

  const DAY_MS = 86400000;
  const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

  /** Money moving into (+) or out of (−) the portfolio because of a transaction. */
  function cashFlow(t) {
    if (t.type === 'buy') return t.quantity * t.price + t.fees;
    if (t.type === 'sell') return -(t.quantity * t.price - t.fees);
    return -(t.amount - t.fees); // income is paid out, so it counts as a return
  }

  /** Record a dated manual valuation (one per day, latest wins). */
  function addValuation(h, date, price) {
    const rest = (h.valuations || []).filter((v) => v.date !== date);
    return [...rest, { date, price }].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /**
   * Daily price function for one holding, in its own currency.
   * `series` (fetched market history) wins where it exists; elsewhere the price
   * is interpolated between known points: trade prices, manual valuations and
   * today's price. Returns { priceOn(date), estimated } where `estimated` says
   * whether any part of the range relies on interpolation.
   */
  function priceModel(h, series, today) {
    if (h.priceSource === 'cash') return { priceOn: () => 1, estimated: false };
    const anchors = new Map();
    for (const t of h.transactions) if (t.type !== 'income' && t.price > 0) anchors.set(t.date, t.price);
    for (const v of h.valuations || []) anchors.set(v.date, v.price);
    if (h.currentPrice > 0) anchors.set(today, h.currentPrice);
    const market = (series || []).filter((p) => p.price > 0);
    const marketStart = market.length ? market[0].date : null;
    // Before market history starts, estimate towards its first price so the line joins up.
    if (marketStart) {
      for (const d of [...anchors.keys()]) if (d >= marketStart) anchors.delete(d);
      anchors.set(marketStart, market[0].price);
    }
    const known = [...anchors.entries()].map(([date, price]) => ({ date, price })).sort((a, b) => (a.date < b.date ? -1 : 1));

    function interpolate(date) {
      if (!known.length) return 0;
      if (date <= known[0].date) return known[0].price;
      for (let i = 1; i < known.length; i++) {
        if (date <= known[i].date) {
          const a = known[i - 1], b = known[i];
          const span = Date.parse(b.date) - Date.parse(a.date);
          const f = span > 0 ? (Date.parse(date) - Date.parse(a.date)) / span : 1;
          return a.price + (b.price - a.price) * f;
        }
      }
      return known[known.length - 1].price;
    }

    let mi = 0;
    let lastDate = '';
    function priceOn(date) {
      if (marketStart && date >= marketStart) {
        if (date < lastDate) mi = 0; // allow restarting from the beginning
        lastDate = date;
        while (mi + 1 < market.length && market[mi + 1].date <= date) mi++;
        // After the last market point, use today's price for today.
        if (date === today && h.currentPrice > 0) return h.currentPrice;
        return market[mi].price;
      }
      return interpolate(date);
    }
    return { priceOn, estimated: !marketStart, marketStart };
  }

  /**
   * Rebuild the portfolio's daily value from transactions and price history.
   * histories: { holdingId: [{date, price}] } in each holding's currency.
   * Returns { points: [{date, value, cost, flow}], estimated: [holding names] }.
   */
  function buildHistory(holdings, { histories = {}, convert, base = 'USD', start, end }) {
    const today = end;
    const models = [];
    const estimated = [];
    let first = null;
    for (const h of holdings) {
      if (!h.transactions.length) continue;
      const rate = convert ? convert(1, h.currency, base) : 1;
      if (rate === null) continue;
      const model = priceModel(h, histories[h.id], today);
      const txs = [...h.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (!first || txs[0].date < first) first = txs[0].date;
      models.push({ h, model, txs, rate, ti: 0, qty: 0, cost: 0 });
    }
    if (!first) return { points: [], estimated: [] };
    const from = start && start > first ? start : first;
    // A holding is "estimated" if any day it was held in range has no market price.
    for (const m of models) {
      if (m.h.priceSource === 'cash') continue;
      const heldFrom = m.txs[0].date > from ? m.txs[0].date : from;
      if (m.model.estimated || m.model.marketStart > heldFrom) estimated.push(m.h.name);
    }
    const points = [];
    for (let d = first; d <= end; d = addDays(d, 1)) {
      let value = 0, cost = 0, flow = 0;
      for (const m of models) {
        while (m.ti < m.txs.length && m.txs[m.ti].date <= d) {
          const t = m.txs[m.ti++];
          flow += cashFlow(t) * m.rate;
          if (t.type === 'buy') { m.qty += t.quantity; m.cost += t.quantity * t.price + t.fees; }
          if (t.type === 'sell') {
            const q = Math.min(t.quantity, m.qty);
            m.cost -= m.qty > 0 ? (m.cost / m.qty) * q : 0;
            m.qty -= q;
            if (m.qty < 1e-12) { m.qty = 0; m.cost = 0; }
          }
        }
        if (m.qty > 0) {
          value += m.qty * m.model.priceOn(d) * m.rate;
          cost += m.cost * m.rate;
        }
      }
      if (d >= from) points.push({ date: d, value, cost, flow });
    }
    return { points, estimated: [...new Set(estimated)] };
  }

  /**
   * Time-weighted return: each day's gain is measured against the money that
   * was in the portfolio, so deposits and withdrawals don't count as gains.
   * Money added counts from the start of its day, money taken out from the end.
   * Returns [{date, pct, value}] with pct cumulative from the first point (0).
   */
  function performance(points) {
    const out = [];
    let growth = 1;
    let gain = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i > 0) {
        const prev = points[i - 1].value;
        const deposit = Math.max(p.flow, 0);
        const withdrawal = Math.max(-p.flow, 0);
        const base = prev + deposit;
        if (base > 1e-9) growth *= (p.value + withdrawal) / base;
        gain += p.value - prev - p.flow;
      }
      out.push({ date: p.date, pct: growth - 1, gain, value: p.value });
    }
    return out;
  }

  /** Return and money gained between two dates (inclusive), excluding deposits. */
  function periodChange(points, fromDate) {
    const slice = points.filter((p) => p.date >= fromDate);
    if (slice.length < 2) return null;
    const perf = performance(slice);
    const last = perf[perf.length - 1];
    return { pct: last.pct, gain: last.gain, from: slice[0].date };
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
        valuations: [{ date: '2022-03-01', price: 13800 }, { date: '2023-10-01', price: 10900 }],
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
    cashFlow, addValuation, addDays, priceModel, buildHistory, performance, periodChange,
  };
});
