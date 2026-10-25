"""Positive-EV finder: book prices that beat the de-vigged fair price."""
from __future__ import annotations

from datetime import datetime

from .config import book_title, is_preseason, is_prop, market_title
from .fair import fair_for_line
from .models import Event, Price, group_prices, is_upcoming, selection_label
from .odds_math import expected_value, kelly_fraction
from .store import parse_time

SUSPICIOUS_EV = 0.10  # EV this large on a main line is usually a stale or bad price
STALE_MINUTES = 30


def find_ev(
    events: dict[str, Event],
    prices: list[Price],
    *,
    bettable: set[str],
    reference: str,
    method: str = "power",
    min_ev: float = 0.0,
    min_books: int = 3,
    kelly_mult: float = 0.25,
    bankroll: float = 1000.0,
    now: datetime,
    fair_mode: str = "auto",
    weighted: bool = True,
    max_width: float | None = None,
) -> list[dict]:
    rows: list[dict] = []
    for key, books in group_prices(events, prices).items():
        event = events[key.event_id]
        if not is_upcoming(event, now):
            continue
        ref_prices = books.get(reference, {})
        for book, outcomes in books.items():
            if book == reference or book not in bettable:
                continue
            # each book is measured against a fair price it isn't part of
            fair = fair_for_line(books, method=method, reference=reference, min_books=min_books, exclude=book,
                                 mode=fair_mode, weighted=weighted)
            if fair is None:
                continue
            if max_width is not None and fair.width is not None and fair.width > max_width:
                continue  # the fair price comes from a market too wide to trust
            for outcome, p in outcomes.items():
                prob = fair.probs[outcome]
                ev = expected_value(prob, p.price)
                if ev < min_ev:
                    continue
                kelly = kelly_fraction(prob, p.price) * kelly_mult
                age_min = (
                    (parse_time(p.fetched_at) - parse_time(p.last_update)).total_seconds() / 60
                    if p.last_update and p.fetched_at else None
                )
                warnings = []
                if ev >= SUSPICIOUS_EV:
                    warnings.append("EV unusually high: verify price")
                if age_min is not None and age_min > STALE_MINUTES:
                    warnings.append(f"price {age_min:.0f}m old at fetch")
                ref = ref_prices.get(outcome)
                rows.append({
                    "event_id": event.id,
                    "event": event.name,
                    "commence_time": event.commence_time.isoformat(),
                    "market": key.market,
                    "market_title": market_title(key.market),
                    "is_prop": is_prop(key.market),
                    "player": key.description,
                    "home": event.home,
                    "away": event.away,
                    "preseason": is_preseason(event.league),
                    "selection": selection_label(p),
                    "outcome": outcome,
                    "point": p.point,
                    "book": book,
                    "book_title": book_title(book),
                    "price": p.price,
                    "fair_prob": prob,
                    "fair_price": 1 / prob,
                    "ev": ev,
                    "kelly": kelly,
                    "stake": round(kelly * bankroll, 2),
                    "fair_source": fair.source,
                    "fair_books": fair.n_books,
                    "ref_hold": fair.hold,
                    "width": fair.width,
                    "ref_price": ref.price if ref else None,
                    "age_min": age_min,
                    "link": p.link,
                    "fetched_at": p.fetched_at,
                    "warnings": warnings,
                })
    rows.sort(key=lambda r: r["ev"], reverse=True)
    return rows
