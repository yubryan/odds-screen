// Positive-EV finder: book prices that beat the de-vigged fair price.
// Port of oddscreen/ev.py.

import { bookTitle, isPreseason, isProp, marketTitle } from "./config.js";
import { fairForLine } from "./fair.js";
import { eventName, groupPrices, isUpcoming, isoformat, parseTime, selectionLabel } from "./models.js";
import { expectedValue, kellyFraction, round2 } from "./odds_math.js";

export const SUSPICIOUS_EV = 0.10; // EV this large on a main line is usually a stale or bad price
export const STALE_MINUTES = 30;

export function findEv(events, prices, {
  bettable, reference, method = "power", minEv = 0.0, minBooks = 3, kellyMult = 0.25, bankroll = 1000.0, now, fairMode = "auto",
}) {
  const rows = [];
  for (const { key, books } of groupPrices(events, prices).values()) {
    const event = events.get(key.event_id);
    if (!isUpcoming(event, now)) continue;
    const refPrices = books.get(reference) ?? new Map();
    for (const [book, outcomes] of books) {
      if (book === reference || !bettable.has(book)) continue;
      // each book is measured against a fair price it isn't part of
      const fair = fairForLine(books, { method, reference, minBooks, exclude: book, mode: fairMode });
      if (!fair) continue;
      for (const [outcome, p] of outcomes) {
        const prob = fair.probs.get(outcome);
        const ev = expectedValue(prob, p.price);
        if (ev < minEv) continue;
        const kelly = kellyFraction(prob, p.price) * kellyMult;
        const ageMin = p.last_update && p.fetched_at
          ? (parseTime(p.fetched_at) - parseTime(p.last_update)) / 60000 : null;
        const warnings = [];
        if (ev >= SUSPICIOUS_EV) warnings.push("EV unusually high: verify price");
        if (ageMin != null && ageMin > STALE_MINUTES) warnings.push(`price ${Math.round(ageMin)}m old at fetch`);
        const ref = refPrices.get(outcome);
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
          selection: selectionLabel(p),
          outcome,
          point: p.point ?? null,
          book,
          book_title: bookTitle(book),
          price: p.price,
          fair_prob: prob,
          fair_price: 1 / prob,
          ev,
          kelly,
          stake: round2(kelly * bankroll),
          fair_source: fair.source,
          fair_books: fair.n_books,
          ref_hold: fair.hold,
          ref_price: ref ? ref.price : null,
          age_min: ageMin,
          link: p.link ?? null,
          fetched_at: p.fetched_at ?? null,
          warnings,
        });
      }
    }
  }
  rows.sort((a, b) => b.ev - a.ev);
  return rows;
}
