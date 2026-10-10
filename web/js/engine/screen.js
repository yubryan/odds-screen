// Odds screen: every book's line and price per game, best price flagged.
// Port of oddscreen/screen.py.

import { PROP_MARKETS, isPreseason, isProp, marketTitle } from "./config.js";
import { fairForLine } from "./fair.js";
import { eventName, isMoneyline, isSpread, isUpcoming, isoformat, lineOf } from "./models.js";
import { priceKey } from "./store.js";

const NO_LINE = Symbol("no line");

export function sidesFor(market, event) {
  if (isMoneyline(market) || isSpread(market)) return [event.away, event.home];
  return ["Over", "Under"];
}

/** How good the line (not price) is for the bettor; higher is better. */
export function favorability(p) {
  if (p.point == null) return 0.0;
  if (isSpread(p.market) || p.outcome === "Under") return p.point;
  return -p.point; // Over: lower total is better
}

function sidePoint(market, line, side, event) {
  if (line == null) return null;
  if (isSpread(market)) return side === event.home ? line : -line;
  return line;
}

const better = (p, best) => {
  const a = favorability(p), b = favorability(best);
  return a > b || (a === b && p.price > best.price);
};

/** Fair line at the reference book's own line, else the most widely posted line. */
function fairOf(prices, event, { reference, method }) {
  const lines = new Map(); // line -> Map<book, Map<outcome, Price>>
  for (const p of prices) {
    const ln = lineOf(p, event);
    if (!lines.has(ln)) lines.set(ln, new Map());
    const books = lines.get(ln);
    if (!books.has(p.book)) books.set(p.book, new Map());
    const outs = books.get(p.book);
    if (!outs.has(p.outcome)) outs.set(p.outcome, p);
  }
  let line = NO_LINE;
  for (const [ln, books] of lines) {
    if ((books.get(reference)?.size ?? 0) >= 2) { line = ln; break; }
  }
  if (line === NO_LINE && lines.size) {
    let bestN = -1;
    for (const [ln, books] of lines) if (books.size > bestN) { bestN = books.size; line = ln; }
  }
  if (line === NO_LINE) return [NO_LINE, null];
  return [line, fairForLine(lines.get(line), { method, reference })];
}

function rowsFor(prices, event, market, { bettable, reference, method, previous, opening }) {
  const [line, fair] = fairOf(prices, event, { reference, method });
  const rows = [];
  for (const side of sidesFor(market, event)) {
    const cells = {};
    let best = null;
    for (const p of prices) {
      if (p.outcome !== side || p.book in cells) continue;
      const prev = previous.get(priceKey(p));
      const first = opening.get(priceKey(p));
      cells[p.book] = {
        price: p.price,
        point: p.point ?? null,
        link: p.link ?? null,
        prev_price: prev ? prev.price : null,
        prev_point: prev ? prev.point ?? null : null,
        open_price: first ? first.price : null,
        open_point: first ? first.point ?? null : null,
      };
      if (bettable.has(p.book) && p.book !== reference) {
        if (best == null || better(p, best)) best = p;
      }
    }
    let fairCell = null;
    if (fair && fair.probs.has(side)) {
      fairCell = {
        price: 1 / fair.probs.get(side),
        point: sidePoint(market, line === NO_LINE ? null : line, side, event),
        source: fair.source,
      };
    }
    rows.push({ side, cells, best_book: best ? best.book : null, fair: fairCell });
  }
  return [rows, line];
}

const eventHead = (event) => ({
  id: event.id,
  name: eventName(event),
  home: event.home,
  away: event.away,
  commence_time: isoformat(event.commence_time),
  preseason: isPreseason(event.league),
});

const byTimeThenName = (a, b) =>
  a.commence_time - b.commence_time || (eventName(a) < eventName(b) ? -1 : eventName(a) > eventName(b) ? 1 : 0);

export function buildScreen(events, prices, { market, bettable, reference, method, previous, opening, now }) {
  const byEvent = new Map();
  for (const p of prices) {
    if (p.market === market && p.description == null) {
      if (!byEvent.has(p.event_id)) byEvent.set(p.event_id, []);
      byEvent.get(p.event_id).push(p);
    }
  }
  const out = [];
  for (const event of [...events.values()].sort(byTimeThenName)) {
    if (!isUpcoming(event, now) || !byEvent.has(event.id)) continue;
    const [rows] = rowsFor(byEvent.get(event.id), event, market, { bettable, reference, method, previous, opening });
    out.push({ ...eventHead(event), rows });
  }
  return out;
}

/** One entry per upcoming game: whether/when props were pulled and how many. */
export function propsSummary(events, prices, propsFetched, { now }) {
  const players = new Map(), markets = new Map();
  for (const p of prices) {
    if (!isProp(p.market)) continue;
    if (!players.has(p.event_id)) { players.set(p.event_id, new Set()); markets.set(p.event_id, new Set()); }
    players.get(p.event_id).add(p.description);
    markets.get(p.event_id).add(p.market);
  }
  const out = [];
  for (const event of [...events.values()].sort(byTimeThenName)) {
    if (!isUpcoming(event, now)) continue;
    out.push({
      ...eventHead(event),
      props_fetched_at: propsFetched.get(event.id) ?? null,
      n_players: players.get(event.id)?.size ?? 0,
      markets: [...(markets.get(event.id) ?? [])].sort(),
    });
  }
  return out;
}

/** Per prop market, per player: Over/Under rows across books. */
export function buildPropScreen(event, prices, { bettable, reference, method, previous, opening }) {
  const groups = new Map();
  for (const p of prices) {
    if (p.event_id === event.id && isProp(p.market) && p.description) {
      const k = JSON.stringify([p.market, p.description]);
      if (!groups.has(k)) groups.set(k, { market: p.market, player: p.description, prices: [] });
      groups.get(k).prices.push(p);
    }
  }
  const order = new Map((PROP_MARKETS[event.sport] ?? []).map((m, i) => [m, i]));
  const byMarket = new Map();
  for (const { market, player, prices: ps } of groups.values()) {
    const [rows, line] = rowsFor(ps, event, market, { bettable, reference, method, previous, opening });
    if (!byMarket.has(market)) byMarket.set(market, []);
    byMarket.get(market).push({
      player,
      line: line === NO_LINE ? null : line,
      n_books: new Set(ps.map((p) => p.book)).size,
      rows,
    });
  }
  const markets = [...byMarket.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  return markets.map((market) => ({
    market,
    title: marketTitle(market),
    players: byMarket.get(market).sort((a, b) => -(a.line ?? 0) - -(b.line ?? 0) || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0)),
  }));
}
