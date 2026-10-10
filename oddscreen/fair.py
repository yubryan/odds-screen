"""Fair (no-vig) probabilities for one line: Pinnacle first, else a consensus."""
from __future__ import annotations

from dataclasses import dataclass

from .odds_math import devig, overround
from .models import Price


@dataclass(frozen=True)
class FairLine:
    probs: dict[str, float]  # outcome -> fair probability
    source: str  # "pinnacle" | "consensus"
    n_books: int
    hold: float  # reference hold (mean hold for consensus)


def fair_for_line(
    books: dict[str, dict[str, Price]],
    *,
    method: str,
    reference: str,
    min_books: int = 3,
) -> FairLine | None:
    """De-vig the reference book at this exact line; if it doesn't post this
    line, average the de-vigged probabilities of every book that does (needs
    `min_books` complete two-sided markets)."""
    outcomes = sorted(set().union(*(m.keys() for m in books.values())))
    if len(outcomes) < 2:
        return None

    ref = books.get(reference)
    if ref is not None and sorted(ref) == outcomes:
        decimals = [ref[o].price for o in outcomes]
        return FairLine(dict(zip(outcomes, devig(decimals, method))), reference, 1, overround(decimals))

    complete = [m for m in books.values() if sorted(m) == outcomes]
    if len(complete) < min_books:
        return None
    sums = dict.fromkeys(outcomes, 0.0)
    holds = 0.0
    for m in complete:
        decimals = [m[o].price for o in outcomes]
        holds += overround(decimals)
        for o, p in zip(outcomes, devig(decimals, method)):
            sums[o] += p
    n = len(complete)
    return FairLine({o: s / n for o, s in sums.items()}, "consensus", n, holds / n)
