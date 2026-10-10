"""Odds screen: every book's line and price per game, best price flagged."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from .config import PROP_MARKETS, is_preseason, is_prop, market_title
from .fair import FairLine, fair_for_line
from .models import Event, Price, is_moneyline, is_spread, is_upcoming, line_of
from .store import PriceKey, price_key

_NO_LINE = object()


def sides_for(market: str, event: Event) -> list[str]:
    if is_moneyline(market) or is_spread(market):
        return [event.away, event.home]
    return ["Over", "Under"]


def favorability(p: Price) -> float:
    """How good the line (not price) is for the bettor; higher is better."""
    if p.point is None:
        return 0.0
    if is_spread(p.market) or p.outcome == "Under":
        return p.point
    return -p.point  # Over: lower total is better


def side_point(market: str, line: float | None, side: str, event: Event) -> float | None:
    if line is None:
        return None
    if is_spread(market):
        return line if side == event.home else -line
    return line


def _fair(prices: list[Price], event: Event, *, reference: str, method: str) -> tuple[object, FairLine | None]:
    """Fair line at the reference book's own line, else the most widely posted line.
    (A moneyline's line is None, so "no line" needs its own sentinel.)"""
    lines: dict = defaultdict(lambda: defaultdict(dict))
    for p in prices:
        lines[line_of(p, event)][p.book].setdefault(p.outcome, p)
    line = next((ln for ln, b in lines.items() if len(b.get(reference, {})) >= 2), _NO_LINE)
    if line is _NO_LINE and lines:
        line = max(lines, key=lambda ln: len(lines[ln]))
    if line is _NO_LINE:
        return _NO_LINE, None
    return line, fair_for_line(lines[line], method=method, reference=reference)


def _rows(
    prices: list[Price],
    event: Event,
    market: str,
    *,
    bettable: set[str],
    reference: str,
    method: str,
    previous: dict[PriceKey, Price],
    opening: dict[PriceKey, Price],
) -> tuple[list[dict], object]:
    line, fair = _fair(prices, event, reference=reference, method=method)
    rows = []
    for side in sides_for(market, event):
        cells = {}
        best: Price | None = None
        for p in prices:
            if p.outcome != side or p.book in cells:
                continue
            prev = previous.get(price_key(p))
            first = opening.get(price_key(p))
            cells[p.book] = {
                "price": p.price,
                "point": p.point,
                "link": p.link,
                "prev_price": prev.price if prev else None,
                "prev_point": prev.point if prev else None,
                "open_price": first.price if first else None,
                "open_point": first.point if first else None,
            }
            if p.book in bettable and p.book != reference:
                if best is None or (favorability(p), p.price) > (favorability(best), best.price):
                    best = p
        fair_cell = None
        if fair is not None and side in fair.probs:
            fair_cell = {
                "price": 1 / fair.probs[side],
                "point": side_point(market, line, side, event),
                "source": fair.source,
            }
        rows.append({"side": side, "cells": cells, "best_book": best.book if best else None, "fair": fair_cell})
    return rows, line


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
        rows, _ = _rows(by_event[event.id], event, market, bettable=bettable, reference=reference,
                        method=method, previous=previous, opening=opening)
        out.append({**_event_head(event), "rows": rows})
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
        rows, line = _rows(ps, event, market, bettable=bettable, reference=reference, method=method,
                           previous=previous, opening=opening)
        books = {p.book for p in ps}
        by_market[market].append({
            "player": player,
            "line": None if line is _NO_LINE else line,
            "n_books": len(books),
            "rows": rows,
        })
    out = []
    for market in sorted(by_market, key=lambda m: order.get(m, 99)):
        players = sorted(by_market[market], key=lambda r: (-(r["line"] or 0), r["player"]))
        out.append({"market": market, "title": market_title(market), "players": players})
    return out
