# Odds Screen

An OddJam-style betting toolkit for NFL, NBA (including preseason) and NCAAB. It is a web app that runs entirely on your device, phone or desktop:

- **No server and no account.** Odds come straight from [The Odds API](https://the-odds-api.com/) using your own key.
- **Your data stays on the device.** The key and the odds history live in the browser's storage.
- **Installable.** On iPhone, open it in Safari and choose Share → **Add to Home Screen**. It then opens full screen, works offline from the last pull, and loads instantly.

## What's in it

- **Positive EV:** book prices that beat the fair price. The fair price is Pinnacle's price with the vig removed. When Pinnacle doesn't post that line, it's the average of the other books' no-vig prices: the book being bet is left out, books that share an odds feed (Bally Bet and betPARX) count once, and at least 3 independent books are required. A **Fair value** switch above the list picks the source: **Auto** (Pinnacle, else consensus), **Pinnacle** only, or **Consensus** only (Pinnacle counts as one of the books).
- **Odds Screen:** every book's line and price for main lines and player props, with movement arrows, line history, an **Open** column (the first line this device recorded, Pinnacle's when available) and an optional opener under each book's price. Tap any price to add that exact bet to a parlay.
- **Middles and Low Hold:** gaps between books on spreads, totals and props, and the lowest combined margin across books.
- **Parlays:** a slip priced at the book you choose, with each book's parlay odds compared. For same-game parlays it models how the legs move together (a Gaussian copula), shows the correlation needed to break even against a book's quote, and shows what each leg adds or costs. Also covers profit boosts, Kelly sizing and a parlay generator.
- **Credit guards:**
  - Main lines and props refresh separately. Each pull lets you choose its markets and books, and shows the cost first. Leaving out markets always saves credits; leaving out books only saves when it takes you under a multiple of 10, because The Odds API bills books in groups of 10.
  - A partial pull only replaces the markets it fetched. The rest keep showing their last pull.
  - Before paying, the app checks the free schedule endpoint, so a sport with no upcoming games costs nothing.
  - It won't start a refresh your remaining credits can't cover.
  - A multi-game props pull stops early when credits run low and keeps what it already pulled.
  - Every refresh shows its cost.

Odds history is kept for 14 days.

## Layout

| Path | What it is |
|---|---|
| `web/` | **The app**: static files, deployed to GitHub Pages |
| `web/js/engine/` | Pricing engine: EV, fair odds, middles, odds screen, parlays and copula, store, API client, refresh service |
| `web/js/router.js` | Answers the UI's `/api/...` requests on-device |
| `web/js/app.js`, `web/css/style.css` | User interface, phone-first with a desktop layout |
| `web/data/media.json` | Team logos and rosters for headshots (ESPN snapshot) |
| `oddscreen/` | The original Python engine and FastAPI server, kept as the reference implementation |
| `tests/web/` | JavaScript tests, including parity tests against the Python engine |
| `tests/` (`*.py`) | Python tests |
| `tools/` | `make_golden.py` (saves Python outputs for the parity tests) and `build_media.py` (refreshes logos and rosters) |

## Develop

```bash
cd web && python3 -m http.server 8800      # then open http://127.0.0.1:8800
npm test                                    # JavaScript engine tests (Node 20+)
.venv/bin/python tools/make_golden.py       # save Python outputs from data/odds.db, then npm test checks parity
.venv/bin/python -m pytest -q               # Python reference tests
.venv/bin/python tools/build_media.py       # refresh logos and rosters, then redeploy
```

The parity tests run the JavaScript engine on real snapshots and require every row of every tool to match the Python engine. They allow tiny numeric tolerances; the same-game copula gets a looser one because scipy's own integration is randomized.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml`: it runs the tests, then publishes `web/` to GitHub Pages. The API key is never in the repo; you enter it in the app's Settings, and it stays on that device.
