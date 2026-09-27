#!/usr/bin/env node
/*
 * Checks the live TCG API against the app's parser.
 *
 *   TCGAPI_KEY=tcg_live_... node scripts/check-tcgapi.js [search words]
 *
 * Uses 3 of your 100 free daily requests: a search, one card, and its history.
 * The key is read from the environment and never written anywhere.
 */
const P = require('../js/portfolio.js');
const Prices = require('../js/prices.js');

const key = process.env.TCGAPI_KEY;
if (!key) {
  console.error('Set TCGAPI_KEY first, e.g.  TCGAPI_KEY=tcg_live_... node scripts/check-tcgapi.js charizard');
  process.exit(1);
}
const query = process.argv.slice(2).join(' ') || 'charizard';
const settings = { keys: { tcgapi: key } };

// Log the raw response shape (first item only) so format changes are easy to spot.
const fetchFn = async (url, opts) => {
  const res = await fetch(url, opts);
  const text = await res.text();
  console.log(`\n${res.status} ${url.replace(/\?.*/, '')}`);
  console.log(text.length > 1200 ? text.slice(0, 1200) + ' …' : text);
  return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
};

(async () => {
  let ok = true;
  const results = await Prices.search('tcgapi', query, { fetchFn, settings });
  console.log(`\n→ Search parsed ${results.length} result(s).`, results[0] || '');
  if (!results.length) { console.log('✗ No results parsed.'); process.exit(1); }

  const holding = P.normalizeHolding({ name: results[0].name, category: 'collectible', priceSource: 'tcgapi', priceKey: results[0].key,
    transactions: [{ type: 'buy', date: '2025-01-01', quantity: 1, price: 1 }] });
  const [priced] = await Prices.refreshAll([holding], { fetchFn, settings });
  if (priced.priceError) { ok = false; console.log(`✗ Price: ${priced.priceError}`); }
  else console.log(`\n✓ Price parsed: $${priced.currentPrice}`);

  try {
    const hist = await Prices.fetchHistory(holding, { fetchFn, settings });
    console.log(hist && hist.length ? `✓ History parsed: ${hist.length} points, ${hist[0].date} → ${hist[hist.length - 1].date}`
      : '• No history returned (may not be included in your plan).');
  } catch (err) {
    console.log(`• History not available: ${err.message}`);
  }
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error('✗', err.message); process.exit(1); });
