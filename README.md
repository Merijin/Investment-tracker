# Investment Tracker

An all-in-one tracker for everything you invest in: stocks, ETFs, crypto, gold and silver,
Pokémon / Magic / Yu-Gi-Oh! cards and other collectibles, watches, property, bonds, cash in any
currency, and anything else that has a value.

It's a static web app with no build step, no server and no account. It installs on your phone like
an app, works offline, and syncs between devices through a private GitHub Gist.

## Features

- **Buy / sell / income transactions.** Quantity, average cost, cost basis, realized gains and
  income (dividends, interest, staking) are all calculated from your transaction history using the
  average-cost method. You can't sell more than you held on a given date. Fully sold positions are
  kept and can be shown with "Show sold".
- **Every currency.** Each holding has its own currency, and totals and charts are shown in a base
  currency you choose (170+ fiat currencies, plus BTC or ETH). Exchange rates are refreshed
  automatically. London (pence), Johannesburg (cents) and Tel Aviv (agorot) quotes are converted to
  the main currency unit.
- **Live prices**, with a **Find** button that searches each source so you don't need to know IDs:

  | Asset | Source | Key needed |
  |---|---|---|
  | Crypto (thousands of coins) | [CoinGecko](https://www.coingecko.com/) | no |
  | Gold, silver, platinum, palladium | [gold-api.com](https://gold-api.com/) spot price, with PAXG / KAG token fallback | no |
  | US stocks & ETFs | [Finnhub](https://finnhub.io/) | free |
  | Global stocks, ETFs, funds (LSE, TSX, XETRA…) | [Twelve Data](https://twelvedata.com/) | free |
  | Stocks & ETFs (alternative) | [Alpha Vantage](https://www.alphavantage.co/) | free (25 calls/day) |
  | Pokémon cards | [Pokémon TCG API](https://pokemontcg.io/): TCGplayer, then Cardmarket | no |
  | Magic: The Gathering | [Scryfall](https://scryfall.com/): normal / foil / etched | no |
  | Yu-Gi-Oh! | [YGOPRODeck](https://ygoprodeck.com/): TCGplayer, Cardmarket, eBay | no |
  | Cash / savings | Balance in the account's currency | no |
  | Cards from 89+ games (Pokémon, Magic, Yu-Gi-Oh!, One Piece, Lorcana…) | [TCG API](https://tcgapi.dev/): TCGplayer market price by printing, plus weekly history | free (100 lookups/day) |
  | Cards, comics, games by grade | PriceCharting sold-price guide (via your price server) | paid PriceCharting API |
  | Anything sold on eBay (cards, watches, sneakers, whisky…) | eBay median of matching sold items or listings (via your price server) | free eBay developer keys |
  | Australian property | Domain suburb median sold price (via your price server) | free Domain key |
  | UK property | HM Land Registry House Price Index (via your price server) | no |
  | Anything else with a JSON API | Custom URL + JSON path | depends |
  | Watches, sneakers, art, wine, property, sports cards… | Manual valuation | no |

  eBay, PriceCharting and property prices need secret keys, so they run through a small free
  **price server** you deploy yourself (a Cloudflare Worker). See [server/README.md](server/README.md).
  Property can be valued as the area median, or as your purchase price grown by the area's price
  change. Art, wine and property outside Australia and the UK have no official valuation API, so
  they stay manual.
- **Cloud sync** between computer and phone through a private GitHub Gist. Changes merge
  per holding and per transaction, so edits made offline on two devices are both kept.
- **Installable app (PWA)**: add it to your home screen and it opens full-screen, even offline.
- **Performance chart.** Your portfolio's value is rebuilt for every day from your transactions
  and downloaded daily price history. It can show:
  - **Value**, with the amount invested as a dashed line.
  - **Return %**, a time-weighted return, so money you add or withdraw doesn't count as gain.

  Period chips show the % change for 1W, 1M, 3M, YTD, 1Y and all time, and tapping one sets the
  chart's range. Price history comes from:
  - **Crypto:** CoinGecko (last 365 days).
  - **Gold and silver:** PAXG and KAG tokens on CoinGecko.
  - **Stocks and ETFs:** Twelve Data or Alpha Vantage, if you've added a key. Finnhub's free tier
    has no history.

  Where no history exists (collectibles, manual items, older dates), values are estimated between
  your trade prices and dated manual valuations, and the chart says which holdings are estimated.
- A dashboard with total value, unrealized and realized gains, and allocation by asset class.
- A retro terminal look by default: phosphor-green text, pixel numerals and block-meter bars.
  Dark, light and match-system themes are available in Settings.
- A holdings table you can sort, search and filter. On phones it switches to a card layout.
- JSON backup and restore, plus CSV export of holdings and of all transactions. API keys are
  never written to backups.

## Use it on your phone

1. **Publish it.** In the GitHub repo, go to *Settings → Pages → Build and deployment → Source* and
   choose **GitHub Actions**. Every push to `main` then deploys to
   `https://<your-username>.github.io/Investment-tracker/`. Any static host (Netlify, Vercel,
   Cloudflare Pages) works too.
2. **Install it.** Open that URL on your phone.
   - iPhone (Safari): Share → *Add to Home Screen*.
   - Android (Chrome): menu → *Install app*.
3. **Turn on sync.** Create a GitHub token at
   [github.com/settings/tokens](https://github.com/settings/tokens/new?scopes=gist&description=Investment%20Tracker)
   with only the **gist** scope. Paste it into *Settings → Cloud sync* on each device. The first
   device creates a secret gist named `investment-tracker.json`, and other devices find it
   automatically.

Sync runs when the app opens, a few seconds after each change, and whenever you switch back to the
app. Your API keys are only synced if you tick "Also sync my price API keys".

> **Privacy:** A secret gist isn't listed publicly, but anyone who has its URL can read it. Keep
> your token private: it can read and write your gists.

## Run locally

```bash
npm start            # python3 -m http.server 8000
# then open http://localhost:8000
```

## Check the live TCG API

```bash
TCGAPI_KEY=tcg_live_... node scripts/check-tcgapi.js charizard
```

This makes a search, a price lookup and a history lookup (3 of your 100 free daily requests). It prints the
raw responses and whether the app understood them.

## Tests

```bash
npm test             # node --test, Node 18+
```

Unit tests cover the transaction accounting, currency conversion, every price provider and search
(against mocked responses), and the sync merge rules. They also run a two-device sync against a
fake GitHub API. CI runs them on every push.

## Project layout

```
index.html            UI shell and dialogs
css/styles.css        Styles, light/dark theme tokens, phone layout
js/portfolio.js       Pure model: holdings, transactions, average cost, FX conversion, CSV/backup
js/prices.js          Price providers, exchange rates, symbol/card search
js/sync.js            GitHub Gist sync and the merge rules
js/charts.js          Dependency-free SVG/HTML charts
server/worker.js      Price server (Cloudflare Worker): eBay, PriceCharting, property
js/app.js             State, persistence, rendering and events
sw.js                 Service worker (offline app shell)
manifest.webmanifest  PWA manifest
test/                 node:test unit tests
```

## Why JavaScript (not Python)?

The app has to run on a phone. JavaScript runs directly in the phone's browser, installs to the
home screen and works offline, all with no server to host or pay for. A Python version would need
a hosted backend just to show the same screens. Python would only pay off for heavy
number-crunching, which a portfolio tracker doesn't need.

## Limitations and ideas

- Cost basis uses the average-cost method. FIFO/LIFO tax lots could be added as an option.
- Realized gains from foreign-currency holdings, and past prices in the performance chart, are
  converted at today's exchange rate rather than the historical rate.
- Free API tiers have rate limits. Crypto is fetched in a single batched request to stay under
  CoinGecko's limit.
