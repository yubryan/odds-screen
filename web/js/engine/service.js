// Refresh orchestration with quota guards. Port of oddscreen/service.py.
// Main lines and props are separate refreshes so props (billed per game) never
// ride along with a main-line pull.

import { PROP_MARKETS, SPORTS, isPreseason, refreshCost, sportMarkets } from "./config.js";
import { OddsAPIError } from "./oddsapi.js";
import { parseTime } from "./models.js";

export class RefreshRefused extends Error {}

const title = (sport) => SPORTS[sport].title;

/** Upcoming games across a sport's feeds (e.g. NBA + NBA preseason, or the
 * chosen soccer leagues), from the free /events endpoint, soonest first.
 * Each keeps its sport_key. */
export async function upcomingEvents(client, sport, keys = null) {
  if (!(sport in SPORTS)) throw new RefreshRefused(`unknown sport '${sport}'`);
  const events = [];
  let offered = 0;
  for (const key of keys ?? SPORTS[sport].keys) {
    let batch;
    try {
      batch = await client.events(key);
    } catch (e) {
      if (e instanceof OddsAPIError && e.status === 404) continue; // feed not offered right now (off-season)
      throw e;
    }
    offered += 1;
    for (const e of batch) events.push({ ...e, sport_key: e.sport_key ?? key });
  }
  if (!offered) throw new RefreshRefused(`${title(sport)} is not currently offered by The Odds API (off-season?)`);
  const now = new Date();
  return events
    .filter((e) => parseTime(e.commence_time) > now)
    .sort((a, b) => (a.commence_time < b.commence_time ? -1 : a.commence_time > b.commence_time ? 1 : 0));
}

function checkQuota(store, cost) {
  const usage = store.usage();
  if (usage && usage.remaining != null && usage.remaining < cost) {
    throw new RefreshRefused(`Only ${usage.remaining} credits left; this refresh can cost up to ${cost}`);
  }
}

/** Main lines for one sport: one bulk call per feed that has upcoming games
 * (the free /events check means an empty feed, e.g. preseason once it ends,
 * never spends credits). All feeds land in a single snapshot. `leagues` limits
 * a sport that lets you pick them (soccer); the others keep showing their last pull. */
export async function refreshSport(store, client, sport, books, markets = sportMarkets(sport), { leagues = null } = {}) {
  markets = sportMarkets(sport).filter((m) => markets.includes(m));
  if (!markets.length) throw new RefreshRefused("Pick at least one market to pull");
  const wanted = leagues && SPORTS[sport].pickLeagues ? SPORTS[sport].keys.filter((k) => leagues.includes(k)) : SPORTS[sport].keys;
  if (!wanted.length) throw new RefreshRefused("Pick at least one league to pull");
  const feeds = [...new Set((await upcomingEvents(client, sport, wanted)).map((e) => e.sport_key))].sort();
  if (!feeds.length) throw new RefreshRefused(`No upcoming ${title(sport)} games listed, so no credits were spent`);
  checkQuota(store, refreshCost(books, markets) * feeds.length);

  const now = new Date();
  const payload = [];
  let cost = 0, used = null;
  for (const key of feeds) {
    const res = await client.odds(key, markets, books);
    used = res.usage;
    for (const e of res.data) payload.push({ ...e, sport_key: e.sport_key ?? key });
    cost += used.last ?? 0;
  }
  const fetchId = store.saveFetch(sport, payload, { markets, books, usage: used, fetchedAt: now, feeds: wanted });
  return { fetch_id: fetchId, events: payload.length, usage: used, cost, feeds, markets, leagues: wanted };
}

/** What "refresh all props" would hit, and its worst-case cost. Free. */
export async function propsPlan(client, sport, books, hours = null, markets = PROP_MARKETS[sport]) {
  let events = await upcomingEvents(client, sport);
  if (hours != null) {
    const cutoff = Date.now() + hours * 3600e3;
    events = events.filter((e) => parseTime(e.commence_time).getTime() <= cutoff);
  }
  const perEvent = refreshCost(books, markets);
  return {
    events: events.map((e) => ({
      id: e.id, name: `${e.away_team} @ ${e.home_team}`, commence_time: e.commence_time, preseason: isPreseason(e.sport_key),
    })),
    per_event_cost: perEvent,
    max_cost: perEvent * events.length,
  };
}

/** Props for the given games, one billed call each. Stops early (keeping what
 * it already saved) if the remaining credits can't cover the next call. */
export async function refreshProps(store, client, sport, eventIds, books, { onProgress, markets = PROP_MARKETS[sport] } = {}) {
  markets = PROP_MARKETS[sport].filter((m) => markets.includes(m));
  if (!markets.length) throw new RefreshRefused("Pick at least one prop market to pull");
  const perEvent = refreshCost(books, markets);
  const upcoming = new Map((await upcomingEvents(client, sport)).map((e) => [e.id, e]));
  const targets = eventIds.filter((id) => upcoming.has(id));
  if (!targets.length) throw new RefreshRefused("None of those games are upcoming, so no credits were spent");
  checkQuota(store, perEvent);

  let spent = 0, done = 0, empty = 0, lastUsage = null, stopped = null, gamesWithProps = [];
  for (const eid of targets) {
    try {
      checkQuota(store, perEvent);
    } catch (e) {
      stopped = e.message;
      break;
    }
    const { data: payload, usage } = await client.eventOdds(upcoming.get(eid).sport_key, eid, markets, books);
    payload.sport_key ??= upcoming.get(eid).sport_key;
    lastUsage = usage;
    spent += usage.last ?? 0;
    const hasProps = (payload.bookmakers ?? []).some((bm) => bm.markets?.length);
    store.saveFetch(sport, [payload], { markets, books, usage, kind: "props", eventId: eid });
    done += 1;
    if (!hasProps) empty += 1;
    else gamesWithProps.push(payload);
    onProgress?.(done, targets.length);
  }
  return { games: done, games_without_props: empty, cost: spent, usage: lastUsage, stopped, with_props: gamesWithProps };
}
