# Investment Tracker

An all-in-one tracker for everything you invest in: stocks, ETFs, crypto, gold and silver,
Pokémon cards and other collectibles, watches, property, bonds, cash, and anything else that has a value.

It's a static web app with no build step, no server and no account. Your data stays in your
browser's local storage. Export a JSON backup to move it between devices.

## Features

- **9 asset classes:** Stocks, ETFs & funds, Crypto, Precious metals, Collectibles, Real estate,
  Bonds, Cash & savings, and Other. A free-text "type / details" field lets you label each
  holding (Pokémon card, PSA 10, Watch, Rental property…).
- **Live prices** where free public data exists:
  | Asset | Source | Setup |
  |---|---|---|
  | Crypto | [CoinGecko](https://www.coingecko.com/) (coin id, e.g. `bitcoin`) | none |
  | Gold, silver, platinum, palladium | [gold-api.com](https://gold-api.com/) spot, per troy oz; gold falls back to PAX Gold | none |
  | Stocks & ETFs | [Finnhub](https://finnhub.io/) quote (ticker, e.g. `AAPL`) | free API key in Settings |
  | Pokémon cards | [Pokémon TCG API](https://pokemontcg.io/) TCGplayer market price (card id, e.g. `base1-4`) | none (optional key) |
  | Everything else | Manual valuation you update whenever you like | none |
- Metals can be entered in `ozt`, `g` or `kg`. The spot price is converted for you.
- Pokémon prices use the print variant named in "type / details" (e.g. *Reverse Holofoil*),
  or the highest-priced variant otherwise.
- A dashboard with total value, amount invested, gain/loss, allocation by asset class, and a
  value-over-time chart built from a daily snapshot.
- A holdings table you can sort, search and filter.
- JSON backup and restore, plus CSV export for spreadsheets. API keys are never included in exports.
- Light and dark themes, and it works on phones.

## Run it

Any static file server works:

```bash
npm start            # python3 -m http.server 8000
# then open http://localhost:8000
```

You can also deploy it free to GitHub Pages, Netlify or Vercel as-is.

## Tests

```bash
npm test             # node --test, Node 18+
```

The model and calculations (`js/portfolio.js`) and the price providers (`js/prices.js`) are
covered by unit tests. The provider tests use a mocked `fetch`.

## Project layout

```
index.html          UI shell and dialogs
css/styles.css      Styles and light/dark theme tokens
js/portfolio.js     Pure model: categories, validation, totals, snapshots, CSV/backup
js/prices.js        Live price providers + batched refresh
js/charts.js        Dependency-free SVG/HTML charts
js/app.js           State, persistence, rendering and events
test/               node:test unit tests
```

## Limitations and ideas

- All values are in USD. Multi-currency support would need an FX rate source.
- Each holding is one position. To track separate buys of the same asset, add a holding per lot.
  Full buy/sell transaction history would be a natural next step.
- Data lives in one browser. Cloud sync (e.g. Supabase or Firebase) would be the next step for multi-device use.
- More collectible price sources could be added in `js/prices.js`: sports cards, MTG via Scryfall, sneakers, watches.
