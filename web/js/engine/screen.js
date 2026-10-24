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

function sidePoint(market, line, side, event) {
  if (line == null) return null;
  if (isSpread(market)) return side === event.home ? line : -line;
  return line;
}

/** line (home handicap for spreads, the total for O/U, null for moneylines)
 * -> book -> outcome -> price, in first-seen order. */
function linesOf(prices, event) {
  const lines = new Map();
  for (const p of prices) {
    const ln = lineOf(p, event);
    if (!lines.has(ln)) lines.set(ln, new Map());
    const books = lines.get(ln);
    if (!books.has(p.book)) books.set(p.book, new Map());
    const outs = books.get(p.book);
    if (!outs.has(p.outcome)) outs.set(p.outcome, p);
  }
  return lines;
}

/** The line most books post; on a tie, the reference book's line. */
function mainLine(lines, reference) {
  let best = null, bestN = -1;
  for (const [ln, books] of lines) if (books.size > bestN) { bestN = books.size; best = ln; }
  let ref = NO_LINE;
  for (const [ln, books] of lines) if ((books.get(reference)?.size ?? 0) >= 2) { ref = ln; break; }
  return ref !== NO_LINE && lines.get(ref).size === bestN ? ref : best;
}

/** Rows for one line. Only books posting this exact line appear, so every
 * price, the best-price flag and the fair price compare like with like. */
function lineRows(books, line, event, market, { bettable, reference, method, previous, opening }) {
  const fair = fairForLine(books, { method, reference });
  return sidesFor(market, event).map((side) => {
    const cells = {};
    let best = null;
    for (const [book, outcomes] of books) {
      const p = outcomes.get(side);
      if (!p) continue;
      const prev = previous.get(priceKey(p));
      const first = opening.get(priceKey(p));
      cells[book] = {
        price: p.price,
        point: p.point ?? null,
        link: p.link ?? null,
        prev_price: prev ? prev.price : null,
        prev_point: prev ? prev.point ?? null : null,
        open_price: first ? first.price : null,
        open_point: first ? first.point ?? null : null,
      };
      if (bettable.has(book) && book !== reference && (best == null || p.price > best.price)) best = p;
    }
    const fairCell = fair && fair.probs.has(side)
      ? { price: 1 / fair.probs.get(side), point: sidePoint(market, line, side, event), source: fair.source } : null;
    return { side, point: sidePoint(market, line, side, event), cells, best_book: best ? best.book : null, fair: fairCell };
  });
}

/** Every line posted for one market (or one player's prop), most-posted first. */
function marketLines(prices, event, market, kw) {
  const lines = linesOf(prices, event);
  const order = [...lines.keys()].sort((a, b) => lines.get(b).size - lines.get(a).size);
  return {
    main_line: mainLine(lines, kw.reference),
    lines: order.map((ln) => ({ line: ln, n_books: lines.get(ln).size, rows: lineRows(lines.get(ln), ln, event, market, kw) })),
  };
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
    out.push({ ...eventHead(event), ...marketLines(byEvent.get(event.id), event, market, { bettable, reference, method, previous, opening }) });
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
    if (!byMarket.has(market)) byMarket.set(market, []);
    byMarket.get(market).push({
      player,
      n_books: new Set(ps.map((p) => p.book)).size,
      ...marketLines(ps, event, market, { bettable, reference, method, previous, opening }),
    });
  }
  const markets = [...byMarket.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  return markets.map((market) => ({
    market,
    title: marketTitle(market),
    players: byMarket.get(market).sort((a, b) => -(a.main_line ?? 0) - -(b.main_line ?? 0) || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0)),
  }));
}
