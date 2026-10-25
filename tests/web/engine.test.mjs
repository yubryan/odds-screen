// Ports of the Python unit tests that aren't covered by the parity snapshots:
// quota guards, preseason feeds, props refresh, pruning, media matching.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_BOOKS } from "../../web/js/engine/config.js";
import { Media, matchTeam, norm } from "../../web/js/engine/media.js";
import { americanToDecimal, decimalToAmerican, devig } from "../../web/js/engine/odds_math.js";
import { OddsAPIClient, OddsAPIError } from "../../web/js/engine/oddsapi.js";
import { RefreshRefused, propsPlan, refreshProps, refreshSport } from "../../web/js/engine/service.js";
import { Store } from "../../web/js/engine/store.js";

const FUTURE = "2099-01-01T00:00:00Z";
const usage = (remaining, last) => ({ remaining, used: 500 - remaining, last });

class FakeClient {
  constructor(feeds, { odds = {}, cost = 3, remaining = 480 } = {}) {
    this.feeds = feeds; this.oddsData = odds; this.cost = cost; this.remaining = remaining;
    this.oddsCalls = []; this.eventCalls = [];
  }
  async events(key) {
    if (!(key in this.feeds)) throw new OddsAPIError("unknown sport", 404);
    return this.feeds[key].map((id) => ({ id, commence_time: FUTURE, home_team: "A", away_team: "B" }));
  }
  async odds(key) {
    this.oddsCalls.push(key);
    return { data: (this.oddsData[key] ?? this.feeds[key]).map((id) => ({ id, commence_time: FUTURE, home_team: "A", away_team: "B", bookmakers: [] })), usage: usage(this.remaining, this.cost) };
  }
  async eventOdds(key, id) {
    this.eventCalls.push(id);
    return { data: { id, commence_time: FUTURE, home_team: "A", away_team: "B", bookmakers: [{ key: "draftkings", markets: [{ key: "player_points", outcomes: [{ name: "Over", price: 1.9, point: 20.5, description: "P" }] }] }] }, usage: usage(this.remaining, 5) };
  }
}

test("odds conversions", () => {
  assert.equal(americanToDecimal(150), 2.5);
  assert.ok(Math.abs(decimalToAmerican(1 + 100 / 110) + 110) < 1e-9);
  assert.deepEqual(devig([1.91, 1.91], "power").map((x) => +x.toFixed(9)), [0.5, 0.5]);
  assert.throws(() => devig([2, 2], "nope"));
});

test("main refresh skips the paid call when nothing is upcoming", async () => {
  const store = new Store();
  const client = new FakeClient({ americanfootball_nfl: [] });
  await assert.rejects(refreshSport(store, client, "nfl", DEFAULT_BOOKS), RefreshRefused);
  assert.equal(client.oddsCalls.length, 0);
});

test("main refresh refuses when credits are too low", async () => {
  const store = new Store();
  store.setUsage(usage(1, 3));
  const client = new FakeClient({ americanfootball_nfl: ["g1"] });
  await assert.rejects(refreshSport(store, client, "nfl", DEFAULT_BOOKS), /Only 1 credits left/);
  assert.equal(client.oddsCalls.length, 0);
});

test("off-season sport is refused for free", async () => {
  const client = new FakeClient({});
  await assert.rejects(refreshSport(new Store(), client, "ncaab", DEFAULT_BOOKS), /not currently offered/);
});

test("NBA refresh spans regular season + preseason and skips empty feeds", async () => {
  const store = new Store();
  let client = new FakeClient({ basketball_nba: [], basketball_nba_preseason: ["p1", "p2"] });
  let r = await refreshSport(store, client, "nba", DEFAULT_BOOKS);
  assert.deepEqual(client.oddsCalls, ["basketball_nba_preseason"]);
  assert.equal(r.cost, 3);
  assert.equal(store.events.get("p1").league, "basketball_nba_preseason");

  client = new FakeClient({ basketball_nba: ["r1"], basketball_nba_preseason: ["p3"] });
  r = await refreshSport(store, client, "nba", DEFAULT_BOOKS);
  assert.deepEqual(client.oddsCalls.sort(), ["basketball_nba", "basketball_nba_preseason"]);
  assert.equal(r.cost, 6);
  assert.equal(store.usage().remaining, 480);
});

