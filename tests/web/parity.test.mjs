// The JavaScript engine must reproduce the Python engine exactly on real
// snapshots. Golden files come from tools/make_golden.py (gitignored: real odds).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_BOOKS, MAIN_MARKETS, PROP_MARKETS, REFERENCE_BOOK, isProp } from "../../web/js/engine/config.js";
import { findEv } from "../../web/js/engine/ev.js";
import { findLowHold, findMiddles } from "../../web/js/engine/middles.js";
import { devig } from "../../web/js/engine/odds_math.js";
import { analyze, generate, jointWinProb, metrics, pairKey, priceLegs } from "../../web/js/engine/parlay.js";
import { buildPropScreen, buildScreen, propsSummary } from "../../web/js/engine/screen.js";
import { Store } from "../../web/js/engine/store.js";

const GOLDEN = new URL("../golden/", import.meta.url);
let BETTABLE = new Set(DEFAULT_BOOKS.filter((b) => b !== REFERENCE_BOOK)); // replaced by each golden file's own set
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MONEY = new Set(["stake", "to_win"]);

/** Deep equality with numeric tolerance; ISO timestamps compared as instants. */
function close(actual, expected, tol, path = "$") {
  if (expected === null || expected === undefined) {
    assert.ok(actual === null || actual === undefined, `${path}: expected null, got ${JSON.stringify(actual)}`);
    return;
  }
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${path}: expected number ${expected}, got ${JSON.stringify(actual)}`);
    const key = path.split(".").pop();
    const abs = MONEY.has(key) ? Math.max(tol.abs, 0.011) : key === "age_min" ? 1e-4 : tol.abs;
    assert.ok(Math.abs(actual - expected) <= abs + tol.rel * Math.abs(expected), `${path}: ${actual} != ${expected}`);
    return;
  }
  if (typeof expected === "string") {
    if (ISO.test(expected) && typeof actual === "string" && ISO.test(actual)) {
      assert.equal(new Date(actual).getTime(), new Date(expected.replace(/(\.\d{3})\d+/, "$1")).getTime(), `${path}: ${actual} != ${expected}`);
    } else {
      assert.equal(actual, expected, path);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected array`);
    assert.equal(actual.length, expected.length, `${path}: length ${actual.length} != ${expected.length}`);
    expected.forEach((e, i) => close(actual[i], e, tol, `${path}[${i}]`));
    return;
  }
  if (typeof expected === "object") {
    assert.ok(actual && typeof actual === "object", `${path}: expected object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys differ`);
    for (const k of Object.keys(expected)) close(actual[k], expected[k], tol, `${path}.${k}`);
    return;
  }
  assert.equal(actual, expected, path);
}

const EXACT = { abs: 1e-9, rel: 1e-9 };
const COPULA = { abs: 2e-3, rel: 2e-3 }; // scipy's MVN CDF is itself randomized QMC (~1e-5)

