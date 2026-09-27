# Price server

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that gives the app prices from
sources that need secret keys: eBay, PriceCharting, and area property prices. It runs on Cloudflare's
free plan (100,000 requests a day), and you don't have to maintain a server.

## What it adds

| Source | What you get | What it needs |
|---|---|---|
| **eBay** | Median price of matching eBay items, with outliers ignored. Works for cards, watches, sneakers, whisky, and so on. | A free [eBay developer](https://developer.ebay.com/) account: create a production keyset. |
| **eBay sold prices** | The same, using *sold* items like Collectr does. | eBay has to approve your app for the [Marketplace Insights API](https://developer.ebay.com/api-docs/buy/marketplace-insights/static/overview.html) (limited release). Until then, current listings are used. |
| **PriceCharting** | Sold-price guide by grade (ungraded, 7, 8, 9, 9.5, PSA/BGS/CGC/SGC 10) for Pokémon, sports cards, Magic, Yu-Gi-Oh!, comics, video games. | A PriceCharting subscription that includes [API access](https://www.pricecharting.com/api-documentation). This is paid. |
| **Australian property** | Median sold price for a suburb (house or unit), quarterly, going back 10 years. | A free [Domain developer](https://developer.domain.com.au/) API key. |
| **UK property** | HM Land Registry UK House Price Index: average price by region or council, by property type. | Nothing. It's open data. |

Nothing here scrapes websites. Every source is an official API used within its terms.

## Set it up (about 10 minutes)

```bash
cd server
npx wrangler login                        # free Cloudflare account
npx wrangler deploy                       # prints your worker's address

# Choose an access code so only your app can use your keys:
npx wrangler secret put APP_TOKEN

# Add whichever sources you want:
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler secret put PRICECHARTING_TOKEN
npx wrangler secret put DOMAIN_API_KEY
# After eBay approves Marketplace Insights:
npx wrangler secret put EBAY_SOLD         # enter: true
```

In the app, open **Settings → Price server**, paste the worker's address and your access code, and press
**Test connection**. It shows which sources are ready.

Optionally, set `ALLOWED_ORIGIN` in `wrangler.toml` to your app's address (for example
`https://you.github.io`) so browsers only allow your app to call the worker.

## Using it in the app

- **eBay:** choose *eBay — median of recent sales* as the price source. Type the search the way sellers
  title their listings, e.g. `charizard base set holo psa 9 -proxy -lot`, then press **Test** to see the
  matched items and the median. The app searches the eBay site that matches the holding's currency
  (AUD → eBay Australia, GBP → eBay UK, EUR → eBay Germany, CAD → eBay Canada, otherwise eBay US).
- **PriceCharting:** press **Find** to search by name, then pick the grade.
- **Property:** enter `Suburb, STATE postcode` for Australia (e.g. `Melbourne, VIC 3000`) or a region or
  council name for the UK (e.g. `Manchester`). Then choose how to value it:
  - **My price, grown with the area:** your purchase price × (area price now ÷ area price when you
    bought). This is usually the better estimate for your own home.
  - **The area median price:** shows the median itself.

  The area's price history also feeds the performance chart.

Results are cached on the worker (eBay 6 hours, PriceCharting 12 hours, property 1 day), which keeps
you well inside every free tier.

## Not covered

No official API provides valuations for art, wine, or US/other property by area, so those stay manual.
eBay comparable sales can still work for prints, limited editions and bottles.
