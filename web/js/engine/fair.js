// Fair (no-vig) probabilities for one line: Pinnacle first, else a consensus.
// Port of oddscreen/fair.py.

import { devig, overround } from "./odds_math.js";

const sameKeys = (m, sorted) => {
  const keys = [...m.keys()].sort();
  return keys.length === sorted.length && keys.every((k, i) => k === sorted[i]);
};

/**
 * De-vig the reference book at this exact line; if it doesn't post this line,
 * average the de-vigged probabilities of every book that does (needs
 * `minBooks` complete two-sided markets).
 * books: Map<book, Map<outcome, Price>>. Returns {probs: Map<outcome, p>, source, n_books, hold} or null.
 */
export function fairForLine(books, { method, reference, minBooks = 3 }) {
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

  const complete = [...books.values()].filter((m) => sameKeys(m, outcomes));
  if (complete.length < minBooks) return null;
  const sums = new Map(outcomes.map((o) => [o, 0.0]));
  let holds = 0.0;
  for (const m of complete) {
    const decimals = outcomes.map((o) => m.get(o).price);
    holds += overround(decimals);
    devig(decimals, method).forEach((p, i) => sums.set(outcomes[i], sums.get(outcomes[i]) + p));
  }
  const n = complete.length;
  return { probs: new Map([...sums].map(([o, s]) => [o, s / n])), source: "consensus", n_books: n, hold: holds / n };
}
