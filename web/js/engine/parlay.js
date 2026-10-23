// Parlay pricing and generation. Port of oddscreen/parlay.py.
//
// Fair probability of a parlay = product over games of each game's joint win
// probability. Legs in different games are independent. Legs in the same game
// (an SGP) are joined with a Gaussian copula: leg i wins when a latent standard
// normal Z_i <= Phi^-1(p_i), with the Z's correlated by the user's rho per pair.
//
// Straight (cross-game) parlays pay the product of the book's leg prices, so their
// EV is exact. Books price SGPs with their own correlation model, which we can't
// see, so an SGP's EV needs the book's quoted price; without it we report fair
// odds across a range of correlations and the break-even correlation.

import { bookTitle, isPreseason, isProp, marketTitle } from "./config.js";
import { fairForLine } from "./fair.js";
import { eventName, fmtG, groupPrices, isMoneyline, isSpread, isUpcoming, isoformat, lineKeyString, selectionLabel } from "./models.js";
import { mvnCdf, nearestCorrelation, normPpf } from "./mvn.js";

export const RHO_MIN = -0.5, RHO_MAX = 0.95;
export const RHO_GRID = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];

export class ParlayError extends Error {}

// ---- legs -----------------------------------------------------------------------

/** spec: {sport, event_id, market, outcome, point, description}; must match parlay.LegSpec.id */
export function legId(s) {
  const pt = s.point == null ? "" : fmtG(s.point);
  return `${s.event_id}|${s.market}|${s.description ?? ""}|${s.outcome}|${pt}`;
}

function specLine(s, event) {
  if (isMoneyline(s.market)) return null;
  if (isSpread(s.market) && s.point != null) return s.outcome === event.home ? s.point : -s.point;
  return s.point ?? null;
}

const specOut = (s) => ({ sport: s.sport, event_id: s.event_id, market: s.market, outcome: s.outcome,
  point: s.point ?? null, description: s.description ?? null });

export function legLabel(s) {
  return selectionLabel({ event_id: s.event_id, book: "", market: s.market, outcome: s.outcome, price: 2.0,
    point: s.point ?? null, description: s.description ?? null });
}

function legDict(leg, bettable) {
  let best = null;
  for (const [b, p] of leg.prices) if (bettable.has(b) && (best == null || p.price > best.price)) best = p;
  const s = leg.spec, e = leg.event;
  return {
    id: legId(s),
    spec: specOut(s),
    label: legLabel(s),
    event: eventName(e), home: e.home, away: e.away,
    commence_time: isoformat(e.commence_time),
    preseason: isPreseason(e.league),
    is_prop: isProp(s.market), player: s.description ?? null, market_title: marketTitle(s.market),
    fair_prob: leg.fair_prob,
    fair_price: leg.fair_prob ? 1 / leg.fair_prob : null,
    fair_source: leg.fair_source, fair_books: leg.fair_books, fair_thin: leg.fair_thin,
    books: Object.fromEntries([...leg.prices].map(([b, p]) => [b, { price: p.price, point: p.point ?? null, link: p.link ?? null }])),
    alternates: Object.fromEntries([...leg.alternates].map(([b, p]) => [b, { price: p.price, point: p.point ?? null }])),
    best_book: best ? best.book : null,
    best_price: best ? best.price : null,
    best_ev: best && leg.fair_prob ? leg.fair_prob * best.price - 1 : null,
  };
}

