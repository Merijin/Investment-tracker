/* UI wiring: state, persistence, sync, rendering and dialogs. */
(function () {
  'use strict';
  const P = window.Portfolio;
  const Prices = window.Prices;
  const Sync = window.Sync;
  const { renderAllocation, renderHistory, escapeHTML } = window.Charts;

  const STORAGE_KEY = 'investment-tracker:v1';
  const AUTO_REFRESH_MS = 10 * 60 * 1000;
  const RATES_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  const SYNC_DEBOUNCE_MS = 2500;
  const HISTORY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  const RANGES = [
    { id: '1w', label: '1W', days: 7 },
    { id: '1m', label: '1M', days: 30 },
    { id: '3m', label: '3M', days: 91 },
    { id: 'ytd', label: 'YTD' },
    { id: '1y', label: '1Y', days: 365 },
    { id: 'all', label: 'All' },
  ];

  const SUBCATEGORY_HINTS = {
    stock: ['Common stock', 'Dividend stock', 'ADR', 'Employee shares (RSU)'],
    etf: ['Index fund', 'Mutual fund', 'REIT', 'Bond ETF', 'Pension fund'],
    crypto: ['Coin', 'Stablecoin', 'Staked', 'Cold wallet'],
    metal: ['Bullion coin', 'Bullion bar', 'Numismatic coin', 'Jewelry (scrap value)'],
    collectible: ['Pokémon card', 'Pokémon card — Reverse Holofoil', 'Magic: The Gathering card', 'MTG card — Foil',
      'Yu-Gi-Oh! card', 'Sports card', 'Graded card (PSA 10)', 'Sealed product', 'Watch', 'Sneakers', 'Art',
      'Wine / whisky', 'Comics', 'LEGO', 'Coins & stamps', 'Vintage toys', 'Video games'],
    real_estate: ['Primary residence', 'Rental property', 'Land', 'Crowdfunded property'],
    bond: ['Government bond', 'Corporate bond', 'Treasury bill', 'Certificate of deposit', 'Savings bond'],
    cash: ['Savings account', 'Current account', 'Money market', 'Emergency fund', 'Foreign currency'],
    other: ['Private equity', 'Business stake', 'Loan / note', 'Domain name', 'P2P lending', 'Pension'],
  };
  const UNIT_HINTS = {
    stock: ['shares'], etf: ['shares', 'units'], crypto: ['coins', 'tokens'], metal: ['ozt', 'g', 'kg'],
    collectible: ['items', 'cards', 'packs', 'boxes', 'bottles'], real_estate: ['units', 'properties'],
    bond: ['units', 'bonds'], cash: [''], other: ['units'],
  };
  const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'NZD', 'SEK', 'NOK',
    'DKK', 'SGD', 'HKD', 'KRW', 'ZAR', 'BRL', 'MXN', 'PLN', 'TRY', 'AED', 'BTC', 'ETH'];

  // ---------- state & persistence ----------
  const state = {
    holdings: [],
    deleted: {},
    snapshots: [],
    savedAt: null,
    shared: { baseCurrency: 'USD', updatedAt: '' },               // synced
    keys: { finnhub: '', twelvedata: '', alphavantage: '', pokemontcg: '' },
    device: { theme: 'dark', autoRefresh: true, syncKeys: false, syncToken: '', gistId: '', lastSync: null, darkDefault: true },
    rates: null,          // { rates: {EUR: 0.92, ...}, fetchedAt }
    histories: {},        // device cache: { cacheKey: { fetchedAt, points: [{date, price}] | null, error } }
    lastRefresh: null,
    ui: { sort: 'value', asc: false, search: '', category: 'all', range: '1y', mode: 'value', showClosed: false, detailsId: null },
  };

  const nowISO = () => new Date().toISOString();
  const today = () => new Date().toISOString().slice(0, 10);
  const base = () => state.shared.baseCurrency;
  const convert = (...args) => P.makeConverter(state.rates && state.rates.rates)(...args);
  const $ = (sel) => document.querySelector(sel);

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      state.holdings = (saved.holdings || []).map(P.normalizeHolding);
      state.deleted = saved.deleted || {};
      state.snapshots = saved.snapshots || [];
      state.savedAt = saved.savedAt || null;
      state.rates = saved.rates || null;
      state.lastRefresh = saved.lastRefresh || null;
      state.histories = saved.histories || {};
      if (saved.ui) {
        if (RANGES.some((r) => r.id === saved.ui.range)) state.ui.range = saved.ui.range;
        if (saved.ui.mode === 'return') state.ui.mode = 'return';
      }
      if (saved.version >= 2) {
        Object.assign(state.shared, saved.shared);
        Object.assign(state.keys, saved.keys);
        const hadDarkDefault = saved.device && saved.device.darkDefault;
        Object.assign(state.device, saved.device);
        // Dark became the default; switch anyone still on the old default once.
        if (!hadDarkDefault) state.device = { ...state.device, theme: 'dark', darkDefault: true };
      } else if (saved.settings) {
        // v1 kept everything in one settings object
        state.keys.finnhub = saved.settings.finnhubKey || '';
        state.keys.pokemontcg = saved.settings.pokemonKey || '';
        state.device.theme = saved.settings.theme || 'system';
        state.device.autoRefresh = saved.settings.autoRefresh !== false;
      }
    } catch (err) {
      console.warn('Could not read saved data', err);
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 2, holdings: state.holdings, deleted: state.deleted, snapshots: state.snapshots,
        savedAt: state.savedAt, shared: state.shared, keys: state.keys, device: state.device,
        rates: state.rates, lastRefresh: state.lastRefresh, histories: state.histories,
        ui: { range: state.ui.range, mode: state.ui.mode },
      }));
    } catch (err) {
      console.warn('Could not save data', err);
      setStatus('⚠ Could not save — browser storage is unavailable.');
    }
  }

  /** Record a change: snapshot today's value, save locally, and queue a sync. */
  function commit() {
    state.savedAt = nowISO();
    if (state.holdings.length) {
      const s = P.summarize(state.holdings, convert, base());
      if (!s.unconverted) state.snapshots = P.recordSnapshot(state.snapshots, state.savedAt, s.value, s.cost, base());
    }
    persist();
    scheduleSync();
  }

  function touch(h) {
    h.updatedAt = nowISO();
    return h;
  }

  // ---------- sync ----------
  function buildDoc({ includeKeys = state.device.syncKeys } = {}) {
    const settings = { ...state.shared };
    if (includeKeys) settings.keys = { ...state.keys };
    return {
      app: 'investment-tracker', version: 2, savedAt: state.savedAt || '',
      holdings: state.holdings, deleted: state.deleted, snapshots: state.snapshots, settings,
    };
  }

  function applyDoc(doc) {
    state.holdings = (doc.holdings || []).map(P.normalizeHolding);
    state.deleted = doc.deleted || {};
    state.snapshots = doc.snapshots || [];
    state.savedAt = doc.savedAt || state.savedAt;
    if (doc.settings) {
      const { keys, ...shared } = doc.settings;
      state.shared = { ...state.shared, ...shared };
      if (keys && state.device.syncKeys) {
        for (const [k, v] of Object.entries(keys)) if (v) state.keys[k] = v;
      }
    }
  }

  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;
  let syncError = null;

  function scheduleSync() {
    if (!state.device.syncToken) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, SYNC_DEBOUNCE_MS);
    renderSyncStatus('pending');
  }

  async function runSync() {
    if (!state.device.syncToken) return;
    if (!navigator.onLine) { renderSyncStatus('offline'); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    clearTimeout(syncTimer);
    renderSyncStatus('syncing');
    try {
      const { doc, gistId } = await Sync.syncOnce({
        token: state.device.syncToken, gistId: state.device.gistId, local: buildDoc(),
      });
      state.device.gistId = gistId;
      // Fold in anything edited locally while the request was in flight.
      applyDoc(Sync.mergeDocs(buildDoc(), doc));
      state.device.lastSync = nowISO();
      syncError = null;
      persist();
      render();
    } catch (err) {
      syncError = err.message || String(err);
    } finally {
      syncing = false;
      renderSyncStatus();
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
  }

  function renderSyncStatus(mode) {
    const pill = $('#sync-status');
    pill.hidden = !state.device.syncToken;
    pill.classList.toggle('error', !!syncError && !mode);
    pill.textContent = mode === 'syncing' ? '⟳ Syncing…'
      : mode === 'pending' ? '● Unsynced changes'
        : mode === 'offline' ? '○ Offline'
          : syncError ? '⚠ Sync failed'
            : state.device.lastSync ? `✓ Synced ${fmt.ago(state.device.lastSync)}` : '○ Not synced yet';
    pill.title = syncError || 'Sync now';
    const info = $('#sync-info');
    if (info) {
      info.textContent = !state.device.syncToken ? 'Sync is off.'
        : syncError ? syncError
          : state.device.lastSync ? `Last synced ${fmt.ago(state.device.lastSync)}.` : 'Not synced yet.';
    }
  }

  // ---------- formatting ----------
  const nfCache = new Map();
  function nf(key, make) {
    if (!nfCache.has(key)) nfCache.set(key, make());
    return nfCache.get(key);
  }
  function currencyFmt(cur, opts = {}) {
    const k = cur + JSON.stringify(opts);
    return nf(k, () => {
      const crypto = cur === 'BTC' || cur === 'ETH';
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
          ...(crypto && !opts.notation ? { maximumFractionDigits: 6 } : {}), ...opts,
        });
      } catch {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', ...opts });
      }
    });
  }
  const fmt = {
    money: (n, cur = base()) => currencyFmt(cur, Math.abs(n) >= 100000 ? { maximumFractionDigits: 0 } : {}).format(n),
    price: (n, cur = base()) => (n !== 0 && Math.abs(n) < 1
      ? currencyFmt(cur, { maximumSignificantDigits: 4 }).format(n)
      : fmt.money(n, cur)),
    signedMoney: (n, cur) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt.money(Math.abs(n), cur),
    pct: (n) => (n === null ? '—' : (n * 100).toFixed(Math.abs(n) < 0.1 ? 1 : 0) + '%'),
    signedPct: (n) => {
      if (n === null) return '';
      const t = (Math.abs(n) * 100).toFixed(1);
      return (Number(t) === 0 ? '' : n > 0 ? '+' : '−') + t + '%';
    },
    compact: (n) => currencyFmt(base(), { notation: 'compact', maximumFractionDigits: 1 }).format(n),
    qty: (n) => nf('qty', () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 })).format(n),
    shortDate: (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    longDate: (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    monthYear: (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
    axisPct: (n) => (n > 0 ? '+' : '') + (Math.abs(n) >= 0.1 || n === 0 ? Math.round(n * 100) : (n * 100).toFixed(1)) + '%',
    ago: (iso) => {
      if (!iso) return 'never';
      const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins} min ago`;
      if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
      return `${Math.round(mins / 1440)} d ago`;
    },
  };
  const gainClass = (n) => (n >= 0 ? 'gain' : 'loss');
  const setStatus = (text) => { $('#refresh-status').textContent = text; };

  function applyTheme() {
    const t = state.device.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  function currencyList() {
    let all = [];
    try { all = Intl.supportedValuesOf('currency'); } catch { /* older browsers */ }
    const rates = state.rates ? Object.keys(state.rates.rates) : [];
    const set = new Set([...COMMON_CURRENCIES, ...all, ...rates.filter((c) => /^[A-Z]{3}$/.test(c))]);
    return [...set];
  }

  function currencyName(code) {
    try {
      return nf('dn', () => new Intl.DisplayNames(undefined, { type: 'currency' })).of(code);
    } catch {
      return code;
    }
  }

  function fillCurrencySelect(sel, value) {
    const list = currencyList();
    const common = list.filter((c) => COMMON_CURRENCIES.includes(c));
    const rest = list.filter((c) => !COMMON_CURRENCIES.includes(c)).sort();
    const opt = (c) => `<option value="${c}">${c} — ${escapeHTML(c === 'BTC' ? 'Bitcoin' : c === 'ETH' ? 'Ether' : currencyName(c))}</option>`;
    sel.innerHTML = `<optgroup label="Common">${common.map(opt).join('')}</optgroup>` +
      `<optgroup label="All currencies">${rest.map(opt).join('')}</optgroup>`;
    if (value && !list.includes(value)) sel.insertAdjacentHTML('afterbegin', opt(value));
    sel.value = value || 'USD';
  }

  // ---------- rendering ----------
  function render() {
    const has = state.holdings.length > 0;
    $('#empty-state').hidden = has;
    $('#dashboard').hidden = !has;
    $('#btn-refresh').hidden = !has;
    renderSyncStatus(syncing ? 'syncing' : undefined);
    if (!has) return;

    const s = P.summarize(state.holdings, convert, base());
    $('#stat-value').textContent = fmt.money(s.value);
    $('#stat-cost').textContent = `${fmt.money(s.cost)} invested`;
    const gainEl = $('#stat-gain');
    gainEl.textContent = fmt.signedMoney(s.gain);
    gainEl.className = 'stat-value ' + gainClass(s.gain);
    $('#stat-gain-pct').textContent = s.gainPct === null ? '' : fmt.signedPct(s.gainPct) + ' on open positions';
    const realEl = $('#stat-realized');
    realEl.textContent = fmt.signedMoney(s.realized);
    realEl.className = 'stat-value ' + gainClass(s.realized);
    $('#stat-count').textContent = s.count;
    $('#stat-classes').textContent = `across ${s.allocation.length} asset class${s.allocation.length === 1 ? '' : 'es'}` +
      (s.closed ? ` · ${s.closed} sold` : '');
    const warn = $('#fx-warning');
    warn.hidden = !s.unconverted;
    warn.textContent = s.unconverted
      ? `⚠ ${s.unconverted} holding${s.unconverted === 1 ? ' is' : 's are'} left out of the totals because exchange rates to ${base()} haven't loaded yet. Refresh prices while online.`
      : '';

    renderAllocation($('#allocation'), s.allocation, fmt);
    renderPerformance();
    renderFilterOptions(s);
    renderTable(s);
    if (state.lastRefresh && !refreshing) setStatus(`Prices updated ${fmt.ago(state.lastRefresh)}`);
    if (state.ui.detailsId) renderDetails();
  }

  // ---------- performance chart ----------
  const histKey = (h) => [h.priceSource, h.priceKey, h.currency, h.unit].join('|');

  /** Market history per holding id, in holding currency, from the device cache. */
  function historiesById() {
    const out = {};
    for (const h of state.holdings) {
      const c = state.histories[histKey(h)];
      if (c && c.points) out[h.id] = c.points;
    }
    return out;
  }

  function rangeStart(id, first) {
    const r = RANGES.find((x) => x.id === id);
    if (id === 'all') return first;
    if (id === 'ytd') return today().slice(0, 4) + '-01-01';
    return P.addDays(today(), -r.days);
  }

  let histMemo = { key: null, value: null };
  function fullHistory() {
    // Rebuilding is cheap, but render() runs on every keystroke in search.
    const key = state.savedAt + '|' + base() + '|' + (state.rates && state.rates.fetchedAt) + '|' + historyVersion;
    if (histMemo.key !== key) {
      histMemo = {
        key,
        value: P.buildHistory(state.holdings, { histories: historiesById(), convert, base: base(), end: today() }),
      };
    }
    return histMemo.value;
  }

  function renderPerformance() {
    const { points } = fullHistory();
    const first = points.length ? points[0].date : today();
    const cls = (n) => (Math.abs(n) < 0.0005 ? '' : n > 0 ? 'gain' : 'loss');

    // Period chips double as the range selector.
    $('#range').innerHTML = RANGES.map((r) => {
      const from = rangeStart(r.id, first);
      const ch = from >= first || r.id === 'all' ? P.periodChange(points, from) : null;
      const v = ch ? `<span class="p-value ${cls(ch.pct)}">${fmt.signedPct(ch.pct)}</span>` : '<span class="p-value none">—</span>';
      return `<button data-range="${r.id}" class="${r.id === state.ui.range ? 'active' : ''}"
        title="${ch ? fmt.signedMoney(ch.gain) + ' since ' + fmt.longDate(ch.from) : 'Not enough history'}">
        <span class="p-label">${r.label}</span>${v}</button>`;
    }).join('');

    const from = rangeStart(state.ui.range, first);
    const slice = points.filter((p) => p.date >= from);
    const perf = P.performance(slice).map((p, i) => ({ ...slice[i], ...p }));
    const last = perf[perf.length - 1];
    const label = RANGES.find((r) => r.id === state.ui.range).label;
    $('#perf-headline').innerHTML = perf.length > 1
      ? `<b class="${cls(last.pct)}">${fmt.signedPct(last.pct)}</b> · <span class="${cls(last.gain)}">${fmt.signedMoney(last.gain)}</span> · ${label === 'All' ? 'all time' : label}`
      : '';
    document.querySelectorAll('#chart-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.ui.mode));
    $('#chart-legend').hidden = state.ui.mode !== 'value' || perf.length < 2;
    renderHistory($('#history'), perf, {
      mode: state.ui.mode, fmt,
      emptyText: points.length ? 'Not enough history in this range yet.' : 'Add a transaction to see your history.',
    });

    const est = P.buildHistory(state.holdings, { histories: historiesById(), convert, base: base(), start: from, end: today() }).estimated;
    const note = [];
    if (historyStatus) note.push(historyStatus);
    if (est.length) {
      note.push(`Estimated between known prices for ${est.length <= 3 ? est.join(', ') : est.slice(0, 3).join(', ') + ` and ${est.length - 3} more`}` +
        ' (no free price history for them).');
    }
    note.push('Return % excludes money added or withdrawn.');
    $('#chart-note').textContent = note.join(' ');
  }

  // ---------- price history download ----------
  let historyVersion = 0;
  let historyStatus = '';
  let fetchingHistory = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function refreshHistories(force) {
    if (fetchingHistory || !navigator.onLine) return;
    const settings = { keys: state.keys };
    const todo = [];
    const seen = new Set();
    for (const h of state.holdings) {
      const key = histKey(h);
      if (seen.has(key) || !h.transactions.length || !Prices.historySource(h, settings)) continue;
      seen.add(key);
      const c = state.histories[key];
      if (!force && c && Date.now() - Date.parse(c.fetchedAt) < HISTORY_MAX_AGE_MS) continue;
      todo.push(h);
    }
    if (!todo.length) return;
    fetchingHistory = true;
    // Free tiers allow only a few requests a minute, so fetch one at a time.
    const gap = { coingecko: 2500, twelvedata: 8000, alphavantage: 15000 };
    const limited = new Set();
    try {
      for (let i = 0; i < todo.length; i++) {
        const h = todo[i];
        const kind = Prices.historySource(h, settings).kind;
        if (limited.has(kind)) continue;
        historyStatus = `Loading price history ${i + 1}/${todo.length}…`;
        renderPerformanceSafe();
        try {
          const points = await Prices.fetchHistory(h, {
            settings, rates: state.rates && state.rates.rates, fetchFn: fetch.bind(window), days: 365,
          });
          state.histories[histKey(h)] = { fetchedAt: nowISO(), points };
        } catch (err) {
          if (/429/.test(err.message)) limited.add(kind);
          else state.histories[histKey(h)] = { fetchedAt: nowISO(), points: null, error: err.message };
        }
        historyVersion++;
        if (i < todo.length - 1) await sleep(gap[kind] || 2000);
      }
    } finally {
      fetchingHistory = false;
      historyStatus = limited.size ? 'Some price history is rate-limited; it will load on a later refresh.' : '';
      persist();
      renderPerformanceSafe();
    }
  }

  function renderPerformanceSafe() {
    if (state.holdings.length && !$('#dashboard').hidden) renderPerformance();
  }

  function renderFilterOptions(s) {
    const sel = $('#filter-category');
    const current = state.ui.category;
    sel.innerHTML = '<option value="all">All asset classes</option>' +
      s.allocation.map((a) => `<option value="${a.id}">${escapeHTML(a.label)} (${a.count})</option>`).join('');
    sel.value = s.allocation.some((a) => a.id === current) ? current : 'all';
    state.ui.category = sel.value;
  }

  function priceNote(h) {
    if (h.priceError) return `<div class="sub warn" title="${escapeHTML(h.priceError)}">⚠ ${escapeHTML(h.priceError)}</div>`;
    if (h.priceSource === 'cash') return '<div class="sub">Cash</div>';
    if (h.priceSource === 'manual') return `<div class="sub">Manual · ${fmt.ago(h.priceUpdatedAt)}</div>`;
    const key = h.priceKey.length > 18 ? h.priceKey.slice(0, 16) + '…' : h.priceKey;
    return `<div class="sub">${escapeHTML(key)} · ${fmt.ago(h.priceUpdatedAt)}</div>`;
  }

  function renderTable(summary) {
    const { sort, asc, search, category, showClosed } = state.ui;
    const q = search.trim().toLowerCase();
    const rows = state.holdings
      .map((h) => ({ h, m: P.holdingMetrics(h, convert, base()) }))
      .filter(({ m }) => showClosed || !m.closed)
      .filter(({ h }) => category === 'all' || h.category === category)
      .filter(({ h }) => !q || [h.name, h.subcategory, h.priceKey, h.notes, h.currency, P.categoryById(h.category).label]
        .some((f) => f && f.toLowerCase().includes(q)));

    const key = {
      name: (r) => r.h.name.toLowerCase(),
      category: (r) => P.categoryById(r.h.category).label,
      quantity: (r) => r.m.quantity,
      price: (r) => r.h.currentPrice || 0,
      value: (r) => r.m.value,
      gain: (r) => r.m.gain,
      share: (r) => r.m.value,
    }[sort];
    rows.sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * (asc ? 1 : -1);
    });

    document.querySelectorAll('.holdings th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === sort);
      th.classList.toggle('asc', th.dataset.sort === sort && asc);
    });

    const body = $('#holdings-body');
    if (!rows.length) {
      body.innerHTML = '<tr class="no-results"><td colspan="8">No holdings match your filters.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(({ h, m }) => {
      const cat = P.categoryById(h.category);
      const foreign = h.currency !== base();
      const valueSub = m.fxMissing ? `<div class="sub warn">no ${h.currency}→${base()} rate</div>`
        : foreign ? `<div class="sub">${fmt.money(m.nativeValue, h.currency)}</div>`
          : `<div class="sub">cost ${fmt.money(m.cost)}</div>`;
      const realized = m.realized + m.income;
      return `<tr class="${m.closed ? 'closed' : ''}">
        <td><button class="name-link" data-details="${h.id}">${escapeHTML(h.name)}</button>${m.closed ? '<span class="badge">sold</span>' : ''}
          ${h.subcategory ? `<div class="sub">${escapeHTML(h.subcategory)}</div>` : ''}</td>
        <td><span class="class-chip"><span class="swatch" style="background:var(--series-${cat.slot})"></span>${escapeHTML(cat.label)}</span></td>
        <td class="num">${fmt.qty(m.quantity)} <span class="muted">${escapeHTML(h.unit)}</span></td>
        <td class="num">${m.priced ? fmt.price(h.currentPrice, h.currency) : '<span class="muted">—</span>'}${priceNote(h)}</td>
        <td class="num">${m.fxMissing ? '—' : fmt.money(m.value)}${valueSub}</td>
        <td class="num ${gainClass(m.gain)}">${m.closed ? '' : fmt.signedMoney(m.gain)}<div class="sub ${gainClass(m.gain)}">${m.closed ? '' : fmt.signedPct(m.gainPct)}</div>
          ${realized ? `<div class="sub ${gainClass(realized)}">realized ${fmt.signedMoney(realized, h.currency)}</div>` : ''}</td>
        <td class="num">${fmt.pct(summary.value > 0 && !m.closed ? m.value / summary.value : 0)}</td>
        <td class="actions">
          <button class="link-btn" data-quick-tx="buy" data-id="${h.id}">Buy</button>
          ${m.quantity > 0 ? `<button class="link-btn" data-quick-tx="sell" data-id="${h.id}">Sell</button>` : ''}
          <button class="link-btn" data-details="${h.id}">Details</button>
        </td>
      </tr>`;
    }).join('');
  }

  // ---------- price refresh ----------
  let refreshing = false;
  async function refreshRates(force) {
    const stale = !state.rates || Date.now() - Date.parse(state.rates.fetchedAt) > RATES_MAX_AGE_MS;
    if (!force && !stale) return;
    try {
      state.rates = await Prices.fetchRates({ fetchFn: fetch.bind(window) });
    } catch (err) {
      console.warn('Exchange rates unavailable', err);
    }
  }

  async function refreshPrices(onlyIds) {
    if (refreshing) return;
    refreshing = true;
    const btn = $('#btn-refresh');
    btn.disabled = true;
    setStatus(onlyIds ? 'Fetching price…' : 'Refreshing prices…');
    try {
      await refreshRates(!onlyIds);
      const targets = state.holdings.filter((h) => !['manual', 'cash'].includes(h.priceSource) &&
        (!onlyIds || onlyIds.includes(h.id)) && (onlyIds || !P.holdingMetrics(h).closed));
      const updated = await Prices.refreshAll(targets, {
        settings: { keys: state.keys }, rates: state.rates && state.rates.rates, fetchFn: fetch.bind(window),
      });
      const byId = new Map(updated.map((h) => [h.id, h]));
      // Price updates deliberately don't bump updatedAt; sync merges prices by priceUpdatedAt.
      state.holdings = state.holdings.map((h) => byId.get(h.id) || h);
      if (!onlyIds) state.lastRefresh = nowISO();
      commit();
      refreshing = false;
      render();
      const failed = updated.filter((h) => h.priceError).length;
      setStatus(failed
        ? `Updated ${updated.length - failed} of ${updated.length} prices · ${failed} failed (see table)`
        : `Prices updated ${fmt.ago(nowISO())}`);
    } catch (err) {
      setStatus('Refresh failed: ' + err.message);
    } finally {
      refreshing = false;
      btn.disabled = false;
    }
    refreshHistories();
  }

  // ---------- add / edit holding dialog ----------
  const dialog = $('#holding-dialog');
  const form = $('#holding-form');

  function fillStaticOptions() {
    form.category.innerHTML = P.CATEGORIES.map((c) => `<option value="${c.id}">${escapeHTML(c.label)}</option>`).join('');
    $('#price-key-metal').innerHTML = Object.entries(P.METALS)
      .map(([k, v]) => `<option value="${k}">${v} (${k})</option>`).join('');
  }

  function syncCategory(resetUnit) {
    const cat = P.categoryById(form.category.value);
    const prevSource = form.priceSource.value;
    const others = Object.keys(P.SOURCES).filter((s) => !cat.sources.includes(s));
    const opt = (s) => `<option value="${s}">${escapeHTML(P.SOURCES[s].label)}</option>`;
    form.priceSource.innerHTML = `<optgroup label="Suggested">${cat.sources.map(opt).join('')}</optgroup>` +
      `<optgroup label="Other sources">${others.map(opt).join('')}</optgroup>`;
    form.priceSource.value = resetUnit ? cat.sources[0] : prevSource || cat.sources[0];
    $('#subcategory-list').innerHTML = SUBCATEGORY_HINTS[cat.id].map((s) => `<option value="${escapeHTML(s)}">`).join('');
    $('#unit-list').innerHTML = UNIT_HINTS[cat.id].map((u) => `<option value="${u}">`).join('');
    if (resetUnit) form.unit.value = cat.defaultUnit;
    syncSource();
  }

  function syncSource() {
    const src = form.priceSource.value;
    const info = P.SOURCES[src];
    const auto = !['manual', 'cash'].includes(src);
    const isMetal = src === 'metal';
    const isCash = src === 'cash';
    $('#price-key-field').hidden = !auto;
    $('#price-key-input').hidden = isMetal;
    $('#price-key-metal').hidden = !isMetal;
    $('#btn-find').hidden = !info.search;
    $('#price-path-field').hidden = src !== 'custom';
    $('#search-results').hidden = true;
    $('#price-key-label').textContent = info.keyLabel || '';
    $('#price-key-hint').textContent = info.keyHint || '';
    $('#unit-field').hidden = isCash;
    if (isMetal && !P.METAL_UNITS[form.unit.value]) form.unit.value = 'ozt';
    if (isCash) form.unit.value = '';
    $('#current-price-field').hidden = isCash;
    form.currentPrice.placeholder = auto ? 'Leave blank to fetch automatically' : 'What is one unit worth today?';
    $('#current-price-hint').textContent = auto
      ? 'Fetched automatically; anything typed here is replaced on the next refresh.'
      : 'Update this whenever you get a new valuation (sold listings, appraisal, statement).';
    $('#first-qty-label').textContent = isCash ? 'Amount deposited' : 'Quantity';
    $('#first-price-field').hidden = isCash;
    syncCurrencyLabels();
  }

  function syncCurrencyLabels() {
    document.querySelectorAll('#holding-form .cur-label').forEach((el) => { el.textContent = `(${form.currency.value})`; });
  }

  let editingId = null;
  function openHoldingDialog(holding) {
    form.reset();
    editingId = holding ? holding.id : null;
    $('#form-errors').textContent = '';
    $('#holding-title').textContent = holding ? 'Edit investment' : 'Add investment';
    const h = holding || { category: 'stock', currency: base() };
    form.id.value = h.id || '';
    form.category.value = h.category;
    fillCurrencySelect(form.currency, h.currency);
    form.priceSource.innerHTML = '';
    syncCategory(!holding);
    if (holding) {
      form.priceSource.value = h.priceSource;
      for (const f of ['name', 'subcategory', 'unit', 'priceKey', 'pricePath', 'notes']) form[f].value = h[f] ?? '';
      if (h.priceSource === 'metal' && h.priceKey) form.priceKeyMetal.value = h.priceKey;
      form.currentPrice.value = h.currentPrice ?? '';
      syncSource();
    }
    $('#first-purchase').hidden = !!holding;
    form.txDate.value = today();
    dialog.showModal();
    form.name.focus();
  }

  form.category.addEventListener('change', () => syncCategory(true));
  form.priceSource.addEventListener('change', syncSource);
  form.currency.addEventListener('change', syncCurrencyLabels);

  // Symbol / card search
  $('#btn-find').addEventListener('click', async () => {
    const box = $('#search-results');
    const src = form.priceSource.value;
    const query = form.priceKey.value.trim() || form.name.value.trim();
    box.hidden = false;
    if (!query) { box.innerHTML = '<div class="sr-msg">Type a name or symbol first.</div>'; return; }
    box.innerHTML = '<div class="sr-msg">Searching…</div>';
    try {
      const results = await Prices.search(src, query, { settings: { keys: state.keys }, fetchFn: fetch.bind(window) });
      if (!results.length) { box.innerHTML = '<div class="sr-msg">No matches.</div>'; return; }
      box.innerHTML = results.map((r, i) => `<button type="button" data-i="${i}">${escapeHTML(r.name)}
        <span class="sr-detail">${escapeHTML(r.key)} · ${escapeHTML(r.detail || '')}${r.currency ? ' · ' + escapeHTML(r.currency) : ''}</span></button>`).join('');
      box.onclick = (e) => {
        const b = e.target.closest('button[data-i]');
        if (!b) return;
        const r = results[Number(b.dataset.i)];
        form.priceKey.value = r.key;
        if (!form.name.value.trim()) form.name.value = r.name;
        if (r.currency && /^[A-Za-z]{3}$/.test(r.currency)) {
          fillCurrencySelect(form.currency, r.currency.toUpperCase());
          syncCurrencyLabels();
        }
        box.hidden = true;
      };
    } catch (err) {
      box.innerHTML = `<div class="sr-msg">⚠ ${escapeHTML(err.message)}</div>`;
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (data.priceSource === 'metal') data.priceKey = data.priceKeyMetal;
    const existing = state.holdings.find((h) => h.id === editingId);
    const errors = [];

    let firstTx = null;
    if (!existing) {
      const isCash = data.priceSource === 'cash';
      firstTx = P.normalizeTransaction({
        type: 'buy', date: data.txDate, quantity: data.txQuantity,
        price: isCash ? 1 : data.txPrice, fees: data.txFees,
      });
      errors.push(...P.validateTransaction(firstTx));
      if (!isCash && data.txPrice === '') errors.push('Enter the price you paid per unit.');
    }

    const priceTyped = data.currentPrice !== '';
    const priceChanged = !existing || String(existing.currentPrice ?? '') !== data.currentPrice;
    const norm = (v) => String(v ?? '').trim().toUpperCase();
    const lookupChanged = !existing || ['priceKey', 'priceSource', 'unit', 'subcategory', 'currency', 'pricePath']
      .some((f) => norm(existing[f]) !== norm(data[f]));
    const holding = P.normalizeHolding({
      ...(existing || {}),
      ...data,
      id: existing ? existing.id : undefined,
      transactions: existing ? existing.transactions : [firstTx],
      // A manual holding with no valuation starts at what you paid.
      currentPrice: priceTyped ? data.currentPrice
        : data.priceSource === 'manual' && firstTx ? firstTx.price
          : existing && !lookupChanged ? existing.currentPrice : null,
      priceUpdatedAt: priceChanged && (priceTyped || data.priceSource === 'manual') ? nowISO() : existing && existing.priceUpdatedAt,
      priceError: null,
      updatedAt: nowISO(),
    });
    errors.push(...P.validateHolding(holding));
    if (errors.length) {
      $('#form-errors').textContent = errors.join(' ');
      return;
    }
    if (holding.priceSource === 'manual' && priceTyped && priceChanged && holding.currentPrice > 0) {
      holding.valuations = P.addValuation(holding, today(), holding.currentPrice);
    }
    state.holdings = existing
      ? state.holdings.map((h) => (h.id === holding.id ? holding : h))
      : [...state.holdings, holding];
    commit();
    render();
    dialog.close();
    const auto = !['manual', 'cash'].includes(holding.priceSource);
    if (auto && (lookupChanged || !priceTyped)) refreshPrices([holding.id]);
  });

  // ---------- details dialog ----------
  const details = $('#details-dialog');

  function openDetails(id) {
    state.ui.detailsId = id;
    renderDetails();
    if (!details.open) details.showModal();
  }

  details.addEventListener('close', () => { state.ui.detailsId = null; });

  function renderDetails() {
    const h = state.holdings.find((x) => x.id === state.ui.detailsId);
    if (!h) { if (details.open) details.close(); return; }
    const m = P.holdingMetrics(h, convert, base());
    const cur = h.currency;
    const cat = P.categoryById(h.category);
    $('#details-title').textContent = h.name;
    $('#details-sub').textContent = [cat.label, h.subcategory, cur, P.SOURCES[h.priceSource].label + (h.priceKey ? ` (${h.priceKey})` : '')]
      .filter(Boolean).join(' · ');
    const stat = (k, v, cls = '') => `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    $('#details-stats').innerHTML = [
      stat('Quantity', `${fmt.qty(m.quantity)} ${escapeHTML(h.unit)}`),
      stat('Average cost', m.quantity ? fmt.price(m.avgCost, cur) : '—'),
      stat('Current price', m.priced ? fmt.price(h.currentPrice, cur) : '—'),
      stat('Market value', fmt.money(m.nativeValue, cur)),
      stat('Unrealized', fmt.signedMoney(m.nativeGain, cur), gainClass(m.nativeGain)),
      stat('Realized', fmt.signedMoney(m.realized, cur), gainClass(m.realized)),
      stat('Income', fmt.money(m.income, cur)),
      stat('Total invested', fmt.money(m.invested, cur)),
    ].join('');
    document.querySelector('#details-dialog [data-tx="sell"]').hidden = !(m.quantity > 0);

    const txs = [...h.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    $('#tx-body').innerHTML = txs.length ? txs.map((t) => {
      const total = t.type === 'income' ? t.amount - t.fees
        : t.type === 'buy' ? t.quantity * t.price + t.fees : t.quantity * t.price - t.fees;
      return `<tr>
        <td>${fmt.longDate(t.date)}</td>
        <td><span class="tx-type ${t.type}">${P.TX_TYPES[t.type]}</span></td>
        <td class="num">${t.type === 'income' ? '' : fmt.qty(t.quantity)}</td>
        <td class="num">${t.type === 'income' ? '' : fmt.price(t.price, cur)}</td>
        <td class="num">${t.fees ? fmt.money(t.fees, cur) : ''}</td>
        <td class="num">${fmt.money(total, cur)}</td>
        <td class="muted">${escapeHTML(t.note)}</td>
        <td class="actions">
          <button class="link-btn" data-edit-tx="${t.id}">Edit</button>
          <button class="link-btn" data-delete-tx="${t.id}">Delete</button>
        </td></tr>`;
    }).join('') : '<tr class="no-results"><td colspan="8">No transactions yet.</td></tr>';
  }

  details.addEventListener('click', (e) => {
    const h = state.holdings.find((x) => x.id === state.ui.detailsId);
    if (!h) return;
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tx) openTxDialog(h.id, t.dataset.tx);
    if (t.dataset.editTx) openTxDialog(h.id, null, h.transactions.find((x) => x.id === t.dataset.editTx));
    if (t.dataset.deleteTx) {
      const tx = h.transactions.find((x) => x.id === t.dataset.deleteTx);
      if (!tx) return;
      const remaining = h.transactions.filter((x) => x.id !== tx.id);
      const check = P.position({ transactions: remaining });
      if (check.oversold) { alert('Deleting this would leave a sale larger than the amount you held. Delete or edit the sale first.'); return; }
      if (!confirm(`Delete this ${P.TX_TYPES[tx.type].toLowerCase()} from ${fmt.longDate(tx.date)}?`)) return;
      h.transactions = remaining;
      state.deleted[tx.id] = nowISO();
      touch(h);
      commit();
      render();
    }
    if (t.dataset.action === 'edit-holding') { details.close(); openHoldingDialog(h); }
    if (t.dataset.action === 'delete-holding') {
      if (!confirm(`Delete "${h.name}" and all its transactions?`)) return;
      state.holdings = state.holdings.filter((x) => x.id !== h.id);
      state.deleted[h.id] = nowISO();
      details.close();
      commit();
      render();
    }
  });

  // ---------- transaction dialog ----------
  const txDialog = $('#tx-dialog');
  const txForm = $('#tx-form');
  let txCtx = null; // { holdingId, type, id }

  function setTxType(type) {
    txCtx.type = type;
    document.querySelectorAll('#tx-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
    document.querySelectorAll('#tx-form .tx-trade').forEach((el) => { el.hidden = type === 'income'; });
    document.querySelectorAll('#tx-form .tx-income').forEach((el) => { el.hidden = type !== 'income'; });
    const h = state.holdings.find((x) => x.id === txCtx.holdingId);
    if (h && h.priceSource === 'cash') {
      txForm.querySelector('[name=price]').closest('label').hidden = true;
    }
    updateTxTotal();
  }

  function openTxDialog(holdingId, type, tx) {
    const h = state.holdings.find((x) => x.id === holdingId);
    if (!h) return;
    txForm.reset();
    txCtx = { holdingId, type: tx ? tx.type : type, id: tx ? tx.id : null };
    $('#tx-errors').textContent = '';
    $('#tx-title').textContent = `${tx ? 'Edit' : 'Record'} transaction — ${h.name}`;
    const pos = P.position(h);
    $('#tx-holding-info').textContent = `You hold ${fmt.qty(pos.quantity)} ${h.unit}` +
      (pos.quantity ? ` · average cost ${fmt.price(pos.avgCost, h.currency)}` : '') +
      (h.currentPrice ? ` · current price ${fmt.price(h.currentPrice, h.currency)}` : '');
    document.querySelectorAll('#tx-form .cur-label').forEach((el) => { el.textContent = `(${h.currency})`; });
    txForm.date.value = tx ? tx.date : today();
    if (tx) {
      txForm.quantity.value = tx.quantity || '';
      txForm.price.value = tx.price || '';
      txForm.amount.value = tx.amount || '';
      txForm.fees.value = tx.fees || '';
      txForm.note.value = tx.note;
    } else {
      if (h.priceSource === 'cash') txForm.price.value = 1;
      else if (h.currentPrice) txForm.price.value = +h.currentPrice.toPrecision(8);
      if (type === 'sell' && pos.quantity) txForm.quantity.placeholder = `max ${fmt.qty(pos.quantity)}`;
    }
    setTxType(txCtx.type);
    txDialog.showModal();
    (txCtx.type === 'income' ? txForm.amount : txForm.quantity).focus();
  }

  function readTx() {
    const d = Object.fromEntries(new FormData(txForm));
    return P.normalizeTransaction({ ...d, id: txCtx.id || undefined, type: txCtx.type, updatedAt: nowISO() });
  }

  function updateTxTotal() {
    if (!txCtx) return;
    const h = state.holdings.find((x) => x.id === txCtx.holdingId);
    const t = readTx();
    const total = t.type === 'income' ? t.amount - t.fees
      : t.type === 'buy' ? t.quantity * t.price + t.fees : t.quantity * t.price - t.fees;
    let text = total ? `${t.type === 'buy' ? 'Total cost' : t.type === 'sell' ? 'Proceeds after fees' : 'Net income'}: ${fmt.money(total, h.currency)}` : '';
    if (t.type === 'sell' && t.quantity > 0) {
      const pos = P.position({ transactions: h.transactions.filter((x) => x.id !== t.id) });
      if (pos.quantity > 0) {
        const gain = t.quantity * t.price - t.fees - pos.avgCost * Math.min(t.quantity, pos.quantity);
        text += ` · realized gain ${fmt.signedMoney(gain, h.currency)}`;
      }
    }
    $('#tx-total').textContent = text;
  }

  $('#tx-type').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (b) setTxType(b.dataset.type);
  });
  txForm.addEventListener('input', updateTxTotal);
  txForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const h = state.holdings.find((x) => x.id === txCtx.holdingId);
    const tx = readTx();
    const errors = P.validateTransaction(tx, h);
    if (errors.length) { $('#tx-errors').textContent = errors.join(' '); return; }
    h.transactions = txCtx.id ? h.transactions.map((x) => (x.id === tx.id ? tx : x)) : [...h.transactions, tx];
    // A manual holding's latest trade price is the best valuation we have.
    if (h.priceSource === 'manual' && tx.type !== 'income' && tx.date >= (h.priceUpdatedAt || '').slice(0, 10)) {
      h.currentPrice = tx.price;
      h.priceUpdatedAt = nowISO();
    }
    if (h.priceSource === 'manual' && tx.type !== 'income' && tx.price > 0) {
      h.valuations = P.addValuation(h, tx.date, tx.price);
    }
    touch(h);
    commit();
    txDialog.close();
    render();
  });

  // ---------- settings dialog ----------
  const settingsDialog = $('#settings-dialog');
  const settingsForm = $('#settings-form');

  function openSettings() {
    fillCurrencySelect(settingsForm.baseCurrency, base());
    settingsForm.theme.value = state.device.theme || 'system';
    settingsForm.autoRefresh.checked = !!state.device.autoRefresh;
    settingsForm.syncToken.value = state.device.syncToken || '';
    settingsForm.syncKeys.checked = !!state.device.syncKeys;
    for (const k of Object.keys(state.keys)) settingsForm['key_' + k].value = state.keys[k] || '';
    renderSyncStatus();
    settingsDialog.showModal();
  }

  function readSettings() {
    const prevKeys = JSON.stringify(state.keys);
    const prevBase = base();
    for (const k of Object.keys(state.keys)) state.keys[k] = settingsForm['key_' + k].value.trim();
    const baseChanged = settingsForm.baseCurrency.value !== prevBase;
    const keysChanged = JSON.stringify(state.keys) !== prevKeys;
    if (baseChanged || (keysChanged && settingsForm.syncKeys.checked)) {
      state.shared = { ...state.shared, baseCurrency: settingsForm.baseCurrency.value, updatedAt: nowISO() };
    }
    const tokenChanged = settingsForm.syncToken.value.trim() !== state.device.syncToken;
    state.device = {
      ...state.device,
      theme: settingsForm.theme.value,
      autoRefresh: settingsForm.autoRefresh.checked,
      syncKeys: settingsForm.syncKeys.checked,
      syncToken: settingsForm.syncToken.value.trim(),
    };
    if (tokenChanged) { state.device.gistId = ''; state.device.lastSync = null; syncError = null; }
    return { keysChanged, baseChanged, tokenChanged };
  }

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { keysChanged, tokenChanged } = readSettings();
    applyTheme();
    commit();
    settingsDialog.close();
    render();
    if (tokenChanged && state.device.syncToken) runSync();
    if (keysChanged) refreshPrices();
  });

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  settingsDialog.addEventListener('click', async (e) => {
    const action = e.target.dataset && e.target.dataset.action;
    if (action === 'export-json') {
      // API keys stay out of backups so the file is safe to store or share.
      download(`investments-${today()}.json`, JSON.stringify(buildDoc({ includeKeys: false }), null, 2), 'application/json');
    } else if (action === 'export-csv') {
      download(`holdings-${today()}.csv`, P.holdingsCSV(state.holdings, convert, base()), 'text/csv');
    } else if (action === 'export-tx-csv') {
      download(`transactions-${today()}.csv`, P.transactionsCSV(state.holdings), 'text/csv');
    } else if (action === 'import-json') {
      $('#import-file').click();
    } else if (action === 'sync-now') {
      readSettings();
      persist();
      if (!state.device.syncToken) { $('#sync-info').textContent = 'Paste a GitHub token first.'; return; }
      $('#sync-info').textContent = 'Syncing…';
      await runSync();
      renderSyncStatus();
    } else if (action === 'sync-off') {
      state.device = { ...state.device, syncToken: '', gistId: '', lastSync: null };
      settingsForm.syncToken.value = '';
      syncError = null;
      persist();
      renderSyncStatus();
    } else if (action === 'reset') {
      if (confirm('Delete every holding and all value history? If sync is on, this also clears them on your other devices.')) {
        const at = nowISO();
        for (const h of state.holdings) state.deleted[h.id] = at;
        state.holdings = [];
        state.snapshots = [];
        state.lastRefresh = null;
        commit();
        settingsDialog.close();
        render();
      }
    }
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { holdings, snapshots, skipped } = P.parseBackup(await file.text());
      const replace = !state.holdings.length ||
        confirm(`Replace your current ${state.holdings.length} holdings with the ${holdings.length} in this file?\n\nChoose Cancel to add them alongside your existing holdings instead.`);
      if (replace) {
        const incoming = new Set(holdings.map((h) => h.id));
        const at = nowISO();
        for (const h of state.holdings) if (!incoming.has(h.id)) state.deleted[h.id] = at;
        state.holdings = holdings.map(touch);
        state.snapshots = snapshots;
      } else {
        const ids = new Set(state.holdings.map((h) => h.id));
        state.holdings = [...state.holdings, ...holdings.filter((h) => !ids.has(h.id)).map(touch)];
      }
      for (const h of state.holdings) delete state.deleted[h.id];
      commit();
      settingsDialog.close();
      render();
      alert(`Imported ${holdings.length} holding${holdings.length === 1 ? '' : 's'}` + (skipped ? ` (${skipped} invalid skipped).` : '.'));
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  });

  // ---------- sample data ----------
  async function loadSample() {
    state.holdings = P.sampleHoldings();
    state.snapshots = [];
    await refreshRates(false);
    commit();
    render();
    refreshHistories();
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-close]');
    if (!t) return;
    if (t.matches('[data-close]')) t.closest('dialog').close();
    const d = t.dataset;
    if (d.action === 'add') openHoldingDialog();
    if (d.action === 'sample') loadSample();
    if (d.action === 'settings') openSettings();
    if (d.details) openDetails(d.details);
    if (d.quickTx) openTxDialog(d.id, d.quickTx);
  });

  $('#btn-add').addEventListener('click', () => openHoldingDialog());
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-refresh').addEventListener('click', () => refreshPrices());
  $('#sync-status').addEventListener('click', () => runSync());
  $('#search').addEventListener('input', (e) => { state.ui.search = e.target.value; render(); });
  $('#filter-category').addEventListener('change', (e) => { state.ui.category = e.target.value; render(); });
  $('#show-closed').addEventListener('change', (e) => { state.ui.showClosed = e.target.checked; render(); });
  document.querySelectorAll('.holdings th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    state.ui.asc = state.ui.sort === k ? !state.ui.asc : k === 'name' || k === 'category';
    state.ui.sort = k;
    render();
  }));
  $('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    state.ui.range = b.dataset.range;
    persist();
    renderPerformance();
  });
  $('#chart-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.ui.mode = b.dataset.mode;
    persist();
    renderPerformance();
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPerformanceSafe, 150);
  });
  // Pull changes from other devices whenever the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.device.syncToken) runSync();
  });
  window.addEventListener('online', () => { if (state.device.syncToken) runSync(); });

  // ---------- boot ----------
  fillStaticOptions();
  load();
  applyTheme();
  render();
  (async () => {
    if (state.device.syncToken) await runSync();
    const stale = !state.lastRefresh || Date.now() - Date.parse(state.lastRefresh) > AUTO_REFRESH_MS;
    if (state.device.autoRefresh && stale && state.holdings.length) await refreshPrices();
    else {
      await refreshRates(false);
      if (state.holdings.length) { commit(); render(); }
      refreshHistories();
    }
  })();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }
})();
