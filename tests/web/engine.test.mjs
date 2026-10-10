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
