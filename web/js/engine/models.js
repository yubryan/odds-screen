// Core records and the market/line grouping every tool builds on.
// Port of oddscreen/models.py.
//
// Event: {id, sport, commence_time: Date, home, away, league}
// Price: {event_id, book, market, outcome, price, point, description, last_update, link, fetched_at}

import { isProp, marketTitle } from "./config.js";

/** Soccer lists the home side first ("Chelsea vs Arsenal"); US sports "Away @ Home". */
export const homeFirst = (sport) => sport === "soccer";
export const eventName = (e) => (homeFirst(e.sport) ? `${e.home} vs ${e.away}` : `${e.away} @ ${e.home}`);

export const DRAW = "Draw";

export const isSpread = (market) => market.includes("spreads");
export const isMoneyline = (market) => market.startsWith("h2h");

/** Home team's handicap for spreads, the total for O/U markets, null for moneylines. */
export function lineOf(p, event) {
  if (isMoneyline(p.market)) return null;
  if (isSpread(p.market)) {
    if (p.point == null) return null;
    return p.outcome === event.home ? p.point : -p.point;
  }
  return p.point ?? null;
}

/** One two-sided proposition: both sides share event, market, player and line. */
export const lineKeyString = (eventId, market, description, line) =>
  JSON.stringify([eventId, market, description ?? null, line ?? null]);

/**
 * line -> book -> outcome -> price, as nested Maps in insertion order.
 * Returns Map<keyString, {key: {event_id, market, description, line}, books: Map<book, Map<outcome, Price>>}>.
 */
export function groupPrices(events, prices) {
  const grouped = new Map();
  for (const p of prices) {
    const event = events.get(p.event_id);
    if (!event) continue;
    const line = lineOf(p, event);
    const ks = lineKeyString(p.event_id, p.market, p.description, line);
    let g = grouped.get(ks);
    if (!g) {
      g = { key: { event_id: p.event_id, market: p.market, description: p.description ?? null, line }, books: new Map() };
      grouped.set(ks, g);
    }
    let outs = g.books.get(p.book);
    if (!outs) { outs = new Map(); g.books.set(p.book, outs); }
    if (!outs.has(p.outcome)) outs.set(p.outcome, p);
  }
  return grouped;
}

/** Python's f"{x:g}" for the values we see (lines like 3, -2.5, 245.5). */
export function fmtG(x) {
  if (Object.is(x, -0)) return "-0";
  return String(x);
}

export function fmtPoint(point, spread) {
  if (point == null) return "";
  if (spread && point === 0) return "PK";
  const text = fmtG(point);
  return spread && point > 0 ? `+${text}` : text;
}

export function selectionLabel(p) {
  if (isProp(p.market)) return `${p.description} ${p.outcome} ${fmtPoint(p.point, false)} ${marketTitle(p.market)}`;
  if (isMoneyline(p.market)) return p.outcome === DRAW ? DRAW : `${p.outcome} ML`;
  return `${p.outcome} ${fmtPoint(p.point, isSpread(p.market))}`;
}

/** The outcomes of a market in display order: soccer moneylines are 3-way. */
export function sidesFor(market, event) {
  if (isMoneyline(market) && homeFirst(event.sport)) return [event.home, DRAW, event.away];
  if (isMoneyline(market) || isSpread(market)) return [event.away, event.home];
  return ["Over", "Under"];
}

export const isUpcoming = (event, now) => event.commence_time > now;

/** UTC ISO timestamp in Python's isoformat style (2026-10-11T17:00:00+00:00). */
export const isoformat = (d) => d.toISOString().replace(/\.000Z$/, "+00:00").replace(/Z$/, "+00:00");

export const parseTime = (value) => new Date(value);