test("props refresh only hits upcoming games and records usage", async () => {
  const store = new Store();
  const client = new FakeClient({ basketball_nba: ["g1"], basketball_nba_preseason: [] });
  const r = await refreshProps(store, client, "nba", ["g1", "gone"], DEFAULT_BOOKS);
  assert.deepEqual(client.eventCalls, ["g1"]);
  assert.equal(r.games, 1);
  assert.equal(r.cost, 5);
  assert.deepEqual([...store.propsFetched("nba").keys()], ["g1"]);
  // a later main refresh must not drop the props
  store.saveFetch("nba", [], { markets: ["h2h"], books: ["x"] });
  assert.ok(store.snapshot("nba").prices.some((p) => p.market === "player_points"));
});

test("props refresh stops before credits run out", async () => {
  const store = new Store();
  store.setUsage(usage(7, 3));
  const client = new FakeClient({ basketball_nba: ["g1", "g2", "g3"], basketball_nba_preseason: [] }, { remaining: 2 });
  const r = await refreshProps(store, client, "nba", ["g1", "g2", "g3"], DEFAULT_BOOKS);
  assert.deepEqual(client.eventCalls, ["g1"]);
  assert.ok(r.stopped);
});

test("props plan is free and costs one call per game", async () => {
  const client = new FakeClient({ basketball_nba: ["a", "b"], basketball_nba_preseason: ["c"] });
  const plan = await propsPlan(client, "nba", DEFAULT_BOOKS);
  assert.equal(plan.events.length, 3);
  assert.equal(plan.per_event_cost, 5);
  assert.equal(plan.max_cost, 15);
  assert.equal(client.oddsCalls.length + client.eventCalls.length, 0);
});

test("history older than 14 days is pruned", () => {
  const store = new Store();
  const old = new Date(Date.now() - 20 * 86400e3);
  store.saveFetch("nfl", [{ id: "old", commence_time: FUTURE, home_team: "A", away_team: "B", bookmakers: [] }], { markets: ["h2h"], books: ["x"], fetchedAt: old });
  store.saveFetch("nfl", [{ id: "new", commence_time: FUTURE, home_team: "C", away_team: "D", bookmakers: [{ key: "draftkings", markets: [{ key: "h2h", outcomes: [{ name: "C", price: 2 }, { name: "D", price: 1.8 }] }] }] }], { markets: ["h2h"], books: ["x"] });
  assert.equal(store.prune(14), 1);
  assert.equal(store.fetches.length, 1);
  assert.ok(!store.events.has("old") && store.events.has("new"));
});

test("Odds API client reads credit headers and surfaces errors", async () => {
  const ok = async () => new Response("[]", { status: 200, headers: { "x-requests-remaining": "321", "x-requests-used": "179", "x-requests-last": "3" } });
  const c = new OddsAPIClient("k", ok);
  const res = await c.odds("americanfootball_nfl", ["h2h"], ["draftkings"]);
  assert.deepEqual(res.usage, { remaining: 321, used: 179, last: 3 });
  const bad = new OddsAPIClient("k", async () => new Response(JSON.stringify({ message: "quota" }), { status: 401 }));
  await assert.rejects(bad.events("x"), (e) => e instanceof OddsAPIError && e.status === 401 && /quota/.test(e.message));
  assert.throws(() => new OddsAPIClient(""), /API key/);
});

test("media name matching", () => {
  assert.equal(norm("Kenneth Walker III"), "kenneth walker");
  assert.equal(norm("Amon-Ra St. Brown"), "amon ra st brown");
  const teams = [
    { display: "LA Clippers", location: "LA", nickname: "Clippers", espn_id: "12" },
    { display: "Kentucky Wildcats", location: "Kentucky", nickname: "Wildcats", espn_id: "96" },
    { display: "Arizona Wildcats", location: "Arizona", nickname: "Wildcats", espn_id: "12a" },
  ];
  assert.equal(matchTeam("Los Angeles Clippers", teams).espn_id, "12");
  assert.equal(matchTeam("Arizona Wildcats", teams).espn_id, "12a");
  assert.equal(matchTeam("Villanova Wildcats", teams), null);
});

test("bundled media covers every team in the snapshots and scopes players to the game", () => {
  const media = new Media(JSON.parse(readFileSync(new URL("../../web/data/media.json", import.meta.url), "utf8")));
  for (const name of ["Los Angeles Clippers", "Dallas Cowboys", "Duke Blue Devils"]) {
    const sport = name.includes("Cowboys") ? "nfl" : name.includes("Duke") ? "ncaab" : "nba";
    assert.ok(media.teamMap(sport, [name])[name]?.logo, `${name} has a logo`);
  }
  const hit = media.playerMap("nfl", [["g", "Dallas Cowboys", "Tampa Bay Buccaneers", "CeeDee Lamb"]])["g|CeeDee Lamb"];
  assert.ok(hit?.headshot?.startsWith("https://a.espncdn.com/i/headshots/nfl/"));
  assert.equal(hit.team, "DAL");
});