/** snapshots: Map<sport, {events: Map, prices: Price[]}> */
export function priceLegs(specs, snapshots, { method, reference, minBooks }) {
  const grouped = new Map([...snapshots].map(([sport, s]) => [sport, groupPrices(s.events, s.prices)]));
  const bySelection = new Map();
  for (const s of snapshots.values()) {
    for (const p of s.prices) {
      const k = JSON.stringify([p.event_id, p.market, p.description ?? null, p.outcome]);
      if (!bySelection.has(k)) bySelection.set(k, []);
      bySelection.get(k).push(p);
    }
  }
  return specs.map((s) => {
    const event = snapshots.get(s.sport)?.events.get(s.event_id);
    if (!event) throw new ParlayError(`${s.outcome} (${s.market}) is no longer in the latest snapshot`);
    const books = grouped.get(s.sport).get(lineKeyString(s.event_id, s.market, s.description, specLine(s, event)))?.books ?? new Map();
    const exclude = s.book ?? null; // where the leg was picked: left out of its own consensus
    let fair = books.size ? fairForLine(books, { method, reference, minBooks, exclude }) : null;
    let thin = false;
    if (!fair && books.size) {
      // A hand-picked line that few books post: de-vig whatever other books post it (or, if
      // it's the only one, the picked book itself), flagged as rough.
      fair = fairForLine(books, { method, reference, minBooks: 1, exclude }) ?? fairForLine(books, { method, reference, minBooks: 1 });
      thin = fair != null;
    }
    const prices = new Map();
    for (const [b, outs] of books) if (outs.has(s.outcome)) prices.set(b, outs.get(s.outcome));
    const alternates = new Map();
    const dist = (p) => Math.abs((p.point ?? 0) - (s.point ?? 0));
    for (const p of bySelection.get(JSON.stringify([s.event_id, s.market, s.description ?? null, s.outcome])) ?? []) {
      if (!prices.has(p.book) && p.point !== (s.point ?? null)) {
        const cur = alternates.get(p.book);
        if (cur == null || dist(p) < dist(cur)) alternates.set(p.book, p);
      }
    }
    return {
      spec: s, event,
      fair_prob: fair ? fair.probs.get(s.outcome) ?? null : null,
      fair_source: fair ? fair.source : null, fair_books: fair ? fair.n_books : 0,
      prices, alternates, fair_thin: thin,
    };
  });
}

/** Combinations no book will take in one parlay. */
export function conflicts(legs) {
  const seen = new Map();
  const out = [];
  for (const leg of legs) {
    const k = JSON.stringify([leg.spec.event_id, leg.spec.market, leg.spec.description ?? null]);
    if (seen.has(k)) out.push(`${legLabel(seen.get(k).spec)} and ${legLabel(leg.spec)} are in the same market. Books won't take both in one parlay.`);
    seen.set(k, leg);
  }
  return out;
}

// ---- probability ---------------------------------------------------------------

const isIdentity = (r) => r.every((row, i) => row.every((x, j) => Math.abs(x - (i === j ? 1 : 0)) <= 1e-8 + 1e-5 * (i === j ? 1 : 0)));

export function jointWinProb(probs, r) {
  if (probs.length === 1) return probs[0];
  if (isIdentity(r)) return probs.reduce((a, b) => a * b, 1);
  const z = probs.map((p) => normPpf(Math.min(Math.max(p, 1e-9), 1 - 1e-9)));
  return mvnCdf(z, nearestCorrelation(r));
}

export function sameGameGroups(legs) {
  const groups = new Map();
  legs.forEach((leg, i) => {
    if (!groups.has(leg.spec.event_id)) groups.set(leg.spec.event_id, []);
    groups.get(leg.spec.event_id).push(i);
  });
  return [...groups.values()];
}

export const pairKey = (a, b) => [a, b].sort().join("~");

/** Fair probability all legs win. `rho` is a Map pairKey -> rho, or one number for every same-game pair. */
export function parlayProb(legs, rho) {
  if (legs.some((l) => l.fair_prob == null)) return null;
  let total = 1.0;
  for (const group of sameGameGroups(legs)) {
    const k = group.length;
    const r = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const val = typeof rho === "number" ? rho
          : rho.get(pairKey(legId(legs[group[a]].spec), legId(legs[group[b]].spec))) ?? 0.0;
        r[a][b] = r[b][a] = Math.min(Math.max(val, RHO_MIN), RHO_MAX);
      }
    }
    total *= jointWinProb(group.map((i) => legs[i].fair_prob), r);
  }
  return total;
}

