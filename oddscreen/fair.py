"""Fair (no-vig) probabilities for one line: Pinnacle first, else a consensus."""
from __future__ import annotations

import statistics
from dataclasses import dataclass

from .config import feed_of, source_weight
from .odds_math import decimal_to_american, devig, overround
from .models import Price

FAIR_MODES = ("auto", "pinnacle", "consensus")


@dataclass(frozen=True)
class FairLine:
    probs: dict[str, float]  # outcome -> fair probability
    source: str  # "pinnacle" | "consensus"
    n_books: int  # independent sources behind the price
    hold: float  # reference hold (weighted mean hold for consensus)
    width: float | None = None  # market width in cents (median across sources for a consensus)


def market_width(decimals: list[float]) -> float | None:
    """Gap between the two sides in American-odds cents: -110/-110 is 20,
    +125/-165 is 40. Wide markets mean the book is unsure of its own price."""
    if len(decimals) != 2:
        return None
    a, b = (decimal_to_american(d) for d in decimals)
    if a < 0 and b < 0:
        return -a - b - 200
    if a > 0 and b > 0:
        return 200 - a - b
    neg, pos = (a, b) if a < 0 else (b, a)
    return -neg - pos


def fair_for_line(
    books: dict[str, dict[str, Price]],
    *,
    method: str,
    reference: str,
    min_books: int = 3,
    exclude: str | None = None,
    mode: str = "auto",
    weighted: bool = True,
) -> FairLine | None:
    """Fair probabilities for one line.

    mode "auto": de-vig the reference book at this exact line; if it doesn't
    post it, fall back to the consensus. "pinnacle": the reference book only
    (None when it doesn't post the line). "consensus": always the consensus,
    with the reference book as one of the voters.

    Consensus: weighted average of the books' de-vigged probabilities, one vote
    per odds source (books sharing a pricing engine count once), weighted by
    how sharp that source is for this market type (`weighted`), leaving out
    `exclude` and its source-mates, since a book can't vouch for its own price.
    Needs `min_books` independent sources with both sides posted."""
    if mode not in FAIR_MODES:
        raise ValueError(f"fair mode must be one of {FAIR_MODES}")
    outcomes = sorted(set().union(*(m.keys() for m in books.values())))
    if len(outcomes) < 2:
        return None

    if mode != "consensus":
        ref = books.get(reference)
        if ref is not None and sorted(ref) == outcomes:
            decimals = [ref[o].price for o in outcomes]
            return FairLine(dict(zip(outcomes, devig(decimals, method))), reference, 1, overround(decimals),
                            market_width(decimals))
        if mode == "pinnacle":
            return None

    market = next(p.market for m in books.values() for p in m.values())
    skip = feed_of(exclude) if exclude else None
    votes: dict[str, list[tuple[list[float], float, float | None]]] = {}
    for book, m in books.items():
        if sorted(m) != outcomes or feed_of(book) == skip:
            continue
        decimals = [m[o].price for o in outcomes]
        votes.setdefault(feed_of(book), []).append((devig(decimals, method), overround(decimals), market_width(decimals)))
    if len(votes) < min_books:
        return None
    sums = dict.fromkeys(outcomes, 0.0)
    holds = total_w = 0.0
    widths = []
    for source, vs in votes.items():
        w = source_weight(source, market) if weighted else 1.0
        k = len(vs)
        for i, o in enumerate(outcomes):
            sums[o] += w * sum(v[0][i] for v in vs) / k
        holds += w * sum(v[1] for v in vs) / k
        total_w += w
        widths += [v[2] for v in vs if v[2] is not None]
    return FairLine({o: s / total_w for o, s in sums.items()}, "consensus", len(votes), holds / total_w,
                    statistics.median(widths) if widths else None)