test("pulling a subset of markets costs less and keeps the other markets from the last full pull", async () => {
  const store = new Store();
  const ev = (price) => ({
    id: "g1", commence_time: FUTURE, home_team: "A", away_team: "B", bookmakers: [{ key: "draftkings", markets: [
      { key: "h2h", outcomes: [{ name: "A", price }, { name: "B", price: 2 }] },
      { key: "spreads", outcomes: [{ name: "A", price, point: -3 }, { name: "B", price: 1.9, point: 3 }] },
    ] }],
  });
  const client = {
    calls: [],
    async events() { return [{ id: "g1", commence_time: FUTURE }]; },
    async odds(key, markets, books) {
      this.calls.push(markets);
      const e = ev(markets.length === 3 ? 1.8 : 1.7);
      e.bookmakers[0].markets = e.bookmakers[0].markets.filter((m) => markets.includes(m.key));
      return { data: [e], usage: usage(400, markets.length) };
    },
  };
  let r = await refreshSport(store, client, "nfl", DEFAULT_BOOKS);
  assert.equal(r.cost, 3);
  r = await refreshSport(store, client, "nfl", DEFAULT_BOOKS, ["spreads"]);
  assert.equal(r.cost, 1);
  assert.deepEqual(client.calls, [["h2h", "spreads", "totals"], ["spreads"]]);
  const { prices } = store.snapshot("nfl");
  const price = (m) => prices.find((p) => p.market === m && p.outcome === "A").price;
  assert.equal(price("spreads"), 1.7); // fresh from the spreads-only pull
  assert.equal(price("h2h"), 1.8); // kept from the full pull
  assert.equal(store.previousPrices("nfl").get(JSON.stringify(["g1", "draftkings", "spreads", "A", ""])).price, 1.8);
  await assert.rejects(refreshSport(store, client, "nfl", DEFAULT_BOOKS, []), /at least one market/);
});

test("props pulls can be limited to some markets", async () => {
  const store = new Store();
  const client = new FakeClient({ basketball_nba: ["g1"], basketball_nba_preseason: [] });
  const seen = [];
  client.eventOdds = async (key, id, markets) => { seen.push(markets); return { data: { id, commence_time: FUTURE, home_team: "A", away_team: "B", bookmakers: [] }, usage: usage(400, 0) }; };
  await refreshProps(store, client, "nba", ["g1"], DEFAULT_BOOKS, { markets: ["player_points", "bogus"] });
  assert.deepEqual(seen, [["player_points"]]);
  const plan = await propsPlan(client, "nba", DEFAULT_BOOKS, null, ["player_points", "player_rebounds"]);
  assert.equal(plan.per_event_cost, 2);
});

test("consensus counts books that share a feed once and leaves a book out of its own fair price", async () => {
  const { fairForLine } = await import("../../web/js/engine/fair.js");
  const { devig } = await import("../../web/js/engine/odds_math.js");
  const line = (books) => new Map(Object.entries(books).map(([b, [o, u]]) => [b, new Map([
    ["Over", { book: b, outcome: "Over", price: o, point: 45.5 }], ["Under", { book: b, outcome: "Under", price: u, point: 45.5 }]])]));
  const shared = fairForLine(line({ ballybet: [2.10, 1.75], betparx: [2.10, 1.75], draftkings: [1.91, 1.91], fanduel: [1.95, 1.87] }),
    { method: "multiplicative", reference: "pinnacle", minBooks: 3, weighted: false });
  const expect = [[2.10, 1.75], [1.91, 1.91], [1.95, 1.87]].reduce((a, d) => a + devig(d, "multiplicative")[0], 0) / 3;
  assert.equal(shared.n_books, 3);
  assert.ok(Math.abs(shared.probs.get("Over") - expect) < 1e-12);

  const books = line({ draftkings: [2.30, 1.60], fanduel: [1.91, 1.91], betmgm: [1.93, 1.89], espnbet: [1.90, 1.92] });
  const withDk = fairForLine(books, { method: "power", reference: "pinnacle", minBooks: 3 });
  const without = fairForLine(books, { method: "power", reference: "pinnacle", minBooks: 3, exclude: "draftkings" });
  assert.equal(withDk.n_books, 4);
  assert.equal(without.n_books, 3);
  assert.ok(without.probs.get("Over") > withDk.probs.get("Over"));
  const small = line({ draftkings: [1.91, 1.91], fanduel: [1.95, 1.87], betmgm: [1.93, 1.89] });
  assert.equal(fairForLine(small, { method: "power", reference: "pinnacle", minBooks: 3, exclude: "fanduel" }), null);
});


