"""Odds screen: every book's line and price per game, best price flagged."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from .config import PROP_MARKETS, is_preseason, is_prop, market_title
from .fair import fair_for_line
from .models import Event, Price, is_moneyline, is_spread, is_upcoming, line_of
from .store import PriceKey, price_key

_NO_LINE = object()


def sides_for(market: str, event: Event) -> list[str]:
    if is_moneyline(market) or is_spread(market):
        return [event.away, event.home]
    return ["Over", "Under"]


def side_point(market: str, line: float | None, side: str, event: Event) -> float | None:
    if line is None:
        return None
    if is_spread(market):
        return line if side == event.home else -line
    return line


def _lines(prices: list[Price], event: Event) -> dict:
    """line (home handicap for spreads, the total for O/U, None for moneylines)
    -> book -> outcome -> price, in first-seen order."""
    lines: dict = defaultdict(lambda: defaultdict(dict))
    for p in prices:
        lines[line_of(p, event)][p.book].setdefault(p.outcome, p)
    return lines


def _main_line(lines: dict, reference: str):
    """The line most books post; on a tie, the reference book's line."""
    best = max(lines, key=lambda ln: len(lines[ln]))
    ref = next((ln for ln, b in lines.items() if len(b.get(reference, {})) >= 2), _NO_LINE)
    if ref is not _NO_LINE and len(lines[ref]) == len(lines[best]):
        return ref
    return best


def _line_rows(
    books: dict,
    line,
    event: Event,
    market: str,
    *,
    bettable: set[str],
    reference: str,
    method: str,
    previous: dict[PriceKey, Price],
    opening: dict[PriceKey, Price],
) -> list[dict]:
    """Rows for one line. Only books posting this exact line appear, so every
    price, the best-price flag and the fair price compare like with like."""
    fair = fair_for_line(books, method=method, reference=reference)
    rows = []
    for side in sides_for(market, event):
        cells = {}
        best: Price | None = None
        for book, outcomes in books.items():
            p = outcomes.get(side)
            if p is None:
                continue
            prev = previous.get(price_key(p))
            first = opening.get(price_key(p))
            cells[book] = {
                "price": p.price,
                "point": p.point,
                "link": p.link,
                "prev_price": prev.price if prev else None,
                "prev_point": prev.point if prev else None,
                "open_price": first.price if first else None,
                "open_point": first.point if first else None,
            }
            if book in bettable and book != reference and (best is None or p.price > best.price):
                best = p
        fair_cell = None
        if fair is not None and side in fair.probs:
            fair_cell = {"price": 1 / fair.probs[side], "point": side_point(market, line, side, event), "source": fair.source}
        rows.append({
            "side": side,
            "point": side_point(market, line, side, event),
            "cells": cells,
            "best_book": best.book if best else None,
            "fair": fair_cell,
        })
    return rows


def _market_lines(prices: list[Price], event: Event, market: str, **kw) -> dict:
    """Every line posted for one market (or one player's prop), most-posted first."""
    lines = _lines(prices, event)
    main = _main_line(lines, kw["reference"])
    order = sorted(lines, key=lambda ln: -len(lines[ln]))
    return {
        "main_line": main,
        "lines": [{"line": ln, "n_books": len(lines[ln]), "rows": _line_rows(lines[ln], ln, event, market, **kw)}
                  for ln in order],
    }


def _event_head(event: Event) -> dict:
    return {
        "id": event.id,
        "name": event.name,
        "home": event.home,
        "away": event.away,
        "commence_time": event.commence_time.isoformat(),
        "preseason": is_preseason(event.league),
    }


def build_screen(
    events: dict[str, Event],
    prices: list[Price],
    *,
    market: str,
    bettable: set[str],
    reference: str,
    method: str,
    previous: dict[PriceKey, Price],
    opening: dict[PriceKey, Price],
    now: datetime,
) -> list[dict]:
    by_event: dict[str, list[Price]] = defaultdict(list)
    for p in prices:
        if p.market == market and p.description is None:
            by_event[p.event_id].append(p)
    out = []
    for event in sorted(events.values(), key=lambda e: (e.commence_time, e.name)):
        if not is_upcoming(event, now) or event.id not in by_event:
            continue
        out.append({**_event_head(event), **_market_lines(
            by_event[event.id], event, market, bettable=bettable, reference=reference, method=method,
            previous=previous, opening=opening)})
    return out


def props_summary(
    events: dict[str, Event], prices: list[Price], props_fetched: dict[str, str], *, now: datetime
) -> list[dict]:
    """One entry per upcoming game: whether/when props were pulled and how many."""
    players: dict[str, set] = defaultdict(set)
    markets: dict[str, set] = defaultdict(set)
    for p in prices:
        if is_prop(p.market):
            players[p.event_id].add(p.description)
            markets[p.event_id].add(p.market)
    out = []
    for event in sorted(events.values(), key=lambda e: (e.commence_time, e.name)):
        if not is_upcoming(event, now):
            continue
        out.append({
            **_event_head(event),
            "props_fetched_at": props_fetched.get(event.id),
            "n_players": len(players[event.id]),
            "markets": sorted(markets[event.id]),
        })
    return out


def build_prop_screen(
    event: Event,
    prices: list[Price],
    *,
    bettable: set[str],
    reference: str,
    method: str,
    previous: dict[PriceKey, Price],
    opening: dict[PriceKey, Price],
) -> list[dict]:
    """Per prop market, per player: Over/Under rows across books."""
    groups: dict[tuple[str, str], list[Price]] = defaultdict(list)
    for p in prices:
        if p.event_id == event.id and is_prop(p.market) and p.description:
            groups[(p.market, p.description)].append(p)
    order = {m: i for i, m in enumerate(PROP_MARKETS.get(event.sport, []))}
    by_market: dict[str, list[dict]] = defaultdict(list)
    for (market, player), ps in groups.items():
        by_market[market].append({
            "player": player,
            "n_books": len({p.book for p in ps}),
            **_market_lines(ps, event, market, bettable=bettable, reference=reference, method=method,
                            previous=previous, opening=opening),
        })
    out = []
    for market in sorted(by_market, key=lambda m: order.get(m, 99)):
        players = sorted(by_market[market], key=lambda r: (-(r["main_line"] or 0), r["player"]))
        out.append({"market": market, "title": market_title(market), "players": players})
    return out
