"""Parlay pricing and generation.

Fair probability of a parlay = product over games of each game's joint win
probability. Legs in different games are independent. Legs in the same game
(an SGP) are joined with a Gaussian copula: leg i wins when a latent standard
normal Z_i <= Phi^-1(p_i), with the Z's correlated by the user's rho per pair.

Straight (cross-game) parlays pay the product of the book's leg prices, so their
EV is exact. Books price SGPs with their own correlation model, which we can't
see, so an SGP's EV needs the book's quoted price; without it we report fair
odds across a range of correlations and the break-even correlation.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from scipy.stats import multivariate_normal, norm

from .config import book_title, is_preseason, is_prop, market_title
from .fair import fair_for_line
from .models import (
    Event, LineKey, Price, group_prices, is_moneyline, is_spread, is_upcoming, selection_label,
)

RHO_MIN, RHO_MAX = -0.5, 0.95
RHO_GRID = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]

Snapshots = dict[str, tuple[dict[str, Event], list[Price]]]  # sport -> (events, prices)


class ParlayError(ValueError):
    pass


# ---- legs -----------------------------------------------------------------------

@dataclass(frozen=True)
class LegSpec:
    sport: str
    event_id: str
    market: str
    outcome: str
    point: float | None = None
    description: str | None = None

    @property
    def id(self) -> str:
        pt = "" if self.point is None else f"{self.point:g}"
        return f"{self.event_id}|{self.market}|{self.description or ''}|{self.outcome}|{pt}"

    def line(self, event: Event) -> float | None:
        if is_moneyline(self.market):
            return None
        if is_spread(self.market) and self.point is not None:
            return self.point if self.outcome == event.home else -self.point
        return self.point


@dataclass
class PricedLeg:
    spec: LegSpec
    event: Event
    fair_prob: float | None
    fair_source: str | None
    fair_books: int
    prices: dict[str, Price]  # book -> price at exactly this line
    alternates: dict[str, Price]  # book -> same selection at a different line
    fair_thin: bool = False  # fair price from fewer books than min_books (a hand-picked off-market line)

    @property
    def label(self) -> str:
        s = self.spec
        return selection_label(Price(s.event_id, "", s.market, s.outcome, 2.0, s.point, s.description))

    def to_dict(self, bettable: set[str]) -> dict:
        best = max((p for b, p in self.prices.items() if b in bettable), key=lambda p: p.price, default=None)
        s, e = self.spec, self.event
        return {
            "id": s.id,
            "spec": {"sport": s.sport, "event_id": s.event_id, "market": s.market, "outcome": s.outcome,
                     "point": s.point, "description": s.description},
            "label": self.label,
            "event": e.name, "home": e.home, "away": e.away,
            "commence_time": e.commence_time.isoformat(),
            "preseason": is_preseason(e.league),
            "is_prop": is_prop(s.market), "player": s.description, "market_title": market_title(s.market),
            "fair_prob": self.fair_prob,
            "fair_price": 1 / self.fair_prob if self.fair_prob else None,
            "fair_source": self.fair_source, "fair_books": self.fair_books, "fair_thin": self.fair_thin,
            "books": {b: {"price": p.price, "point": p.point, "link": p.link} for b, p in self.prices.items()},
            "alternates": {b: {"price": p.price, "point": p.point} for b, p in self.alternates.items()},
            "best_book": best.book if best else None,
            "best_price": best.price if best else None,
            "best_ev": self.fair_prob * best.price - 1 if best and self.fair_prob else None,
        }


def price_legs(
    specs: list[LegSpec], snapshots: Snapshots, *, method: str, reference: str, min_books: int
) -> list[PricedLeg]:
    grouped = {sport: group_prices(events, prices) for sport, (events, prices) in snapshots.items()}
    by_selection: dict[tuple, list[Price]] = defaultdict(list)
    for _, prices in snapshots.values():
        for p in prices:
            by_selection[(p.event_id, p.market, p.description, p.outcome)].append(p)

    legs = []
    for s in specs:
        events = snapshots.get(s.sport, ({}, []))[0]
        event = events.get(s.event_id)
        if event is None:
            raise ParlayError(f"{s.outcome} ({s.market}) is no longer in the latest snapshot")
        books = grouped[s.sport].get(LineKey(s.event_id, s.market, s.description, s.line(event)), {})
        fair = fair_for_line(books, method=method, reference=reference, min_books=min_books) if books else None
        thin = False
        if fair is None and books:
            # A hand-picked line that few books post: de-vig whatever books do post it, flagged as rough.
            fair = fair_for_line(books, method=method, reference=reference, min_books=1)
            thin = fair is not None
        prices = {b: outs[s.outcome] for b, outs in books.items() if s.outcome in outs}
        alternates: dict[str, Price] = {}
        for p in by_selection[(s.event_id, s.market, s.description, s.outcome)]:
            if p.book not in prices and p.point != s.point:
                cur = alternates.get(p.book)
                if cur is None or abs((p.point or 0) - (s.point or 0)) < abs((cur.point or 0) - (s.point or 0)):
                    alternates[p.book] = p
        legs.append(PricedLeg(
            spec=s, event=event,
            fair_prob=fair.probs.get(s.outcome) if fair else None,
            fair_source=fair.source if fair else None, fair_books=fair.n_books if fair else 0,
            prices=prices, alternates=alternates, fair_thin=thin,
        ))
    return legs


def conflicts(legs: list[PricedLeg]) -> list[str]:
    """Combinations no book will take in one parlay."""
    seen: dict[tuple, PricedLeg] = {}
    out = []
    for leg in legs:
        key = (leg.spec.event_id, leg.spec.market, leg.spec.description)
        if key in seen:
            out.append(f"{seen[key].label} and {leg.label} are in the same market. Books won't take both in one parlay.")
        seen[key] = leg
    return out


# ---- probability ---------------------------------------------------------------

def _nearest_correlation(r: np.ndarray) -> np.ndarray:
    """Clip negative eigenvalues so a user-entered matrix is a valid correlation matrix."""
    w, v = np.linalg.eigh(r)
    fixed = v @ np.diag(np.clip(w, 1e-6, None)) @ v.T
    d = np.sqrt(np.diag(fixed))
    return fixed / np.outer(d, d)


def joint_win_prob(probs: list[float], r: np.ndarray) -> float:
    if len(probs) == 1:
        return probs[0]
    if np.allclose(r, np.eye(len(probs))):
        return float(np.prod(probs))
    z = norm.ppf(np.clip(probs, 1e-9, 1 - 1e-9))
    mvn = multivariate_normal(mean=np.zeros(len(probs)), cov=_nearest_correlation(r), allow_singular=True, seed=7)
    return float(mvn.cdf(z))


def same_game_groups(legs: list[PricedLeg]) -> list[list[int]]:
    groups: dict[str, list[int]] = defaultdict(list)
    for i, leg in enumerate(legs):
        groups[leg.spec.event_id].append(i)
    return list(groups.values())


def parlay_prob(legs: list[PricedLeg], rho: dict[frozenset, float] | float) -> float | None:
    """Fair probability all legs win. `rho` is per leg-id pair, or one value
    applied to every same-game pair."""
    if any(leg.fair_prob is None for leg in legs):
        return None
    total = 1.0
    for group in same_game_groups(legs):
        k = len(group)
        r = np.eye(k)
        for a in range(k):
            for b in range(a + 1, k):
                if isinstance(rho, dict):
                    val = rho.get(frozenset((legs[group[a]].spec.id, legs[group[b]].spec.id)), 0.0)
                else:
                    val = rho
                r[a, b] = r[b, a] = min(max(val, RHO_MIN), RHO_MAX)
        total *= joint_win_prob([legs[i].fair_prob for i in group], r)
    return total


# ---- money -------------------------------------------------------------------------

def boosted(decimal: float, boost: float) -> float:
    """A profit boost multiplies the winnings, not the stake."""
    return 1 + (decimal - 1) * (1 + boost)


def metrics(p: float, decimal: float, *, boost: float, kelly_mult: float, bankroll: float, max_stake_pct: float) -> dict:
    d = boosted(decimal, boost)
    ev = p * d - 1
    full = max(0.0, ev / (d - 1))
    f = min(full * kelly_mult, max_stake_pct)
    growth = p * math.log1p(f * (d - 1)) + (1 - p) * math.log1p(-f) if f > 0 else 0.0
    need = (1 / p - 1) / (decimal - 1) - 1  # boost at which EV hits zero
    return {
        "decimal": decimal,
        "boosted_decimal": d,
        "win_prob": p,
        "fair_decimal": 1 / p,
        "ev": ev,
        "kelly_full": full,
        "stake_frac": f,
        "stake": round(f * bankroll, 2),
        "to_win": round(f * bankroll * (d - 1), 2),
        "growth": growth,
        "min_boost": max(0.0, need),
    }


def _break_even_rho(legs: list[PricedLeg], decimal: float, boost: float) -> dict:
    """Uniform same-game correlation at which the quoted price is exactly fair."""
    d = boosted(decimal, boost)
    ev = lambda r: parlay_prob(legs, r) * d - 1  # noqa: E731
    lo, hi = RHO_MIN, RHO_MAX
    if ev(hi) < 0:
        return {"rho": None, "note": "Not +EV at any plausible correlation"}
    if ev(lo) > 0:
        return {"rho": None, "note": "+EV even if the legs were negatively correlated"}
    for _ in range(30):
        mid = (lo + hi) / 2
        if ev(mid) > 0:
            hi = mid
        else:
            lo = mid
    return {"rho": (lo + hi) / 2, "note": None}


def analyze(
    legs: list[PricedLeg],
    *,
    rho: dict[frozenset, float],
    bettable: set[str],
    boost: float = 0.0,
    sgp_quote: tuple[str, float] | None = None,
    kelly_mult: float = 0.25,
    bankroll: float = 1000.0,
    max_stake_pct: float = 0.01,
    book: str | None = None,
) -> dict:
    """`book` is where the user wants to place the parlay; it's priced (and
    reported as `chosen`) even if another book pays more. `best` is kept as a
    reference."""
    if not legs:
        raise ParlayError("Add at least one leg")
    money = dict(boost=boost, kelly_mult=kelly_mult, bankroll=bankroll, max_stake_pct=max_stake_pct)
    errors = conflicts(legs)
    groups = [g for g in same_game_groups(legs) if len(g) > 1]
    is_sgp = bool(groups)
    p = parlay_prob(legs, rho)
    p_indep = parlay_prob(legs, 0.0)
    warnings = []
    if p is None:
        warnings.append("Some legs have no fair price (too few books post that exact line), so EV can't be computed.")
    for leg in legs:
        if leg.fair_thin:
            n = leg.fair_books
            warnings.append(f"Fair price for {leg.label} comes from only {n} book{'s' if n != 1 else ''} posting "
                            "that exact line, so treat its EV as rough.")
    if is_sgp and not sgp_quote:
        warnings.append("Contains same-game legs. Books price these as SGPs with their own correlation adjustment, "
                        "so enter the book's quoted SGP price to get an exact EV.")

    chosen_book = book
    rows = []
    for book in sorted(bettable | ({chosen_book} if chosen_book else set())):
        missing = [leg for leg in legs if book not in leg.prices]
        straight = math.prod(leg.prices[book].price for leg in legs) if not missing else None
        decimal = straight
        if is_sgp:  # the typed quote is what the book offers, even if our snapshot lacks a leg there
            decimal = sgp_quote[1] if sgp_quote and sgp_quote[0] == book else None
        row = {
            "book": book, "book_title": book_title(book),
            "missing": [{"label": leg.label, "spread": is_spread(leg.spec.market), "alt": (
                {"point": leg.alternates[book].point, "price": leg.alternates[book].price}
                if book in leg.alternates else None)} for leg in missing],
            "straight_decimal": straight,
            "decimal": decimal,
            "links": [leg.prices[book].link for leg in legs if book in leg.prices],
        }
        if decimal and p:
            row.update(metrics(p, decimal, **money))
        rows.append(row)
    priced = [r for r in rows if "ev" in r]
    best = max(priced, key=lambda r: r["ev"], default=None)
    chosen = next((r for r in rows if r["book"] == chosen_book), None)
    rows.sort(key=lambda r: (r["decimal"] is None, -(r.get("ev") if "ev" in r else -9), -(r["decimal"] or 0)))

    # Line-shopped reference: best price per leg across books (not placeable as one ticket).
    shopped = None
    if not is_sgp and all(any(b in bettable for b in leg.prices) for leg in legs) and p:
        d = math.prod(max(pr.price for b, pr in leg.prices.items() if b in bettable) for leg in legs)
        shopped = metrics(p, d, **money)

    # What each leg adds: EV of the parlay with and without it, at the chosen
    # book when it offers every leg, otherwise at the best book.
    basis = chosen if chosen and "ev" in chosen else best
    contributions = []
    if basis and not is_sgp and len(legs) > 1:
        for i, leg in enumerate(legs):
            rest = legs[:i] + legs[i + 1:]
            p_rest = parlay_prob(rest, rho)
            d_leg = leg.prices[basis["book"]].price
            without = metrics(p_rest, basis["decimal"] / d_leg, **money)["ev"] if p_rest else None
            contributions.append({
                "id": leg.spec.id, "label": leg.label, "price": d_leg,
                "leg_ev": leg.fair_prob * d_leg - 1 if leg.fair_prob else None,
                "parlay_ev_without": without,
            })

    sgp = None
    if is_sgp and all(leg.fair_prob for leg in legs):
        curve = [{"rho": r, "fair_decimal": 1 / parlay_prob(legs, r)} for r in RHO_GRID]
        sgp = {"groups": [[legs[i].spec.id for i in g] for g in groups], "curve": curve, "break_even": None}
        if sgp_quote:
            sgp["break_even"] = _break_even_rho(legs, sgp_quote[1], boost)
            for c in curve:
                c["ev"] = boosted(sgp_quote[1], boost) / c["fair_decimal"] - 1

    return {
        "legs": [leg.to_dict(bettable) for leg in legs],
        "errors": errors,
        "warnings": warnings,
        "is_sgp": is_sgp,
        "fair_prob": p,
        "fair_decimal": 1 / p if p else None,
        "fair_prob_independent": p_indep,
        "books": rows,
        "best": best,
        "chosen": chosen,
        "shopped": shopped,
        "contributions": contributions,
        "contributions_book": basis["book"] if contributions else None,
        "sgp": sgp,
    }


# ---- generator --------------------------------------------------------------------

@dataclass
class _Cand:
    spec: LegSpec
    event: Event
    price: Price
    p: float
    ev: float


def generate(
    snapshots: Snapshots,
    *,
    bettable: set[str],
    reference: str,
    method: str,
    min_books: int,
    now: datetime,
    kind: str = "all",
    min_legs: int = 2,
    max_legs: int = 4,
    min_decimal: float = 1.0,
    max_decimal: float = 1e9,
    min_leg_ev: float = 0.0,
    boost: float = 0.0,
    sort: str = "ev",
    kelly_mult: float = 0.25,
    bankroll: float = 1000.0,
    max_stake_pct: float = 0.01,
    max_reuse: int = 3,
    limit: int = 50,
    pool_size: int = 40,
    beam: int = 400,
) -> list[dict]:
    """Best cross-game parlays at each book, one leg per game (so legs are
    independent and the book's price is the product of its leg prices).
    Beam search over each book's best legs, scored by boosted EV or by
    expected log-growth at the capped fractional-Kelly stake."""
    money = dict(boost=boost, kelly_mult=kelly_mult, bankroll=bankroll, max_stake_pct=max_stake_pct)
    pools: dict[str, list[_Cand]] = defaultdict(list)
    for sport, (events, prices) in snapshots.items():
        if kind != "all":
            prices = [p for p in prices if is_prop(p.market) == (kind == "props")]
        for key, books in group_prices(events, prices).items():
            event = events[key.event_id]
            if not is_upcoming(event, now):
                continue
            fair = fair_for_line(books, method=method, reference=reference, min_books=min_books)
            if fair is None:
                continue
            for book, outcomes in books.items():
                if book == reference or book not in bettable:
                    continue
                for outcome, price in outcomes.items():
                    prob = fair.probs[outcome]
                    if prob * price.price - 1 < min_leg_ev:
                        continue
                    spec = LegSpec(sport, event.id, key.market, outcome, price.point, key.description)
                    pools[book].append(_Cand(spec, event, price, prob, prob * price.price - 1))

    def score(m: dict) -> float:
        return m["growth"] if sort == "growth" else m["ev"]

    found = []
    for book, cands in pools.items():
        cands = sorted(cands, key=lambda c: c.ev, reverse=True)[:pool_size]
        frontier = [((i,), c.p, c.price.price) for i, c in enumerate(cands)]
        for size in range(1, max_legs + 1):
            if size >= min_legs:
                for combo, p, d in frontier:
                    if min_decimal <= d <= max_decimal:
                        m = metrics(p, d, **money)
                        if m["ev"] > 0:
                            found.append((book, combo, m, cands))
            if size == max_legs:
                break
            nxt = []
            for combo, p, d in frontier:
                used = {cands[i].event.id for i in combo}
                for j in range(combo[-1] + 1, len(cands)):
                    c = cands[j]
                    if c.event.id not in used and d * c.price.price <= max_decimal:
                        nxt.append((combo + (j,), p * c.p, d * c.price.price))
            nxt.sort(key=lambda t: score(metrics(t[1], t[2], **money)), reverse=True)
            frontier = nxt[:beam]

    # Rank, then keep the list varied: each (book, leg) may appear in at most max_reuse parlays.
    found.sort(key=lambda t: score(t[2]), reverse=True)
    usage: dict[tuple, int] = defaultdict(int)
    out = []
    for book, combo, m, cands in found:
        keys = [(book, cands[i].spec.id) for i in combo]
        if any(usage[k] >= max_reuse for k in keys):
            continue
        for k in keys:
            usage[k] += 1
        out.append({
            "book": book,
            "book_title": book_title(book),
            "legs": [_cand_dict(cands[i]) for i in combo],
            **m,
        })
        if len(out) >= limit:
            break
    return out


def _cand_dict(c: _Cand) -> dict:
    s, e = c.spec, c.event
    return {
        "id": s.id,
        "spec": {"sport": s.sport, "event_id": s.event_id, "market": s.market, "outcome": s.outcome,
                 "point": s.point, "description": s.description},
        "label": selection_label(c.price),
        "event_id": e.id, "event": e.name, "home": e.home, "away": e.away,
        "commence_time": e.commence_time.isoformat(), "preseason": is_preseason(e.league),
        "is_prop": is_prop(s.market), "player": s.description, "market_title": market_title(s.market),
        "outcome": s.outcome, "point": s.point,
        "price": c.price.price, "fair_prob": c.p, "leg_ev": c.ev, "link": c.price.link,
    }
