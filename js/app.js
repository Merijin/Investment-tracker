/* UI wiring: state, persistence, rendering and dialogs. */
(function () {
  'use strict';
  const P = window.Portfolio;
  const { renderAllocation, renderHistory, escapeHTML } = window.Charts;

  const STORAGE_KEY = 'investment-tracker:v1';
  const AUTO_REFRESH_MS = 10 * 60 * 1000;

  const SUBCATEGORY_HINTS = {
    stock: ['Common stock', 'Dividend stock', 'ADR'],
    etf: ['Index fund', 'Mutual fund', 'REIT', 'Bond ETF'],
    crypto: ['Coin', 'Stablecoin', 'Staked'],
    metal: ['Bullion coin', 'Bullion bar', 'Numismatic coin', 'Jewelry (scrap value)'],
    collectible: ['Pokémon card', 'Sports card', 'Magic: The Gathering card', 'Graded card (PSA 10)', 'Sealed product',
      'Watch', 'Sneakers', 'Art', 'Wine / whisky', 'Comics', 'LEGO', 'Coins & stamps', 'Vintage toys'],
    real_estate: ['Primary residence', 'Rental property', 'Land', 'REIT share'],
    bond: ['Government bond', 'Corporate bond', 'Treasury bill', 'CD'],
    cash: ['Savings account', 'Money market', 'Emergency fund'],
    other: ['Private equity', 'Business stake', 'Loan / note', 'Domain name'],
  };
  const UNIT_HINTS = {
    stock: ['shares'], etf: ['shares', 'units'], crypto: ['coins', 'tokens'], metal: ['ozt', 'g', 'kg'],
    collectible: ['items', 'cards', 'packs', 'boxes'], real_estate: ['units', 'properties'],
    bond: ['units', 'bonds'], cash: ['units'], other: ['units'],
  };

  // ---------- state & persistence ----------
  const state = {
    holdings: [],
    snapshots: [],
    settings: { finnhubKey: '', pokemonKey: '', theme: 'system', autoRefresh: true },
    lastRefresh: null,
    ui: { sort: 'value', asc: false, search: '', category: 'all', range: 0 },
  };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      state.holdings = (saved.holdings || []).map(P.normalizeHolding);
      state.snapshots = saved.snapshots || [];
      state.settings = { ...state.settings, ...(saved.settings || {}) };
      state.lastRefresh = saved.lastRefresh || null;
    } catch (err) {
      console.warn('Could not read saved data', err);
    }
  }

  function save() {
    const s = P.summarize(state.holdings);
    if (state.holdings.length) {
      state.snapshots = P.recordSnapshot(state.snapshots, new Date().toISOString(), s.value, s.cost);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1, holdings: state.holdings, snapshots: state.snapshots,
        settings: state.settings, lastRefresh: state.lastRefresh,
      }));
    } catch (err) {
      console.warn('Could not save data', err);
      setStatus('⚠ Could not save — browser storage is unavailable.');
    }
  }

  // ---------- formatting ----------
  const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const usd0 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  const fmt = {
    money: (n) => (Math.abs(n) >= 100000 ? usd0 : usd).format(n),
    price: (n) => (n !== 0 && Math.abs(n) < 1
      ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(n)
      : usd.format(n)),
    signedMoney: (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt.money(Math.abs(n)),
    pct: (n) => (n === null ? '—' : (n * 100).toFixed(Math.abs(n) < 0.1 ? 1 : 0) + '%'),
    signedPct: (n) => (n === null ? '' : (n > 0 ? '+' : n < 0 ? '−' : '') + (Math.abs(n) * 100).toFixed(1) + '%'),
    compact: (n) => compact.format(n),
    qty: (n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(n),
    shortDate: (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    longDate: (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    ago: (iso) => {
      if (!iso) return 'never';
      const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins} min ago`;
      if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
      return `${Math.round(mins / 1440)} d ago`;
    },
  };

  const $ = (sel) => document.querySelector(sel);
  const setStatus = (text) => { $('#refresh-status').textContent = text; };

  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  // ---------- rendering ----------
  function render() {
    const has = state.holdings.length > 0;
    $('#empty-state').hidden = has;
    $('#dashboard').hidden = !has;
    $('#btn-refresh').hidden = !has;
    if (!has) { setStatus(''); return; }

    const s = P.summarize(state.holdings);
    $('#stat-value').textContent = fmt.money(s.value);
    $('#stat-cost').textContent = fmt.money(s.cost);
    const gainEl = $('#stat-gain');
    gainEl.textContent = fmt.signedMoney(s.gain);
    gainEl.className = 'stat-value ' + (s.gain >= 0 ? 'gain' : 'loss');
    $('#stat-gain-pct').textContent = s.gainPct === null ? '' : fmt.signedPct(s.gainPct) + ' all time';
    $('#stat-count').textContent = s.count;
    $('#stat-classes').textContent = `across ${s.allocation.length} asset class${s.allocation.length === 1 ? '' : 'es'}`;

    renderAllocation($('#allocation'), s.allocation, fmt);
    renderHistory($('#history'), state.snapshots, state.ui.range, fmt);
    renderFilterOptions(s);
    renderTable(s);
    if (state.lastRefresh) setStatus(`Prices updated ${fmt.ago(state.lastRefresh)}`);
  }

  function renderFilterOptions(s) {
    const sel = $('#filter-category');
    const current = state.ui.category;
    sel.innerHTML = '<option value="all">All asset classes</option>' +
      s.allocation.map((a) => `<option value="${a.id}">${escapeHTML(a.label)} (${a.count})</option>`).join('');
    sel.value = s.allocation.some((a) => a.id === current) ? current : 'all';
    state.ui.category = sel.value;
  }

  function renderTable(summary) {
    const { sort, asc, search, category } = state.ui;
    const q = search.trim().toLowerCase();
    const rows = state.holdings
      .filter((h) => category === 'all' || h.category === category)
      .filter((h) => !q || [h.name, h.subcategory, h.priceKey, h.notes, P.categoryById(h.category).label]
        .some((f) => f && f.toLowerCase().includes(q)))
      .map((h) => ({ h, m: P.holdingMetrics(h) }));

    const key = {
      name: (r) => r.h.name.toLowerCase(),
      category: (r) => P.categoryById(r.h.category).label,
      quantity: (r) => r.h.quantity,
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
      const sourceNote = h.priceError
        ? `<div class="sub warn" title="${escapeHTML(h.priceError)}">⚠ ${escapeHTML(h.priceError)}</div>`
        : h.priceSource === 'manual'
          ? `<div class="sub">Manual · ${fmt.ago(h.priceUpdatedAt)}</div>`
          : `<div class="sub">${escapeHTML(h.priceKey)} · ${fmt.ago(h.priceUpdatedAt)}</div>`;
      const gainCls = m.gain >= 0 ? 'gain' : 'loss';
      return `<tr>
        <td><div class="name">${escapeHTML(h.name)}</div>
          ${h.subcategory ? `<div class="sub">${escapeHTML(h.subcategory)}</div>` : ''}</td>
        <td><span class="class-chip"><span class="swatch" style="background:var(--series-${cat.slot})"></span>${escapeHTML(cat.label)}</span></td>
        <td class="num">${fmt.qty(h.quantity)} <span class="muted">${escapeHTML(h.unit)}</span></td>
        <td class="num">${m.priced ? fmt.price(h.currentPrice) : '<span class="muted">—</span>'}${sourceNote}</td>
        <td class="num">${fmt.money(m.value)}<div class="sub">cost ${fmt.money(h.costBasis)}</div></td>
        <td class="num ${gainCls}">${fmt.signedMoney(m.gain)}<div class="sub ${gainCls}">${fmt.signedPct(m.gainPct)}</div></td>
        <td class="num">${fmt.pct(summary.value > 0 ? m.value / summary.value : 0)}</td>
        <td class="actions">
          <button class="link-btn" data-edit="${h.id}">Edit</button>
          <button class="link-btn" data-delete="${h.id}">Delete</button>
        </td>
      </tr>`;
    }).join('');
  }

  // ---------- price refresh ----------
  let refreshing = false;
  async function refreshPrices(onlyIds) {
    if (refreshing) return;
    const targets = state.holdings.filter((h) => h.priceSource !== 'manual' && (!onlyIds || onlyIds.includes(h.id)));
    if (!targets.length) {
      if (!onlyIds) setStatus('Nothing to refresh — all holdings use manual valuations.');
      return;
    }
    refreshing = true;
    const btn = $('#btn-refresh');
    btn.disabled = true;
    setStatus('Refreshing prices…');
    try {
      const updated = await window.Prices.refreshAll(targets, { settings: state.settings });
      const byId = new Map(updated.map((h) => [h.id, h]));
      state.holdings = state.holdings.map((h) => byId.get(h.id) || h);
      if (!onlyIds) state.lastRefresh = new Date().toISOString();
      save();
      render();
      const failed = updated.filter((h) => h.priceError).length;
      setStatus(failed
        ? `Updated ${updated.length - failed} of ${updated.length} prices · ${failed} failed (see table)`
        : `Prices updated ${fmt.ago(new Date().toISOString())}`);
    } catch (err) {
      setStatus('Refresh failed: ' + err.message);
    } finally {
      refreshing = false;
      btn.disabled = false;
    }
  }

  // ---------- add / edit dialog ----------
  const dialog = $('#holding-dialog');
  const form = $('#holding-form');

  function fillCategoryOptions() {
    form.category.innerHTML = P.CATEGORIES.map((c) => `<option value="${c.id}">${escapeHTML(c.label)}</option>`).join('');
    $('#price-key-metal').innerHTML = Object.entries(P.METALS)
      .map(([k, v]) => `<option value="${k}">${v} (${k})</option>`).join('');
  }

  function syncCategory(resetUnit) {
    const cat = P.categoryById(form.category.value);
    const prevSource = form.priceSource.value;
    form.priceSource.innerHTML = cat.sources.map((s) => `<option value="${s}">${escapeHTML(P.SOURCES[s].label)}</option>`).join('');
    form.priceSource.value = cat.sources.includes(prevSource) ? prevSource : cat.sources[0];
    $('#subcategory-list').innerHTML = SUBCATEGORY_HINTS[cat.id].map((s) => `<option value="${escapeHTML(s)}">`).join('');
    $('#unit-list').innerHTML = UNIT_HINTS[cat.id].map((u) => `<option value="${u}">`).join('');
    if (resetUnit) form.unit.value = cat.defaultUnit;
    syncSource();
  }

  function syncSource() {
    const src = form.priceSource.value;
    const info = P.SOURCES[src];
    const auto = src !== 'manual';
    $('#price-key-field').hidden = !auto;
    const isMetal = src === 'metal';
    $('#price-key-input').hidden = isMetal;
    $('#price-key-metal').hidden = !isMetal;
    $('#price-key-label').textContent = info.keyLabel || '';
    $('#price-key-hint').textContent = info.keyHint || '';
    if (isMetal && !P.METAL_UNITS[form.unit.value]) form.unit.value = 'ozt';
    form.currentPrice.placeholder = auto ? 'Leave blank to fetch automatically' : 'What is one unit worth today?';
    $('#current-price-hint').textContent = auto
      ? 'Fetched automatically; anything typed here is replaced on the next refresh.'
      : 'Update this whenever you get a new valuation (e.g. eBay sold listings, appraisal).';
  }

  function openHoldingDialog(holding) {
    form.reset();
    $('#form-errors').textContent = '';
    $('#holding-title').textContent = holding ? 'Edit investment' : 'Add investment';
    const h = holding || { category: 'stock', priceSource: 'finnhub' };
    form.id.value = h.id || '';
    form.category.value = h.category;
    form.priceSource.innerHTML = `<option value="${h.priceSource}"></option>`;
    form.priceSource.value = h.priceSource;
    syncCategory(!holding);
    for (const f of ['name', 'subcategory', 'quantity', 'unit', 'costBasis', 'purchaseDate', 'priceKey', 'notes']) {
      if (h[f] !== undefined && h[f] !== null) form[f].value = h[f];
    }
    if (h.priceSource === 'metal' && h.priceKey) form.priceKeyMetal.value = h.priceKey;
    form.currentPrice.value = h.currentPrice ?? '';
    syncSource();
    dialog.showModal();
    form.name.focus();
  }

  form.category.addEventListener('change', () => syncCategory(true));
  form.priceSource.addEventListener('change', syncSource);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (data.priceSource === 'metal') data.priceKey = data.priceKeyMetal;
    const existing = state.holdings.find((h) => h.id === data.id);
    const priceChanged = !existing || String(existing.currentPrice ?? '') !== data.currentPrice;
    const keyChanged = !existing || existing.priceKey !== data.priceKey.trim() || existing.priceSource !== data.priceSource
      || existing.unit !== data.unit.trim() || existing.subcategory !== data.subcategory.trim();
    const holding = P.normalizeHolding({
      ...(existing || {}),
      ...data,
      id: data.id || undefined,
      priceUpdatedAt: priceChanged && data.currentPrice !== '' ? new Date().toISOString() : existing && existing.priceUpdatedAt,
      priceError: null,
    });
    const errors = P.validateHolding(holding);
    if (errors.length) {
      $('#form-errors').textContent = errors.join(' ');
      return;
    }
    state.holdings = existing
      ? state.holdings.map((h) => (h.id === holding.id ? holding : h))
      : [...state.holdings, holding];
    save();
    render();
    dialog.close();
    const needsFetch = holding.priceSource !== 'manual' && (keyChanged || data.currentPrice === '');
    if (needsFetch) refreshPrices([holding.id]);
  });

  // ---------- settings dialog ----------
  const settingsDialog = $('#settings-dialog');
  const settingsForm = $('#settings-form');

  function openSettings() {
    settingsForm.finnhubKey.value = state.settings.finnhubKey || '';
    settingsForm.pokemonKey.value = state.settings.pokemonKey || '';
    settingsForm.theme.value = state.settings.theme || 'system';
    settingsForm.autoRefresh.checked = !!state.settings.autoRefresh;
    settingsDialog.showModal();
  }

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const hadKey = !!state.settings.finnhubKey;
    state.settings = {
      ...state.settings,
      finnhubKey: settingsForm.finnhubKey.value.trim(),
      pokemonKey: settingsForm.pokemonKey.value.trim(),
      theme: settingsForm.theme.value,
      autoRefresh: settingsForm.autoRefresh.checked,
    };
    applyTheme();
    save();
    settingsDialog.close();
    render();
    if (!hadKey && state.settings.finnhubKey) refreshPrices();
  });

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  settingsDialog.addEventListener('click', (e) => {
    const action = e.target.dataset && e.target.dataset.action;
    if (action === 'export-json') {
      // API keys stay out of backups so the file is safe to store or share.
      download(`investments-${today()}.json`,
        JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), holdings: state.holdings, snapshots: state.snapshots }, null, 2),
        'application/json');
    } else if (action === 'export-csv') {
      download(`investments-${today()}.csv`, P.toCSV(state.holdings), 'text/csv');
    } else if (action === 'import-json') {
      $('#import-file').click();
    } else if (action === 'reset') {
      if (confirm('Delete every holding and all value history from this browser? This cannot be undone.')) {
        state.holdings = [];
        state.snapshots = [];
        state.lastRefresh = null;
        save();
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
        state.holdings = holdings;
        state.snapshots = snapshots;
      } else {
        const ids = new Set(state.holdings.map((h) => h.id));
        state.holdings = [...state.holdings, ...holdings.filter((h) => !ids.has(h.id))];
      }
      save();
      settingsDialog.close();
      render();
      alert(`Imported ${holdings.length} holding${holdings.length === 1 ? '' : 's'}` + (skipped ? ` (${skipped} invalid skipped).` : '.'));
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  });

  // ---------- sample data ----------
  function loadSample() {
    state.holdings = P.sampleHoldings();
    // A gently rising illustrative history so the chart has something to show.
    const s = P.summarize(state.holdings);
    const days = 180;
    let snaps = [];
    let v = s.value * 0.82;
    for (let i = days; i >= 1; i--) {
      v += (s.value - v) / (i + 8) + (Math.sin(i / 6) + Math.cos(i / 17)) * s.value * 0.004;
      const d = new Date(Date.now() - i * 86400000).toISOString();
      snaps = P.recordSnapshot(snaps, d, v, s.cost);
    }
    state.snapshots = snaps;
    save();
    render();
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) t.closest('dialog').close();
    const action = t.dataset && t.dataset.action;
    if (action === 'add') openHoldingDialog();
    if (action === 'sample') loadSample();
    if (t.dataset && t.dataset.edit) openHoldingDialog(state.holdings.find((h) => h.id === t.dataset.edit));
    if (t.dataset && t.dataset.delete) {
      const h = state.holdings.find((x) => x.id === t.dataset.delete);
      if (h && confirm(`Delete "${h.name}"?`)) {
        state.holdings = state.holdings.filter((x) => x.id !== h.id);
        save();
        render();
      }
    }
  });

  $('#btn-add').addEventListener('click', () => openHoldingDialog());
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-refresh').addEventListener('click', () => refreshPrices());
  $('#search').addEventListener('input', (e) => { state.ui.search = e.target.value; render(); });
  $('#filter-category').addEventListener('change', (e) => { state.ui.category = e.target.value; render(); });
  document.querySelectorAll('.holdings th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    state.ui.asc = state.ui.sort === k ? !state.ui.asc : k === 'name' || k === 'category';
    state.ui.sort = k;
    render();
  }));
  $('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    state.ui.range = Number(b.dataset.range);
    document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('active', x === b));
    renderHistory($('#history'), state.snapshots, state.ui.range, fmt);
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.holdings.length) renderHistory($('#history'), state.snapshots, state.ui.range, fmt);
    }, 150);
  });

  // ---------- boot ----------
  fillCategoryOptions();
  load();
  applyTheme();
  if (state.holdings.length) save(); // record today's snapshot
  render();
  const stale = !state.lastRefresh || Date.now() - Date.parse(state.lastRefresh) > AUTO_REFRESH_MS;
  if (state.settings.autoRefresh && stale && state.holdings.length) refreshPrices();
})();
