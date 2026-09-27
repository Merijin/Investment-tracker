const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../js/sync.js');

const T = (n) => new Date(Date.UTC(2025, 0, 1, 0, n)).toISOString();
const NOW = Date.parse(T(1000));
const tx = (id, at, extra = {}) => ({ id, type: 'buy', date: '2025-01-01', quantity: 1, price: 1, fees: 0, updatedAt: at, ...extra });
const holding = (id, at, extra = {}) => ({ id, name: id, updatedAt: at, transactions: [], ...extra });
const doc = (o) => ({ savedAt: T(0), holdings: [], deleted: {}, snapshots: [], settings: { baseCurrency: 'USD', updatedAt: '' }, ...o });

test('union of holdings from both devices', () => {
  const m = Sync.mergeDocs(doc({ holdings: [holding('a', T(1))] }), doc({ holdings: [holding('b', T(2))] }), NOW);
  assert.deepEqual(m.holdings.map((h) => h.id).sort(), ['a', 'b']);
});

test('newer holding details win, prices merge by priceUpdatedAt', () => {
  const phone = holding('a', T(5), { name: 'Renamed', currentPrice: 10, priceUpdatedAt: T(1) });
  const laptop = holding('a', T(2), { name: 'Old', currentPrice: 20, priceUpdatedAt: T(9) });
  const [m] = Sync.mergeDocs(doc({ holdings: [phone] }), doc({ holdings: [laptop] }), NOW).holdings;
  assert.equal(m.name, 'Renamed');
  assert.equal(m.currentPrice, 20);
  assert.equal(m.priceUpdatedAt, T(9));
});

test('transactions added on different devices are both kept', () => {
  const a = holding('h', T(3), { transactions: [tx('t1', T(1)), tx('t2', T(3))] });
  const b = holding('h', T(4), { transactions: [tx('t1', T(1)), tx('t3', T(4))] });
  const [m] = Sync.mergeDocs(doc({ holdings: [a] }), doc({ holdings: [b] }), NOW).holdings;
  assert.deepEqual(m.transactions.map((t) => t.id), ['t1', 't2', 't3']);
});

test('the newer edit of the same transaction wins', () => {
  const a = holding('h', T(3), { transactions: [tx('t1', T(3), { quantity: 5 })] });
  const b = holding('h', T(2), { transactions: [tx('t1', T(2), { quantity: 2 })] });
  const [m] = Sync.mergeDocs(doc({ holdings: [b] }), doc({ holdings: [a] }), NOW).holdings;
  assert.equal(m.transactions[0].quantity, 5);
});

test('deletions propagate but a later edit resurrects', () => {
  const remote = doc({ holdings: [holding('a', T(1)), holding('b', T(1), { transactions: [tx('t1', T(1)), tx('t2', T(1))] })] });
  const local = doc({ holdings: [holding('b', T(6), { transactions: [tx('t1', T(1))] })], deleted: { a: T(5), t2: T(6) } });
  const m = Sync.mergeDocs(local, remote, NOW);
  assert.deepEqual(m.holdings.map((h) => h.id), ['b']);
  assert.deepEqual(m.holdings[0].transactions.map((t) => t.id), ['t1']);

  const edited = doc({ holdings: [holding('a', T(7))] });
  assert.deepEqual(Sync.mergeDocs(local, edited, NOW).holdings.map((h) => h.id).sort(), ['a', 'b']);
});

test('old tombstones expire', () => {
  const d = Sync.mergeDeleted({ old: '2020-01-01T00:00:00.000Z', recent: T(1) }, {}, NOW);
  assert.deepEqual(Object.keys(d), ['recent']);
});

test('snapshots union by date, newer document wins the same day; settings newest wins', () => {
  const a = doc({ savedAt: T(1), snapshots: [{ date: '2025-01-01', value: 1 }, { date: '2025-01-02', value: 2 }],
    settings: { baseCurrency: 'EUR', updatedAt: T(8) } });
  const b = doc({ savedAt: T(9), snapshots: [{ date: '2025-01-02', value: 20 }, { date: '2025-01-03', value: 3 }],
    settings: { baseCurrency: 'GBP', updatedAt: T(2) } });
  const m = Sync.mergeDocs(a, b, NOW);
  assert.deepEqual(m.snapshots.map((s) => s.value), [1, 20, 3]);
  assert.equal(m.settings.baseCurrency, 'EUR');
  assert.equal(m.savedAt, T(9));
});

test('merge is order-independent for holdings', () => {
  const a = doc({ holdings: [holding('x', T(2), { transactions: [tx('1', T(1))] })], deleted: { y: T(3) } });
  const b = doc({ holdings: [holding('x', T(4), { transactions: [tx('2', T(4))] }), holding('y', T(1))] });
  const ab = Sync.mergeDocs(a, b, NOW);
  const ba = Sync.mergeDocs(b, a, NOW);
  const ids = (d) => d.holdings.map((h) => h.id + ':' + h.transactions.map((t) => t.id).sort().join(',')).sort();
  assert.deepEqual(ids(ab), ids(ba));
});

/** Minimal in-memory GitHub Gist API. */
function fakeGitHub() {
  const gists = new Map();
  let n = 0;
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || 'GET';
    calls.push(`${method} ${pathname}`);
    if (opts.headers.Authorization !== 'Bearer good') return res(401, {});
    if (method === 'GET' && pathname === '/gists') {
      return res(200, [...gists.entries()].map(([id, files]) => ({ id, files })));
    }
    if (method === 'POST' && pathname === '/gists') {
      const id = 'g' + ++n;
      gists.set(id, JSON.parse(opts.body).files);
      return res(201, { id });
    }
    const id = pathname.split('/')[2];
    if (!gists.has(id)) return res(404, {});
    if (method === 'PATCH') {
      Object.assign(gists.get(id), JSON.parse(opts.body).files);
      return res(200, { id });
    }
    return res(200, { id, files: gists.get(id) });
  };
  return { fetchFn, gists, calls };
}

test('syncOnce creates a gist, then a second device finds and merges it', async () => {
  const gh = fakeGitHub();
  const laptop = doc({ savedAt: T(1), holdings: [holding('a', T(1))] });
  const first = await Sync.syncOnce({ token: 'good', gistId: '', local: laptop, fetchFn: gh.fetchFn });
  assert.equal(first.gistId, 'g1');
  assert.ok(gh.calls.includes('POST /gists'));

  const phone = doc({ savedAt: T(2), holdings: [holding('b', T(2))] });
  const second = await Sync.syncOnce({ token: 'good', gistId: '', local: phone, fetchFn: gh.fetchFn });
  assert.equal(second.gistId, 'g1', 'phone discovers the existing gist');
  assert.deepEqual(second.doc.holdings.map((h) => h.id).sort(), ['a', 'b']);
  const stored = JSON.parse(gh.gists.get('g1')[Sync.FILE_NAME].content);
  assert.deepEqual(stored.holdings.map((h) => h.id).sort(), ['a', 'b']);
});

test('syncOnce recreates a deleted gist and reports bad tokens', async () => {
  const gh = fakeGitHub();
  const r = await Sync.syncOnce({ token: 'good', gistId: 'missing', local: doc({}), fetchFn: gh.fetchFn });
  assert.equal(r.gistId, 'g1');
  await assert.rejects(Sync.syncOnce({ token: 'bad', gistId: '', local: doc({}), fetchFn: gh.fetchFn }), /rejected the token/);
});
