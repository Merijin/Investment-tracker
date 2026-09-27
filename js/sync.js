/*
 * Cloud sync through a private (secret) GitHub Gist. No server needed: each
 * device reads the gist, merges it with local data, and writes the result back.
 *
 * Merge rules (so two devices can edit offline without losing work):
 *  - holdings: union by id; the newer `updatedAt` wins for holding details,
 *    the newer `priceUpdatedAt` wins for price fields;
 *  - transactions: union by id inside each holding, newer `updatedAt` wins;
 *  - deletions: tombstones in `deleted` ({ id: deletedAt }) beat older edits;
 *  - snapshots: union by date, the newer document wins on the same day;
 *  - portfolios: union by id, the newer `updatedAt` wins (renames), tombstones delete;
 *  - settings: whole object from whichever side changed it last.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILE_NAME = 'investment-tracker.json';
  const TOMBSTONE_TTL_MS = 365 * 86400000;
  const PRICE_FIELDS = ['currentPrice', 'priceUpdatedAt', 'priceError'];

  const newer = (a, b) => ((a || '') >= (b || '') ? a : b);
  const ts = (x) => (x && x.updatedAt) || '';

  function mergeDeleted(a = {}, b = {}, now = Date.now()) {
    const out = {};
    for (const src of [a, b]) {
      for (const [id, at] of Object.entries(src)) {
        if (now - Date.parse(at) > TOMBSTONE_TTL_MS) continue;
        out[id] = newer(out[id], at);
      }
    }
    return out;
  }

  const alive = (item, deleted) => !(deleted[item.id] && deleted[item.id] >= ts(item));

  function mergeTransactions(a = [], b = [], deleted) {
    const map = new Map();
    for (const t of [...a, ...b]) {
      const prev = map.get(t.id);
      if (!prev || ts(t) > ts(prev)) map.set(t.id, t);
    }
    // Keep a's order, then anything only b has.
    const order = [...a, ...b].map((t) => t.id).filter((id, i, arr) => arr.indexOf(id) === i);
    return order.map((id) => map.get(id)).filter((t) => alive(t, deleted));
  }

  function mergeHolding(a, b, deleted) {
    const base = ts(a) >= ts(b) ? a : b;
    const priced = (a.priceUpdatedAt || '') >= (b.priceUpdatedAt || '') ? a : b;
    const merged = { ...base, transactions: mergeTransactions(a.transactions, b.transactions, deleted) };
    for (const f of PRICE_FIELDS) merged[f] = priced[f];
    return merged;
  }

  function mergeDocs(a, b, now = Date.now()) {
    if (!b) return a;
    if (!a) return b;
    const deleted = mergeDeleted(a.deleted, b.deleted, now);
    const byId = new Map();
    for (const h of a.holdings || []) byId.set(h.id, h);
    for (const h of b.holdings || []) byId.set(h.id, byId.has(h.id) ? mergeHolding(byId.get(h.id), h, deleted) : h);
    const holdings = [...byId.values()].filter((h) => alive(h, deleted));

    const [older, newerDoc] = (a.savedAt || '') >= (b.savedAt || '') ? [b, a] : [a, b];
    const snaps = new Map();
    for (const s of older.snapshots || []) snaps.set(s.date, s);
    for (const s of newerDoc.snapshots || []) snaps.set(s.date, s);
    const snapshots = [...snaps.values()].sort((x, y) => (x.date < y.date ? -1 : 1));

    const pmap = new Map();
    for (const p of [...(a.portfolios || []), ...(b.portfolios || [])]) {
      const prev = pmap.get(p.id);
      if (!prev || ts(p) > ts(prev)) pmap.set(p.id, p);
    }
    // A portfolio is kept while any holding still points at it.
    const used = new Set(holdings.map((h) => h.portfolioId));
    const portfolios = [...pmap.values()].filter((p) => used.has(p.id) || alive(p, deleted));

    const settings = ts(a.settings) >= ts(b.settings) ? a.settings : b.settings;
    return {
      app: 'investment-tracker',
      version: 2,
      savedAt: newer(a.savedAt, b.savedAt),
      holdings,
      portfolios,
      deleted,
      snapshots,
      settings,
    };
  }

  // ---------- GitHub Gist client ----------

  function client(token, fetchFn = globalThis.fetch.bind(globalThis)) {
    const call = async (path, { method = 'GET', body } = {}) => {
      const res = await fetchFn('https://api.github.com' + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) throw new Error('GitHub rejected the token — check it and that it has the "gist" scope.');
      if (res.status === 404) {
        const err = new Error('Sync gist not found.');
        err.status = 404;
        throw err;
      }
      if (!res.ok) throw new Error(`GitHub error ${res.status}`);
      return res.json();
    };

    async function readFile(gist) {
      const file = gist.files && gist.files[FILE_NAME];
      if (!file) return null;
      // Gists over ~1 MB come back truncated; the raw URL has the full content.
      const text = file.truncated ? await (await fetchFn(file.raw_url)).text() : file.content;
      return JSON.parse(text);
    }

    return {
      /** Find the tracker's gist among the user's gists (for a new device). */
      async find() {
        for (let page = 1; page <= 5; page++) {
          const list = await call(`/gists?per_page=100&page=${page}`);
          const hit = list.find((g) => g.files && g.files[FILE_NAME]);
          if (hit) return hit.id;
          if (list.length < 100) break;
        }
        return null;
      },
      async read(id) {
        return readFile(await call(`/gists/${id}`));
      },
      async create(doc) {
        const g = await call('/gists', {
          method: 'POST',
          body: { description: 'Investment Tracker data (synced)', public: false, files: { [FILE_NAME]: { content: JSON.stringify(doc) } } },
        });
        return g.id;
      },
      async write(id, doc) {
        await call(`/gists/${id}`, { method: 'PATCH', body: { files: { [FILE_NAME]: { content: JSON.stringify(doc) } } } });
      },
    };
  }

  /**
   * One sync round. Finds or creates the gist when needed.
   * Returns { doc, gistId } where doc is the merged document now stored in both places.
   */
  async function syncOnce({ token, gistId, local, fetchFn }) {
    const gh = client(token, fetchFn);
    let id = gistId || (await gh.find());
    let remote = null;
    if (id) {
      try {
        remote = await gh.read(id);
      } catch (err) {
        if (err.status !== 404) throw err;
        id = null; // gist was deleted; start a new one
      }
    }
    const doc = mergeDocs(local, remote);
    if (id) await gh.write(id, doc);
    else id = await gh.create(doc);
    return { doc, gistId: id };
  }

  return { FILE_NAME, mergeDocs, mergeDeleted, client, syncOnce };
});
