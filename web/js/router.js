// In-app replacement for the FastAPI routes (oddscreen/app.py): same paths,
// same JSON, but computed on-device from the local store. The UI calls
// api("/api/...") exactly as it did against the Python server.

import {
  DEFAULT_BOOKS, MAIN_MARKETS, PROP_MARKETS, REFERENCE_BOOK, SPORTS, BOOK_COLORS, BOOK_TITLES, SOURCE_TITLES,
  bookTitle, isProp, marketTitle, propsCostPerEvent, refreshCost, withReference,
} from "./engine/config.js";
import { fairDetail } from "./engine/fair.js";
import { groupPrices, isMoneyline, isSpread, lineKeyString } from "./engine/models.js";
import { findEv } from "./engine/ev.js";
import { findLowHold, findMiddles } from "./engine/middles.js";
import { DEVIG_METHODS, americanToDecimal } from "./engine/odds_math.js";
import { OddsAPIClient, OddsAPIError } from "./engine/oddsapi.js";
import { ParlayError, analyze, generate, pairKey, priceLegs } from "./engine/parlay.js";
import { buildPropScreen, buildScreen, propsSummary } from "./engine/screen.js";
import { RefreshRefused, propsPlan, refreshProps, refreshSport } from "./engine/service.js";
import { priceKey } from "./engine/store.js";

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

const KINDS = new Set(["all", "main", "props"]);

