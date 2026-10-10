// Middles (spread/total gaps across books) and low-hold markets.
// Port of oddscreen/middles.py.

import { bookTitle, isPreseason, isProp, marketTitle } from "./config.js";
import { eventName, groupPrices, isMoneyline, isSpread, isUpcoming, isoformat, selectionLabel } from "./models.js";
import { round2 } from "./odds_math.js";

export const NFL_KEY_NUMBERS = new Set([3, 7]);

function bestByPoint(prices) {
  const best = new Map();
  for (const p of prices) {
    if (p.point != null && (!best.has(p.point) || p.price > best.get(p.point).price)) best.set(p.point, p);
  }
  return best;
}

const legReturn = (stake, decimal, result) => ({ win: stake * decimal, push: stake, loss: 0.0 })[result];

/** margin = home score - away score; point is from this side's perspective. */
function spreadResult(margin, point, isHome) {
  const covered = (isHome ? margin : -margin) + point;
  return covered > 0 ? "win" : covered === 0 ? "push" : "loss";
}

function totalResult(total, point, isOver) {
  const diff = isOver ? total - point : point - total;
  return diff > 0 ? "win" : diff === 0 ? "push" : "loss";
}

/** leg1/leg2 sized for equal return if only one wins; scan every integer
 * outcome in [lo, hi] for ones that pay more than that. */
function evaluate(event, leg1, leg2, lo, hi, totalStake) {
  const d1 = leg1.price, d2 = leg2.price;
  const s1 = (totalStake * d2) / (d1 + d2);
  const s2 = totalStake - s1;
  const miss = s1 * d1 - totalStake; // P&L when exactly one leg wins (usually negative)

  const hits = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) {
    let r1, r2, text;
    if (isSpread(leg1.market)) {
      r1 = spreadResult(v, leg1.point, leg1.outcome === event.home);
      r2 = spreadResult(v, leg2.point, leg2.outcome === event.home);
      text = v > 0 ? `${event.home} by ${v}` : v < 0 ? `${event.away} by ${-v}` : "Tie";
    } else {
      r1 = totalResult(v, leg1.point, leg1.outcome === "Over");
      r2 = totalResult(v, leg2.point, leg2.outcome === "Over");
      text = leg1.description ? `${leg1.description}: ${v}` : `Total ${v}`;
    }
    const profit = legReturn(s1, d1, r1) + legReturn(s2, d2, r2) - totalStake;
    if (profit > miss + 1e-9) {
      hits.push({ value: v, text, kind: r1 === "win" && r2 === "win" ? "both win" : "win + push", profit });
    }
  }
  if (!hits.length) return null;

  const worstHit = Math.min(...hits.map((h) => h.profit));
  const breakeven = miss >= 0 ? 0.0 : -miss / (worstHit - miss);
  const keyHit = event.sport === "nfl" && isSpread(leg1.market) && hits.some((h) => NFL_KEY_NUMBERS.has(Math.abs(h.value)));
  return {
    event_id: event.id,
    event: eventName(event),
    commence_time: isoformat(event.commence_time),
    market: leg1.market,
    market_title: marketTitle(leg1.market),
    is_prop: isProp(leg1.market),
    player: leg1.description ?? null,
    home: event.home,
    away: event.away,
    preseason: isPreseason(event.league),
    legs: [[leg1, s1], [leg2, s2]].map(([p, s]) => ({
      selection: selectionLabel(p), book: p.book, book_title: bookTitle(p.book),
      price: p.price, stake: round2(s), link: p.link ?? null,
    })),
    gap: hi - lo,
    hits,
    miss_pct: miss / totalStake,
    hit_pct: Math.max(...hits.map((h) => h.profit)) / totalStake,
    breakeven,
    key_number: keyHit,
  };
}

export function findMiddles(events, prices, { bettable, now, totalStake = 100.0 }) {
  const rows = [];
  for (const event of events.values()) {
    if (!isUpcoming(event, now)) continue;
    const mine = prices.filter((p) => p.event_id === event.id && bettable.has(p.book));

    const away = bestByPoint(mine.filter((p) => isSpread(p.market) && p.outcome === event.away));
    const home = bestByPoint(mine.filter((p) => isSpread(p.market) && p.outcome === event.home));
    for (const [a, pa] of away) {
      for (const [h, ph] of home) {
        if (a + h > 0) { // margin window: -h <= home margin <= a
          const row = evaluate(event, pa, ph, -h, a, totalStake);
          if (row) rows.push(row);
        }
      }
    }

    // Over/Under markets: game totals and player props, one group per (market, player)
    const overUnder = new Map();
    for (const p of mine) {
      if (!isSpread(p.market) && !isMoneyline(p.market)) {
        const k = JSON.stringify([p.market, p.description ?? null]);
        if (!overUnder.has(k)) overUnder.set(k, []);
        overUnder.get(k).push(p);
      }
    }
    for (const group of overUnder.values()) {
      const overs = bestByPoint(group.filter((p) => p.outcome === "Over"));
      const unders = bestByPoint(group.filter((p) => p.outcome === "Under"));
      for (const [x, po] of overs) {
        for (const [y, pu] of unders) {
          if (y > x) {
            const row = evaluate(event, po, pu, x, y, totalStake);
            if (row) rows.push(row);
          }
        }
      }
    }
  }
  rows.sort((a, b) => a.breakeven - b.breakeven);
  return rows;
}

/** Best available price on each side of the same line, across bettable books. */
export function findLowHold(events, prices, { bettable, now }) {
  const rows = [];
  const bettablePrices = prices.filter((p) => bettable.has(p.book));
  for (const { key, books } of groupPrices(events, bettablePrices).values()) {
    const event = events.get(key.event_id);
    if (!isUpcoming(event, now)) continue;
    const best = new Map();
    for (const outcomes of books.values()) {
      for (const [outcome, p] of outcomes) {
        if (!best.has(outcome) || p.price > best.get(outcome).price) best.set(outcome, p);
      }
    }
    if (best.size < 2) continue;
    const first = (p) => (p.outcome !== event.away && p.outcome !== "Over" ? 1 : 0);
    const legs = [...best.values()].sort((a, b) => first(a) - first(b));
    const hold = legs.reduce((s, p) => s + 1 / p.price, 0) - 1;
    rows.push({
      event_id: event.id,
      event: eventName(event),
      commence_time: isoformat(event.commence_time),
      market: key.market,
      market_title: marketTitle(key.market),
      is_prop: isProp(key.market),
      player: key.description,
      home: event.home,
      away: event.away,
      preseason: isPreseason(event.league),
      legs: legs.map((p) => ({ selection: selectionLabel(p), book: p.book, book_title: bookTitle(p.book), price: p.price, link: p.link ?? null })),
      hold,
      n_books: books.size,
    });
  }
  rows.sort((a, b) => a.hold - b.hold);
  return rows;
}