for (const sport of ["nfl", "nba"]) {
  const file = new URL(`${sport}.json`, GOLDEN);
  const skip = !existsSync(file) && "golden file missing: run tools/make_golden.py";
  const g = skip ? null : JSON.parse(readFileSync(file, "utf8"));
  const setup = () => {
    BETTABLE = new Set(g.bettable);
    const store = new Store().load(g.rows);
    const now = new Date(g.now);
    const snap = store.snapshot(sport);
    return { store, now, ...snap, previous: store.previousPrices(sport) };
  };
  const ofKind = (ps, k) => (k === "all" ? ps : ps.filter((p) => isProp(p.market) === (k === "props")));

  test(`${sport}: positive EV`, { skip }, () => {
    const { events, prices, now } = setup();
    for (const c of g.cases.ev) {
      const p = c.params;
      const out = findEv(events, ofKind(prices, p.kind), {
        bettable: BETTABLE, reference: REFERENCE_BOOK, method: p.method, minEv: p.min_ev, minBooks: p.min_books,
        kellyMult: p.kelly_mult, bankroll: p.bankroll, now, fairMode: p.fair_mode ?? "auto",
        weighted: p.weighted ?? true, maxWidth: p.max_width ?? null,
      });
      close(out, c.out, EXACT, `ev(${JSON.stringify(p)})`);
    }
  });

  test(`${sport}: odds screen (main lines)`, { skip }, () => {
    const { store, events, prices, previous, now } = setup();
    for (const c of g.cases.screen) {
      const out = buildScreen(events, prices, {
        market: c.market, bettable: BETTABLE, reference: REFERENCE_BOOK, method: "power", previous,
        opening: store.openingPrices([...events.keys()], [c.market]), now,
      });
      close(out, c.out, EXACT, `screen(${c.market})`);
    }
  });

  test(`${sport}: props summary and props screens`, { skip }, () => {
    const { store, events, prices, previous, now } = setup();
    close(propsSummary(events, prices, store.propsFetched(sport), { now }), g.cases.props_summary, EXACT, "props_summary");
    for (const c of g.cases.prop_screen) {
      const ps = ofKind(prices, "props").filter((p) => p.event_id === c.event_id);
      const out = buildPropScreen(events.get(c.event_id), ps, {
        bettable: BETTABLE, reference: REFERENCE_BOOK, method: "power", previous,
        opening: store.openingPrices([c.event_id], PROP_MARKETS[sport]),
      });
      close(out, c.out, EXACT, `prop_screen(${c.event_id})`);
    }
  });

  test(`${sport}: middles and low hold`, { skip }, () => {
    const { events, prices, now } = setup();
    close(findMiddles(events, prices, { bettable: BETTABLE, now, totalStake: 100 }), g.cases.middles, EXACT, "middles");
    close(findLowHold(events, prices, { bettable: BETTABLE, now }), g.cases.lowhold, EXACT, "lowhold");
  });

  test(`${sport}: line history`, { skip }, () => {
    const { store } = setup();
    const ev = g.cases.history[0];
    assert.ok(g.cases.history.length > 0);
    const eventId = store.fetches.length && [...store.events.keys()].find((id) =>
      store.history(id, sport === "nfl" ? "player_reception_yds" : "h2h").length === g.cases.history.length
      && store.history(id, sport === "nfl" ? "player_reception_yds" : "h2h")[0].price === ev.price);
    assert.ok(eventId, "history event found");
    close(store.history(eventId, sport === "nfl" ? "player_reception_yds" : "h2h"), g.cases.history, EXACT, "history");
  });

  test(`${sport}: parlay pricing`, { skip }, () => {
    const { events, prices } = setup();
    const snaps = new Map([[sport, { events, prices }]]);
    for (const c of g.cases.parlay) {
      const legs = priceLegs(c.legs, snaps, { method: "power", reference: REFERENCE_BOOK, minBooks: 3 });
      const out = analyze(legs, {
        rho: new Map(c.rho.map(([a, b, r]) => [pairKey(a, b), r])), bettable: BETTABLE, boost: c.boost,
        sgpQuote: c.quote, kellyMult: 0.25, bankroll: 1000, maxStakePct: 0.01, book: c.book,
      });
      close(out, c.out, c.name.startsWith("sgp") ? COPULA : EXACT, `parlay(${c.name})`);
    }
  });

  test(`${sport}: parlay generator`, { skip }, () => {
    const { events, prices, now } = setup();
    const snaps = new Map([[sport, { events, prices }]]);
    for (const c of g.cases.generate) {
      const p = c.params;
      const out = generate(snaps, {
        bettable: BETTABLE, reference: REFERENCE_BOOK, method: "power", minBooks: 3, now, kind: p.kind,
        minLegs: p.min_legs, maxLegs: p.max_legs, minDecimal: p.min_decimal, maxDecimal: p.max_decimal,
        minLegEv: p.min_leg_ev, boost: p.boost, sort: p.sort, maxReuse: p.max_reuse, limit: p.limit,
        kellyMult: 0.25, bankroll: 1000, maxStakePct: 0.01,
      });
      close(out, c.out, EXACT, `generate(${JSON.stringify(p)})`);
    }
  });
}

test("math: devig, metrics, copula", { skip: !existsSync(new URL("math.json", GOLDEN)) && "golden missing" }, () => {
  const m = JSON.parse(readFileSync(new URL("math.json", GOLDEN), "utf8"));
  for (const c of m.devig) close(devig(c.decimals, c.method), c.out, EXACT, `devig(${c.method}, ${c.decimals})`);
  for (const c of m.metrics) {
    const [p, d, boost, kellyMult, bankroll, maxStakePct] = c.args;
    close(metrics(p, d, { boost, kellyMult, bankroll, maxStakePct }), c.out, EXACT, `metrics(${c.args})`);
  }
  for (const c of m.joint) {
    const r = c.matrix ?? [[1, c.rho], [c.rho, 1]];
    close(jointWinProb(c.probs, r), c.p, { abs: 2e-4, rel: 0 }, `joint(${c.probs})`);
  }
});

test("markets are in the right order", () => {
  assert.deepEqual(MAIN_MARKETS, ["h2h", "spreads", "totals"]);
});