// ---- money -------------------------------------------------------------------------

/** A profit boost multiplies the winnings, not the stake. */
export const boosted = (decimal, boost) => 1 + (decimal - 1) * (1 + boost);

const round2 = (x) => Math.round(x * 100) / 100;

export function metrics(p, decimal, { boost, kellyMult, bankroll, maxStakePct }) {
  const d = boosted(decimal, boost);
  const ev = p * d - 1;
  const full = Math.max(0.0, ev / (d - 1));
  const f = Math.min(full * kellyMult, maxStakePct);
  const growth = f > 0 ? p * Math.log1p(f * (d - 1)) + (1 - p) * Math.log1p(-f) : 0.0;
  const need = (1 / p - 1) / (decimal - 1) - 1; // boost at which EV hits zero
  return {
    decimal,
    boosted_decimal: d,
    win_prob: p,
    fair_decimal: 1 / p,
    ev,
    kelly_full: full,
    stake_frac: f,
    stake: round2(f * bankroll),
    to_win: round2(f * bankroll * (d - 1)),
    growth,
    min_boost: Math.max(0.0, need),
  };
}

/** Uniform same-game correlation at which the quoted price is exactly fair. */
function breakEvenRho(legs, decimal, boost) {
  const d = boosted(decimal, boost);
  const ev = (r) => parlayProb(legs, r) * d - 1;
  let lo = RHO_MIN, hi = RHO_MAX;
  if (ev(hi) < 0) return { rho: null, note: "Not +EV at any plausible correlation" };
  if (ev(lo) > 0) return { rho: null, note: "+EV even if the legs were negatively correlated" };
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (ev(mid) > 0) hi = mid; else lo = mid;
  }
  return { rho: (lo + hi) / 2, note: null };
}

/**
 * `book` is where the user wants to place the parlay; it's priced (and
 * reported as `chosen`) even if another book pays more. `best` is kept as a reference.
 */
