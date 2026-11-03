// Quotes far out of line with every other book at the same line, e.g. a NoVig
// (exchange) Under at -1000 while the books sit near -110: a thin or stale
// order, not a price. They're left out of every tool so they can't skew a
// consensus, take "best price", or show up as a fake +EV bet.
// Port of oddscreen/outliers.py.

import { groupPrices } from "./models.js";

/** Log-odds gap from the other books' median at which a quote is dropped:
 * about -110 vs -260, or +100 vs -235. Real disagreement at one line is far smaller. */
export const OUTLIER_LOGIT = 0.85;
const MIN_OTHERS = 2; // with a single other book there's no telling which one is off

const logit = (decimal) => { const p = 1 / decimal; return Math.log(p / (1 - p)); };
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Splits prices into {kept, dropped}. The reference book is never dropped: when
 * the sharp book is far from the rest, it's usually the others that are stale. */
export function splitOutliers(events, prices, { reference, threshold = OUTLIER_LOGIT } = {}) {
  const dropped = new Set();
  for (const { books } of groupPrices(events, prices).values()) {
    const byOutcome = new Map();
    for (const [book, outcomes] of books) {
      for (const [outcome, p] of outcomes) {
        if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
        byOutcome.get(outcome).push([book, p]);
      }
    }
    for (const quotes of byOutcome.values()) {
      if (quotes.length < MIN_OTHERS + 1) continue;
      for (const [book, p] of quotes) {
        if (book === reference) continue;
        const others = quotes.filter(([b]) => b !== book).map(([, q]) => logit(q.price));
        if (Math.abs(logit(p.price) - median(others)) > threshold) dropped.add(p);
      }
    }
  }
  return { kept: prices.filter((p) => !dropped.has(p)), dropped: prices.filter((p) => dropped.has(p)) };
}
