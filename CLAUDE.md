# Investment Tracker

A personal, all-in-one investment tracker that runs in the browser. It covers stocks, ETFs, crypto, metals,
trading cards and other collectibles, property, bonds and cash in any currency. It installs as a phone app
(PWA), works offline, and syncs between devices through a private GitHub Gist. It's live on GitHub Pages at
https://merijin.github.io/Investment-tracker/.

## Ground rules

- **No build step, no framework, no dependencies.** Plain HTML/CSS/JS loaded with classic `<script>` tags, in
  the order set in `index.html`: `version → portfolio → prices → sync → charts → app`. Keep it that way
  unless the owner asks otherwise.
- **Everything runs client-side.** The only server code is the optional Cloudflare Worker in `server/`, for
  sources that need secret keys.
- **Never commit API keys or tokens.** The owner has a TCG API key, and keys belong in the app's Settings
  (stored in the browser). Before every commit, check that no `tcg_live_`, `ghp_` or similar strings are in
  the repo.
- **No web scraping.** Use official APIs within their terms. This was a deliberate decision: eBay and
  realestate.com.au/Domain forbid scraping.
- The owner prefers plain-language explanations and wants changes tested before they ship.

## Files

| File | What it holds |
|---|---|
| `js/version.js` | `self.APP_VERSION`. **Bump it on every release** (see Releasing). |
| `js/portfolio.js` | Pure model, no DOM or network: categories, price-source metadata (`SOURCES`), holding/transaction/portfolio normalisation, average-cost `position()`, FX `makeConverter()`, `summarize()`, history rebuild (`buildHistory`, `priceModel`), time-weighted `performance()`, CSV, backup parsing, sample data. |
| `js/prices.js` | Price providers (`PROVIDERS`), batched `refreshAll()`, FX `fetchRates()`, `search()`, `test()` (for the eBay/property Test button), `fetchHistory()`. `fetch` is injectable for tests. |
| `js/sync.js` | GitHub Gist sync: `mergeDocs()` (merge rules below) and `syncOnce()`. |
| `js/charts.js` | Dependency-free SVG charts: allocation bars and the performance line (value / return %). |
| `js/app.js` | UI: state, localStorage persistence, rendering, dialogs, sync scheduling, service worker registration. |
| `css/styles.css` | Theme tokens for light, dark and **retro (the default)**, plus phone layouts. |
| `sw.js` | Service worker: network-first for app files (4 s timeout, then the saved copy), cache-first for fonts. |
| `server/worker.js` | Cloudflare Worker "price server": eBay, PriceCharting, property (Domain AU / UK HPI), TCG API relay. |
| `scripts/check-tcgapi.js` | Checks the live TCG API against the parser: `TCGAPI_KEY=... node scripts/check-tcgapi.js`. |

`js/portfolio.js`, `js/prices.js` and `js/sync.js` use a UMD wrapper, so they work in the browser as globals
(`Portfolio`, `Prices`, `Sync`) and in Node via `require`. `server/worker.js` is an ES module.

## Data model

- **Holding:** `{ id, portfolioId, name, category, subcategory, currency, unit, priceSource, priceKey,
  priceOption, priceMethod, pricePath, currentPrice, priceUpdatedAt, priceError, notes, transactions[],
  valuations[], createdAt, updatedAt }`.
  - Quantity and cost are **derived** from transactions and never stored.
  - Prices and transactions are in the holding's own currency. Totals are converted to the base currency.
- **Transaction:** `{ id, type: buy|sell|income, date, quantity, price, fees, amount, note, updatedAt }`.
  Selling more than was held on that date is rejected.
- **Portfolio:** `{ id, name, updatedAt }`.
  - Older data belongs to `P.DEFAULT_PORTFOLIO` (`p_default`).
  - `updatedAt: ''` marks an automatic placeholder, which always loses to a real name when syncing.
- Ids are written into HTML attributes, so `normalize*` replaces anything that isn't `[A-Za-z0-9_-]`.
  Always normalise imported or synced data, and escape user text with `escapeHTML` before using `innerHTML`.
- localStorage key `investment-tracker:v1` holds `{ version: 2, holdings, portfolios, deleted, snapshots,
  shared, keys, device, rates, histories, ui }`. Old v1 data is migrated on load.

## Sync merge rules (`js/sync.js`)

- Holdings are merged by id: the newer `updatedAt` wins for details, the newer `priceUpdatedAt` wins for the
  price fields.
- Transactions are merged by id inside each holding.
- Deletions are tombstones in `deleted` (`{ id: time }`, expiring after a year).
- **Price refreshes must not bump `updatedAt`**, or a refresh on one device would overwrite edits made on
  another.
- A portfolio is kept while any holding still points at it.

## Price sources

- **No key:** CoinGecko (crypto), gold-api.com (metals, with PAXG/KAG token fallback), Pokémon TCG, Scryfall,
  YGOPRODeck, and FX from the fawazahmed0 currency API with open.er-api.com as fallback.
- **Free key, entered in Settings:** TCG API (tcgapi.dev, the default for cards; 100 requests/day, so it's
  refreshed at most every 6 h), Finnhub, Twelve Data, Alpha Vantage.
- **Through the price server:** eBay, PriceCharting (paid), Domain (AU property), UK HPI, and the TCG API
  relay.
- Quotes in pence or cents (GBp/GBX, ZAc, ILA) are converted to the main currency unit.
- **Not yet verified against live APIs:** the build sandbox blocked outside hosts, so providers are tested
  only against mocked responses. TCG API's response shape was inferred from its docs, and the parser accepts
  both documented shapes. If a live source misbehaves, fix the parser and add a test with the real response.

## Testing

- `npm test` runs `node --test` (68 tests). It covers the model, every provider, the sync merge, a fake
  GitHub round trip, and the worker routes.
- For UI changes, drive the real page with Playwright (Chromium is at `/opt/pw-browsers/chromium`):
  - serve with `python3 -m http.server`;
  - mock external APIs with `context.route()`;
  - check desktop (1280) and phone (390, `isMobile`) layouts, and that there are no page errors.
- CI (`.github/workflows/ci.yml`) runs the tests on every push and PR.

## Releasing

1. Bump `self.APP_VERSION` in `js/version.js`, and `version` in `package.json`. The service worker URL
   includes the version, so installed apps pick up the release on their next load.
2. Open a PR into `main`. Merging deploys GitHub Pages (`.github/workflows/pages.yml`, which copies
   `index.html manifest.webmanifest sw.js css js icons`).
3. If you add a new top-level file the app needs, add it to that copy step and to `SHELL` in `sw.js`.

## Gotchas

- An element with a `display` rule ignores the `hidden` attribute. There's a global
  `[hidden] { display: none !important; }`, so don't remove it.
- Absolutely positioned content inside a scroll container needs `position: relative` on the container, or
  phones zoom out (this happened once with the table's screen-reader label).
- The retro theme uses Google Fonts (IBM Plex Mono, VT323). Size text so the fallback monospace font still
  fits.
- Chart colours come from the `--series-N` tokens. They're validated for contrast and colour-blind
  separation, so re-validate before changing them.
