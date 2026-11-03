"""Quotes far out of line with every other book at the same line, e.g. a NoVig
(exchange) Under at -1000 while the books sit near -110: a thin or stale order,
not a price. They're left out of every tool so they can't skew a consensus,
take "best price", or show up as a fake +EV bet."""
from __future__ import annotations

import math
import statistics

from .models import Event, Price, group_prices

# Log-odds gap from the other books' median at which a quote is dropped: about
# -110 vs -260, or +100 vs -235. Real disagreement at one line is far smaller.
OUTLIER_LOGIT = 0.85
MIN_OTHERS = 2  # with a single other book there's no telling which one is off


def _logit(decimal: float) -> float:
    p = 1 / decimal
    return math.log(p / (1 - p))


def split_outliers(events: dict[str, Event], prices: list[Price], *, reference: str,
                   threshold: float = OUTLIER_LOGIT) -> tuple[list[Price], list[Price]]:
    """(kept, dropped). The reference book is never dropped: when the sharp book
    is far from the rest, it's usually the others that are stale."""
    dropped: set[int] = set()
    for books in group_prices(events, prices).values():
        by_outcome: dict[str, list[tuple[str, Price]]] = {}
        for book, outcomes in books.items():
            for outcome, p in outcomes.items():
                by_outcome.setdefault(outcome, []).append((book, p))
        for quotes in by_outcome.values():
            if len(quotes) < MIN_OTHERS + 1:
                continue
            for book, p in quotes:
                if book == reference:
                    continue
                others = [_logit(q.price) for b, q in quotes if b != book]
                if abs(_logit(p.price) - statistics.median(others)) > threshold:
                    dropped.add(id(p))
    return [p for p in prices if id(p) not in dropped], [p for p in prices if id(p) in dropped]