test("Kambi books share one down-weighted vote; width filters wide markets; the breakdown matches the price", async () => {
  const { fairDetail, fairForLine, marketWidth } = await import("../../web/js/engine/fair.js");
  const { sourceWeight } = await import("../../web/js/engine/config.js");
  const { americanToDecimal: d, devig } = await import("../../web/js/engine/odds_math.js");
  const props = (books) => new Map(Object.entries(books).map(([b, [o, u]]) => [b, new Map([
    ["Over", { book: b, market: "player_points", outcome: "Over", price: o, point: 18.5 }],
    ["Under", { book: b, market: "player_points", outcome: "Under", price: u, point: 18.5 }]])]));
  // three Kambi books + two others = 3 sources, Kambi weighted below FanDuel
  const books = props({ betrivers: [1.70, 2.15], ballybet: [1.72, 2.10], betparx: [1.72, 2.10], fanduel: [2.00, 1.80], draftkings: [1.91, 1.91] });
  const fair = fairForLine(books, { method: "multiplicative", reference: "pinnacle", minBooks: 3 });
  assert.equal(fair.n_books, 3);
  assert.ok(sourceWeight("kambi", "player_points") < sourceWeight("fanduel", "player_points"));
  const kambi = ([[1.70, 2.15], [1.72, 2.10], [1.72, 2.10]].reduce((a, x) => a + devig(x, "multiplicative")[0], 0)) / 3;
  const expect = (sourceWeight("kambi", "player_points") * kambi + sourceWeight("fanduel", "player_points") * devig([2.00, 1.80], "multiplicative")[0]
    + sourceWeight("draftkings", "player_points") * devig([1.91, 1.91], "multiplicative")[0])
    / (sourceWeight("kambi", "player_points") + sourceWeight("fanduel", "player_points") + sourceWeight("draftkings", "player_points"));
  assert.ok(Math.abs(fair.probs.get("Over") - expect) < 1e-12);
  // the breakdown explains every book and agrees with the price
  const detail = fairDetail(books, { method: "multiplicative", reference: "pinnacle", minBooks: 3, exclude: "draftkings" });
  const why = Object.fromEntries(detail.books.map((r) => [r.book, r.reason]));
  assert.equal(why.draftkings, "the book being priced");
  assert.equal(detail.fair, null); // only Kambi + FanDuel left = 2 sources
  assert.match(why.fanduel, /not enough independent books \(2 of 3\)/);
  const full = fairDetail(books, { method: "multiplicative", reference: "pinnacle", minBooks: 3 });
  const reasons = Object.fromEntries(full.books.map((r) => [r.book, r.reason]));
  assert.match(reasons.betrivers, /shares one vote with ballybet, betparx/);
  assert.ok(Math.abs(full.fair.probs.get("Over") - fair.probs.get("Over")) < 1e-15);
  // market width
  assert.equal(Math.round(marketWidth([d(-110), d(-110)])), 20);
  assert.equal(Math.round(marketWidth([d(125), d(-165)])), 40);
});


test("a book posting a price of 1.0 (or 0) is skipped instead of breaking the pull", async () => {
  const { marketWidth } = await import("../../web/js/engine/fair.js");
  const { findEv } = await import("../../web/js/engine/ev.js");
  assert.equal(marketWidth([1.0, 1.9]), null);
  assert.equal(marketWidth([NaN, 1.9]), null);
  const store = new Store();
  const when = new Date(Date.now() + 3 * 3600e3).toISOString();
  store.saveFetch("nba", [{ id: "e", commence_time: when, home_team: "H", away_team: "A", bookmakers: [
    ["pinnacle", 1.95, 1.87], ["draftkings", 1.0, 1.91], ["novig", 2.02, 0]].map(([key, o, u]) => ({ key, markets: [{ key: "totals", outcomes: [
      { name: "Over", price: o, point: 220.5 }, { name: "Under", price: u, point: 220.5 }] }] })) }], { markets: ["totals"], books: ["x"] });
  // even a bad price already stored on the device is screened out
  store.pricesByFetch.get(1).push({ fetch_id: 1, event_id: "e", book: "betmgm", market: "totals", outcome: "Over", description: null, point: 220.5, price: 1 });
  const { events, prices } = store.snapshot("nba");
  assert.ok(prices.every((p) => p.price > 1));
  assert.equal(prices.length, 4);
  assert.doesNotThrow(() => findEv(events, prices, { bettable: new Set(["draftkings", "novig"]), reference: "pinnacle", minEv: -1, now: new Date() }));
});
