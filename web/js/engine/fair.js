// Fair (no-vig) probabilities for one line: Pinnacle first, else a consensus.
// Port of oddscreen/fair.py, plus fairDetail(), which explains the result
// book by book (both come from the same code, so they can't disagree).

import { feedOf, sourceWeight } from "./config.js";
import { decimalToAmerican, devig, overround } from "./odds_math.js";

export const FAIR_MODES = ["auto", "pinnacle", "consensus"];

/** A usable decimal price: finite and paying more than the stake back. */
export const isQuote = (d) => Number.isFinite(d) && d > 1;

const sameKeys = (m, sorted) => {
  const keys = [...m.keys()].sort();
  return keys.length === sorted.length && keys.every((k, i) => k === sorted[i]);
};

/** Gap between the two sides in American-odds cents: -110/-110 is 20,
 * +125/-165 is 40. Wide markets mean the book is unsure of its own price. */
export function marketWidth(decimals) {
  if (decimals.length !== 2 || !decimals.every(isQuote)) return null;
  const [a, b] = decimals.map(decimalToAmerican);
  if (a < 0 && b < 0) return -a - b - 200;
  if (a > 0 && b > 0) return 200 - a - b;
  const [neg, pos] = a < 0 ? [a, b] : [b, a];
  return -neg - pos;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * The fair price for one line and how it was reached.
 * mode "auto": the reference book at this exact line, else the consensus.
 * "pinnacle": the reference book only (null when it doesn't post the line).
 * "consensus": always the consensus, with the reference book as one of the voters.
 * Consensus: weighted average of the books' de-vigged probabilities, one vote
 * per odds source (books sharing a pricing engine count once), weighted by how
 * sharp that source is for this market type, leaving out `exclude` and its
 * source-mates (a book can't vouch for its own price). Needs `minBooks`
 * independent sources with both sides posted.
 */
export function fairDetail(books, { method, reference, minBooks = 3, exclude = null, mode = "auto", weighted = true }) {
  if (!FAIR_MODES.includes(mode)) throw new Error(`fair mode must be one of ${FAIR_MODES}`);
  const all = new Set();
  for (const m of books.values()) for (const o of m.keys()) all.add(o);
  const outcomes = [...all].sort();
  const market = [...books.values()].flatMap((m) => [...m.values()])[0]?.market ?? "";
  const skip = exclude ? feedOf(exclude) : null;
  const rows = [...books].map(([book, m]) => {
    const twoSided = outcomes.length >= 2 && sameKeys(m, outcomes);
    const decimals = twoSided ? outcomes.map((o) => m.get(o).price) : null;
    return {
      book, source: feedOf(book), prices: Object.fromEntries([...m].map(([o, p]) => [o, p.price])), two_sided: twoSided,
      probs: decimals ? devig(decimals, method) : null, hold: decimals ? overround(decimals) : null,
      width: decimals ? marketWidth(decimals) : null, weight: null, used: false, reason: null,
    };
  });
  const out = { outcomes, books: rows, fair: null, mode, market };
  if (outcomes.length < 2) return out;

  if (mode !== "consensus") {
    const ref = rows.find((r) => r.book === reference && r.two_sided);
    if (ref) {
      for (const r of rows) {
        r.used = r === ref;
        r.reason = r === ref ? "fair price source" : `not needed: ${reference} posts this line`;
      }
      out.fair = { probs: new Map(outcomes.map((o, i) => [o, ref.probs[i]])), source: reference, n_books: 1, hold: ref.hold, width: ref.width };
      return out;
    }
    if (mode === "pinnacle") {
      for (const r of rows) r.reason = `${reference} doesn't post this line`;
      return out;
    }
  }

  const votes = new Map(); // source -> rows
  for (const r of rows) {
    if (skip && r.source === skip) { r.reason = r.book === exclude ? "the book being priced" : "same pricing engine as the book being priced"; continue; }
    if (!r.two_sided) { r.reason = outcomes.length > 2 ? "not every outcome posted" : "only one side posted"; continue; }
    if (!votes.has(r.source)) votes.set(r.source, []);
    votes.get(r.source).push(r);
  }
  for (const [source, vs] of votes) {
    const w = weighted ? sourceWeight(source, market) : 1.0;
    for (const r of vs) {
      r.weight = w / vs.length;
      r.used = true;
      r.reason = vs.length > 1 ? `shares one vote with ${vs.filter((x) => x !== r).map((x) => x.book).join(", ")}` : "used";
    }
  }
  if (votes.size < minBooks) {
    for (const r of rows) if (r.used) { r.used = false; r.reason = `not enough independent books (${votes.size} of ${minBooks})`; }
    return out;
  }
  const sums = new Map(outcomes.map((o) => [o, 0.0]));
  let holds = 0.0, totalW = 0.0;
  const widths = [];
  for (const [source, vs] of votes) {
    const w = weighted ? sourceWeight(source, market) : 1.0;
    const k = vs.length;
    outcomes.forEach((o, i) => sums.set(o, sums.get(o) + w * vs.reduce((a, v) => a + v.probs[i], 0) / k));
    holds += w * vs.reduce((a, v) => a + v.hold, 0) / k;
    totalW += w;
    for (const v of vs) if (v.width != null) widths.push(v.width);
  }
  out.fair = {
    probs: new Map([...sums].map(([o, s]) => [o, s / totalW])), source: "consensus", n_books: votes.size,
    hold: holds / totalW, width: widths.length ? median(widths) : null,
  };
  return out;
}

/** books: Map<book, Map<outcome, Price>>. Returns {probs: Map<outcome, p>, source, n_books, hold, width} or null. */
export function fairForLine(books, opts) {
  return fairDetail(books, opts).fair;
}