export class LocalApi {
  /** settings(): {apiKey, books} -- books is the fetch list (reference book added automatically) */
  constructor({ store, media, settings, fetchImpl }) {
    this.store = store;
    this.media = media;
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  books() {
    return withReference(this.settings().books?.length ? this.settings().books : DEFAULT_BOOKS);
  }

  client() {
    return new OddsAPIClient(this.settings().apiKey, this.fetchImpl);
  }

  sport(s) {
    if (!(s in SPORTS)) throw new ApiError(404, `unknown sport '${s}'`);
    return s;
  }

  bettable(param) {
    const chosen = param ? new Set(param.split(",")) : new Set(this.books());
    chosen.delete(REFERENCE_BOOK);
    return chosen;
  }

  method(m = "power") {
    if (!(m in DEVIG_METHODS)) throw new ApiError(400, `method must be one of ${Object.keys(DEVIG_METHODS).sort()}`);
    return m;
  }

  fairMode(m = "auto") {
    if (!["auto", "pinnacle", "consensus"].includes(m)) throw new ApiError(400, "fair must be auto, pinnacle or consensus");
    return m;
  }

  kind(k = "all") {
    if (!KINDS.has(k)) throw new ApiError(400, "kind must be all, main or props");
    return k;
  }

  snapshot(sport, kind = "all") {
    const { fetch, events, prices } = this.store.snapshot(this.sport(sport));
    const filtered = kind === "all" ? prices : prices.filter((p) => isProp(p.market) === (kind === "props"));
    return { fetch, events, prices: filtered, now: new Date() };
  }

  async guarded(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RefreshRefused) throw new ApiError(409, e.message);
      if (e instanceof OddsAPIError) throw new ApiError(e.status === 401 ? 401 : 502, e.message);
      throw e;
    }
  }

  async handle(method, path, body = null) {
    const url = new URL(path, "http://local");
    const q = Object.fromEntries(url.searchParams);
    const num = (v, d) => (v == null || v === "" ? d : Number(v));
    const p = url.pathname;
    let m;

    if (method === "GET" && p === "/api/meta") return this.meta();

    // ---- refreshes (the only routes that spend credits) ----
    if (method === "POST" && (m = p.match(/^\/api\/refresh\/(\w+)$/))) {
      const sport = this.sport(m[1]);
      return this.guarded(() => refreshSport(this.store, this.client(), sport, this.books(), body?.markets ?? MAIN_MARKETS));
    }
    if (method === "GET" && p === "/api/props/plan") {
      const sport = this.sport(q.sport);
      const markets = q.markets ? q.markets.split(",") : PROP_MARKETS[sport];
      return this.guarded(() => propsPlan(this.client(), sport, this.books(), q.hours ? Number(q.hours) : null, markets));
    }
    if (method === "POST" && (m = p.match(/^\/api\/props\/refresh\/(\w+)$/))) {
      const sport = this.sport(m[1]);
      if (!body?.event_ids?.length) throw new ApiError(400, "no games selected");
      return this.guarded(() => refreshProps(this.store, this.client(), sport, body.event_ids, this.books(),
        { markets: body.markets ?? PROP_MARKETS[sport] }));
    }

    // ---- tools (local snapshot only) ----
    if (method === "GET" && p === "/api/ev") {
      const { fetch, events, prices, now } = this.snapshot(q.sport, this.kind(q.kind));
      const rows = findEv(events, prices, {
        bettable: this.bettable(q.books), reference: REFERENCE_BOOK, method: this.method(q.method),
        minEv: num(q.min_ev, 0), minBooks: num(q.min_books, 3), kellyMult: num(q.kelly, 0.25), bankroll: num(q.bankroll, 1000), now,
        fairMode: this.fairMode(q.fair), weighted: q.weighted !== "0", maxWidth: q.max_width ? Number(q.max_width) : null,
      });
      // where this book's price for this exact bet opened (first price this device recorded)
      const opening = this.store.openingPrices([...new Set(rows.map((r) => r.event_id))], [...new Set(rows.map((r) => r.market))]);
      for (const r of rows) {
        const o = opening.get(priceKey({ event_id: r.event_id, book: r.book, market: r.market, outcome: r.outcome, description: r.player }));
        r.open_price = o ? o.price : null;
        r.open_point = o ? o.point ?? null : null;
        r.open_at = o ? o.fetched_at : null;
      }
      return { fetch, has_data: prices.length > 0, rows };
    }
    if (method === "GET" && p === "/api/screen") {
      const market = q.market ?? "spreads";
      const { fetch, events, prices, now } = this.snapshot(q.sport);
      if (market === "props") {
        return { fetch, has_data: events.size > 0, events: propsSummary(events, prices, this.store.propsFetched(q.sport), { now }) };
      }
      if (!MAIN_MARKETS.includes(market)) throw new ApiError(400, `market must be 'props' or one of ${MAIN_MARKETS}`);
      const rows = buildScreen(events, prices, {
        market, bettable: this.bettable(q.books), reference: REFERENCE_BOOK, method: this.method(q.method),
        previous: this.store.previousPrices(q.sport), opening: this.store.openingPrices([...events.keys()], [market]), now,
      });
      return { fetch, has_data: rows.length > 0, events: rows };
    }
    if (method === "GET" && p === "/api/props-screen") {
      const { events, prices } = this.snapshot(q.sport, "props");
      const event = events.get(q.event_id);
      if (!event) return { markets: [] };
      return {
        markets: buildPropScreen(event, prices.filter((x) => x.event_id === q.event_id), {
          bettable: this.bettable(q.books), reference: REFERENCE_BOOK, method: this.method(q.method),
          previous: this.store.previousPrices(q.sport), opening: this.store.openingPrices([q.event_id], PROP_MARKETS[q.sport]),
        }),
      };
    }
    if (method === "GET" && p === "/api/middles") {
      const { fetch, events, prices, now } = this.snapshot(q.sport, this.kind(q.kind));
      return { fetch, has_data: prices.length > 0, rows: findMiddles(events, prices, { bettable: this.bettable(q.books), now, totalStake: num(q.stake, 100) }) };
    }
    if (method === "GET" && p === "/api/lowhold") {
      const { fetch, events, prices, now } = this.snapshot(q.sport, this.kind(q.kind));
      return { fetch, has_data: prices.length > 0, rows: findLowHold(events, prices, { bettable: this.bettable(q.books), now }) };
    }
    if (method === "GET" && p === "/api/fair-detail") return this.fairDetail(q);
    if (method === "GET" && p === "/api/history") {
      return { rows: this.store.history(q.event_id, q.market, q.description || null) };
    }
    if (method === "GET" && p === "/api/media") {
      const { events, prices } = this.snapshot(q.sport);
      const names = new Set([...events.values()].flatMap((e) => [e.home, e.away]));
      const wanted = new Map();
      for (const x of prices) {
        const e = events.get(x.event_id);
        if (x.description && e) wanted.set(`${x.event_id}|${x.description}`, [x.event_id, e.home, e.away, x.description]);
      }
      return { teams: this.media.teamMap(q.sport, names), players: this.media.playerMap(q.sport, [...wanted.values()]) };
    }

    // ---- parlays ----
    if (method === "POST" && p === "/api/parlay/price") return this.parlayPrice(body);
    if (method === "POST" && p === "/api/parlay/generate") return this.parlayGenerate(body);

    throw new ApiError(404, `no route for ${method} ${p}`);
  }

  /** How one line's fair price was reached, book by book, plus the books that post other lines. */
  fairDetail(q) {
    const { events, prices } = this.snapshot(q.sport);
    const event = events.get(q.event_id);
    if (!event) throw new ApiError(404, "That game is no longer in the latest snapshot");
    const desc = q.description || null;
    const mine = prices.filter((x) => x.event_id === q.event_id && x.market === q.market && (x.description ?? null) === desc);
    const point = q.point === "" || q.point == null ? null : Number(q.point);
    const line = isMoneyline(q.market) ? null : isSpread(q.market) ? (q.outcome === event.home ? point : -point) : point;
    const groups = groupPrices(events, mine);
    const here = groups.get(lineKeyString(q.event_id, q.market, desc, line))?.books ?? new Map();
    const detail = fairDetail(here, {
      method: this.method(q.method), reference: REFERENCE_BOOK, minBooks: Number(q.min_books ?? 3),
      exclude: q.exclude || null, mode: this.fairMode(q.mode), weighted: q.weighted !== "0",
    });
    const sidePoint = (ln) => (ln == null ? null : isSpread(q.market) ? (q.outcome === event.home ? ln : -ln) : ln);
    const others = [...groups.values()].filter((g) => !Object.is(g.key.line, line) && g.key.line !== line)
      .map((g) => ({ line: g.key.line, point: sidePoint(g.key.line), books: [...g.books.keys()] }))
      .sort((a, b) => b.books.length - a.books.length);
    return {
      event: { id: event.id, home: event.home, away: event.away, commence_time: event.commence_time.toISOString() },
      market: q.market, description: desc, outcome: q.outcome, point, line, exclude: q.exclude || null,
      mode: detail.mode, outcomes: detail.outcomes,
      books: detail.books.map((r) => ({
        ...r, title: bookTitle(r.book), source_title: SOURCE_TITLES[r.source] ?? bookTitle(r.source),
        reason: r.reason && r.reason.replace(/\b[a-z_]+\b/g, (w) => (w in BOOK_TITLES ? BOOK_TITLES[w] : w)),
      })),
      fair: detail.fair && { ...detail.fair, probs: Object.fromEntries(detail.fair.probs) },
      other_lines: others,
    };
  }

  meta() {
    const books = this.books();
    return {
      sports: Object.entries(SPORTS).map(([id, s]) => {
        const fetch = this.store.latestFetch(id);
        const props = [...this.store.propsFetched(id).values()];
        return {
          id, title: s.title,
          last_fetch: fetch?.fetched_at ?? null,
          last_props_fetch: props.length ? props.sort().at(-1) : null,
          events: fetch?.n_events ?? 0,
          prop_markets: PROP_MARKETS[id].map((k) => ({ key: k, title: marketTitle(k) })),
          props_cost_per_event: propsCostPerEvent(id, books),
          // upper bound: one bulk call per feed (e.g. NBA + preseason); empty feeds are skipped
          refresh_cost: refreshCost(books) * s.keys.length,
        };
      }),
      books: books.map((b) => ({ key: b, title: bookTitle(b), reference: b === REFERENCE_BOOK, color: BOOK_COLORS[b] ?? "#888" })),
      reference: REFERENCE_BOOK,
      markets: MAIN_MARKETS.map((k) => ({ key: k, title: marketTitle(k) })),
      methods: Object.keys(DEVIG_METHODS),
      refresh_cost: refreshCost(books),
      usage: this.store.usage(),
      has_key: Boolean(this.settings().apiKey),
    };
  }

  snapshots(sports) {
    const out = new Map();
    for (const s of new Set(sports)) {
      const { events, prices } = this.store.snapshot(this.sport(s));
      out.set(s, { events, prices });
    }
    return out;
  }

  parlayPrice(req) {
    let quote = null;
    if (req.sgp_quote) {
      try { quote = [req.sgp_quote.book, americanToDecimal(Number(req.sgp_quote.american))]; } catch (e) { throw new ApiError(400, e.message); }
    }
    try {
      const legs = priceLegs(req.legs, this.snapshots(req.legs.map((l) => l.sport)), {
        method: this.method(req.method), reference: REFERENCE_BOOK, minBooks: req.min_books ?? 3,
      });
      return analyze(legs, {
        rho: new Map((req.correlations ?? []).map((c) => [pairKey(c.a, c.b), c.rho])), bettable: this.bettable(req.books),
        boost: (req.boost ?? 0) / 100, sgpQuote: quote, kellyMult: req.kelly ?? 0.25, bankroll: req.bankroll ?? 1000,
        maxStakePct: (req.max_stake_pct ?? 1) / 100, book: req.book ?? null,
      });
    } catch (e) {
      if (e instanceof ParlayError) throw new ApiError(400, e.message);
      throw e;
    }
  }

  parlayGenerate(req) {
    const minLegs = req.min_legs ?? 2, maxLegs = req.max_legs ?? 4;
    if (!(minLegs >= 1 && minLegs <= maxLegs && maxLegs <= 8)) throw new ApiError(400, "legs must satisfy 1 <= min <= max <= 8");
    let lo = 1.0, hi = 1e9;
    try {
      if (req.min_odds != null) lo = americanToDecimal(req.min_odds);
      if (req.max_odds != null) hi = americanToDecimal(req.max_odds);
    } catch (e) { throw new ApiError(400, e.message); }
    const rows = generate(this.snapshots(req.sports), {
      bettable: this.bettable(req.books), reference: REFERENCE_BOOK, method: this.method(req.method), minBooks: req.min_books ?? 3,
      now: new Date(), kind: this.kind(req.kind ?? "all"), minLegs, maxLegs, minDecimal: lo, maxDecimal: hi,
      minLegEv: (req.min_leg_ev ?? 0) / 100, boost: (req.boost ?? 0) / 100, sort: req.sort === "growth" ? "growth" : "ev",
      kellyMult: req.kelly ?? 0.25, bankroll: req.bankroll ?? 1000, maxStakePct: (req.max_stake_pct ?? 1) / 100,
      maxReuse: req.max_reuse ?? 3, limit: req.limit ?? 50,
    });
    return { rows };
  }
}