export function analyze(legs, {
  rho = new Map(), bettable, boost = 0.0, sgpQuote = null, kellyMult = 0.25, bankroll = 1000.0, maxStakePct = 0.01, book = null,
}) {
  if (!legs.length) throw new ParlayError("Add at least one leg");
  const money = { boost, kellyMult, bankroll, maxStakePct };
  const errors = conflicts(legs);
  const groups = sameGameGroups(legs).filter((g) => g.length > 1);
  const isSgp = groups.length > 0;
  const p = parlayProb(legs, rho);
  const pIndep = parlayProb(legs, 0.0);
  const warnings = [];
  if (p == null) warnings.push("Some legs have no fair price (too few books post that exact line), so EV can't be computed.");
  for (const leg of legs) {
    if (leg.fair_thin) {
      const n = leg.fair_books;
      warnings.push(`Fair price for ${legLabel(leg.spec)} comes from only ${n} book${n !== 1 ? "s" : ""} posting that exact line, so treat its EV as rough.`);
    }
  }
  if (isSgp && !sgpQuote) {
    warnings.push("Contains same-game legs. Books price these as SGPs with their own correlation adjustment, "
      + "so enter the book's quoted SGP price to get an exact EV.");
  }

  const chosenBook = book;
  const rowBooks = [...new Set([...bettable, ...(chosenBook ? [chosenBook] : [])])].sort();
  let rows = rowBooks.map((bk) => {
    const missing = legs.filter((leg) => !leg.prices.has(bk));
    const straight = missing.length ? null : legs.reduce((acc, leg) => acc * leg.prices.get(bk).price, 1);
    let decimal = straight;
    if (isSgp) decimal = sgpQuote && sgpQuote[0] === bk ? sgpQuote[1] : null; // the typed quote is what the book offers
    const row = {
      book: bk, book_title: bookTitle(bk),
      missing: missing.map((leg) => ({
        label: legLabel(leg.spec), spread: isSpread(leg.spec.market),
        alt: leg.alternates.has(bk) ? { point: leg.alternates.get(bk).point ?? null, price: leg.alternates.get(bk).price } : null,
      })),
      straight_decimal: straight,
      decimal,
      links: legs.filter((leg) => leg.prices.has(bk)).map((leg) => leg.prices.get(bk).link ?? null),
    };
    if (decimal && p) Object.assign(row, metrics(p, decimal, money));
    return row;
  });
  const priced = rows.filter((r) => "ev" in r);
  const best = priced.reduce((acc, r) => (acc == null || r.ev > acc.ev ? r : acc), null);
  const chosen = rows.find((r) => r.book === chosenBook) ?? null;
  const sortKey = (r) => [r.decimal == null ? 1 : 0, -("ev" in r ? r.ev : -9), -(r.decimal ?? 0)];
  rows = [...rows].sort((a, b) => {
    const x = sortKey(a), y = sortKey(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });

  // Line-shopped reference: best price per leg across books (not placeable as one ticket).
  let shopped = null;
  if (!isSgp && legs.every((leg) => [...leg.prices.keys()].some((b) => bettable.has(b))) && p) {
    const d = legs.reduce((acc, leg) => acc * Math.max(...[...leg.prices].filter(([b]) => bettable.has(b)).map(([, pr]) => pr.price)), 1);
    shopped = metrics(p, d, money);
  }

  // What each leg adds: EV with and without it, at the chosen book when it
  // offers every leg, otherwise at the best book.
  const basis = chosen && "ev" in chosen ? chosen : best;
  const contributions = [];
  if (basis && !isSgp && legs.length > 1) {
    legs.forEach((leg, i) => {
      const rest = [...legs.slice(0, i), ...legs.slice(i + 1)];
      const pRest = parlayProb(rest, rho);
      const dLeg = leg.prices.get(basis.book).price;
      const without = pRest ? metrics(pRest, basis.decimal / dLeg, money).ev : null;
      contributions.push({
        id: legId(leg.spec), label: legLabel(leg.spec), price: dLeg,
        leg_ev: leg.fair_prob ? leg.fair_prob * dLeg - 1 : null,
        parlay_ev_without: without,
      });
    });
  }

  let sgp = null;
  if (isSgp && legs.every((leg) => leg.fair_prob)) {
    const curve = RHO_GRID.map((r) => ({ rho: r, fair_decimal: 1 / parlayProb(legs, r) }));
    sgp = { groups: groups.map((g) => g.map((i) => legId(legs[i].spec))), curve, break_even: null };
    if (sgpQuote) {
      sgp.break_even = breakEvenRho(legs, sgpQuote[1], boost);
      for (const c of curve) c.ev = boosted(sgpQuote[1], boost) / c.fair_decimal - 1;
    }
  }

  return {
    legs: legs.map((leg) => legDict(leg, bettable)),
    errors,
    warnings,
    is_sgp: isSgp,
    fair_prob: p,
    fair_decimal: p ? 1 / p : null,
    fair_prob_independent: pIndep,
    books: rows,
    best,
    chosen,
    shopped,
    contributions,
    contributions_book: contributions.length ? basis.book : null,
    sgp,
  };
}

// ---- generator --------------------------------------------------------------------

/**
 * Best cross-game parlays at each book, one leg per game (so legs are
 * independent and the book's price is the product of its leg prices).
 * Beam search over each book's best legs, scored by boosted EV or by
 * expected log-growth at the capped fractional-Kelly stake.
 */
export function generate(snapshots, {
  bettable, reference, method, minBooks, now, kind = "all", minLegs = 2, maxLegs = 4, minDecimal = 1.0,
  maxDecimal = 1e9, minLegEv = 0.0, boost = 0.0, sort = "ev", kellyMult = 0.25, bankroll = 1000.0,
  maxStakePct = 0.01, maxReuse = 3, limit = 50, poolSize = 40, beam = 400,
}) {
  const money = { boost, kellyMult, bankroll, maxStakePct };
  const pools = new Map();
  for (const [sport, snap] of snapshots) {
    const prices = kind === "all" ? snap.prices : snap.prices.filter((p) => isProp(p.market) === (kind === "props"));
    for (const { key, books } of groupPrices(snap.events, prices).values()) {
      const event = snap.events.get(key.event_id);
      if (!isUpcoming(event, now)) continue;
      for (const [bk, outcomes] of books) {
        if (bk === reference || !bettable.has(bk)) continue;
        const fair = fairForLine(books, { method, reference, minBooks, exclude: bk });
        if (!fair) continue;
        for (const [outcome, price] of outcomes) {
          const prob = fair.probs.get(outcome);
          if (prob * price.price - 1 < minLegEv) continue;
          const spec = { sport, event_id: event.id, market: key.market, outcome, point: price.point ?? null, description: key.description, book: bk };
          if (!pools.has(bk)) pools.set(bk, []);
          pools.get(bk).push({ spec, event, price, p: prob, ev: prob * price.price - 1 });
        }
      }
    }
  }

  const score = (m) => (sort === "growth" ? m.growth : m.ev);
  const found = [];
  for (const [bk, all] of pools) {
    const cands = [...all].sort((a, b) => b.ev - a.ev).slice(0, poolSize);
    let frontier = cands.map((c, i) => [[i], c.p, c.price.price]);
    for (let size = 1; size <= maxLegs; size++) {
      if (size >= minLegs) {
        for (const [combo, p, d] of frontier) {
          if (minDecimal <= d && d <= maxDecimal) {
            const m = metrics(p, d, money);
            if (m.ev > 0) found.push([bk, combo, m, cands]);
          }
        }
      }
      if (size === maxLegs) break;
      const next = [];
      for (const [combo, p, d] of frontier) {
        const used = new Set(combo.map((i) => cands[i].event.id));
        for (let j = combo[combo.length - 1] + 1; j < cands.length; j++) {
          const c = cands[j];
          if (!used.has(c.event.id) && d * c.price.price <= maxDecimal) next.push([[...combo, j], p * c.p, d * c.price.price]);
        }
      }
      const scored = next.map((t) => [t, score(metrics(t[1], t[2], money))]);
      scored.sort((a, b) => b[1] - a[1]);
      frontier = scored.slice(0, beam).map(([t]) => t);
    }
  }

  // Rank, then keep the list varied: each (book, leg) may appear in at most maxReuse parlays.
  const ranked = found.map((t) => [t, score(t[2])]).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const usage = new Map();
  const out = [];
  for (const [bk, combo, m, cands] of ranked) {
    const keys = combo.map((i) => `${bk}\u0000${legId(cands[i].spec)}`);
    if (keys.some((k) => (usage.get(k) ?? 0) >= maxReuse)) continue;
    for (const k of keys) usage.set(k, (usage.get(k) ?? 0) + 1);
    out.push({ book: bk, book_title: bookTitle(bk), legs: combo.map((i) => candDict(cands[i])), ...m });
    if (out.length >= limit) break;
  }
  return out;
}

function candDict(c) {
  const s = c.spec, e = c.event;
  return {
    id: legId(s),
    spec: { ...specOut(s), book: s.book ?? null },
    label: selectionLabel(c.price),
    event_id: e.id, event: eventName(e), home: e.home, away: e.away,
    commence_time: isoformat(e.commence_time), preseason: isPreseason(e.league),
    is_prop: isProp(s.market), player: s.description ?? null, market_title: marketTitle(s.market),
    outcome: s.outcome, point: s.point ?? null,
    price: c.price.price, fair_prob: c.p, leg_ev: c.ev, link: c.price.link ?? null,
  };
}
