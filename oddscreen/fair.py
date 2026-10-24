"""Fair (no-vig) probabilities for one line: Pinnacle first, else a consensus."""
from __future__ import annotations

from dataclasses import dataclass

from .config import feed_of
from .odds_math import devig, overround
from .models import Price


FAIR_MODES = ("auto", "pinnacle", "consensus")


@dataclass(frozen=True)
class FairLine:
    probs: dict[str, float]  # outcome -> fair probability
    source: str  # "pinnacle" | "consensus"
    n_books: int  # independent sources behind the price
    hold: float  # reference hold (mean hold for consensus)


def fair_for_line(
    books: dict[str, dict[str, Price]],
    *,
    method: str,
    reference: str,
    min_books: int = 3,
    exclude: str | None = None,
    mode: str = "auto",
) -> FairLine | None:
    """Fair probabilities for one line.

    mode "auto": de-vig the reference book at this exact line; if it doesn't
    post it, fall back to the consensus. "pinnacle": the reference book only
    (None when it doesn't post the line). "consensus": always the consensus,
    with the reference book as one of the voters.

    Consensus: average of the books' de-vigged probabilities, one vote per odds
    feed (books sharing a feed count once), leaving out `exclude` and its
    feed-mates, since a book can't vouch for its own price. Needs `min_books`
    independent sources with both sides posted."""
    if mode not in FAIR_MODES:
        raise ValueError(f"fair mode must be one of {FAIR_MODES}")
    outcomes = sorted(set().union(*(m.keys() for m in books.values())))
    if len(outcomes) < 2:
        return None

    if mode != "consensus":
        ref = books.get(reference)
        if ref is not None and sorted(ref) == outcomes:
            decimals = [ref[o].price for o in outcomes]
            return FairLine(dict(zip(outcomes, devig(decimals, method))), reference, 1, overround(decimals))
        if mode == "pinnacle":
            return None

    skip = feed_of(exclude) if exclude else None
    votes: dict[str, list[tuple[list[float], float]]] = {}
    for book, m in books.items():
        if sorted(m) != outcomes or feed_of(book) == skip:
            continue
        decimals = [m[o].price for o in outcomes]
        votes.setdefault(feed_of(book), []).append((devig(decimals, method), overround(decimals)))
    if len(votes) < min_books:
        return None
    sums = dict.fromkeys(outcomes, 0.0)
    holds = 0.0
    for vs in votes.values():
        k = len(vs)
        for i, o in enumerate(outcomes):
            sums[o] += sum(v[0][i] for v in vs) / k
        holds += sum(v[1] for v in vs) / k
    n = len(votes)
    return FairLine({o: s / n for o, s in sums.items()}, "consensus", n, holds / n)
