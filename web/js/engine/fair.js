// Fair (no-vig) probabilities for one line: Pinnacle first, else a consensus.
// Port of oddscreen/fair.py.

import { feedOf } from "./config.js";
import { devig, overround } from "./odds_math.js";

const sameKeys = (m, sorted) => {
  const keys = [...m.keys()].sort();
  return keys.length === sorted.length && keys.every((k, i) => k === sorted[i]);
};

/**
 * De-vig the reference book at this exact line. If it doesn't post this line,
 * average the de-vigged probabilities of the books that do: one vote per odds
 * feed (books sharing a feed count once), leaving out `exclude` and its
 * feed-mates, since a book can't vouch for its own price. Needs `minBooks`
 * independent sources with both sides posted.
 * books: Map<book, Map<outcome, Price>>. Returns {probs: Map<outcome, p>, source, n_books, hold} or null.
 */
export function fairForLine(books, { method, reference, minBooks = 3, exclude = null }) {
  const all = new Set();
  for (const m of books.values()) for (const o of m.keys()) all.add(o);
  const outcomes = [...all].sort();
  if (outcomes.length < 2) return null;

  const ref = books.get(reference);
  if (ref && sameKeys(ref, outcomes)) {
    const decimals = outcomes.map((o) => ref.get(o).price);
    const probs = devig(decimals, method);
    return { probs: new Map(outcomes.map((o, i) => [o, probs[i]])), source: reference, n_books: 1, hold: overround(decimals) };
  }

  const skip = exclude ? feedOf(exclude) : null;
  const votes = new Map(); // feed -> [{probs, hold}]
  for (const [book, m] of books) {
    if (!sameKeys(m, outcomes) || feedOf(book) === skip) continue;
    const decimals = outcomes.map((o) => m.get(o).price);
    if (!votes.has(feedOf(book))) votes.set(feedOf(book), []);
    votes.get(feedOf(book)).push({ probs: devig(decimals, method), hold: overround(decimals) });
  }
  if (votes.size < minBooks) return null;
  const sums = new Map(outcomes.map((o) => [o, 0.0]));
  let holds = 0.0;
  for (const vs of votes.values()) {
    const k = vs.length;
    outcomes.forEach((o, i) => sums.set(o, sums.get(o) + vs.reduce((a, v) => a + v.probs[i], 0) / k));
    holds += vs.reduce((a, v) => a + v.hold, 0) / k;
  }
  const n = votes.size;
  return { probs: new Map([...sums].map(([o, s]) => [o, s / n])), source: "consensus", n_books: n, hold: holds / n };
}
