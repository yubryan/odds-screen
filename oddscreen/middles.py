"""Middles (spread/total gaps across books) and low-hold markets."""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime

from .config import book_title, is_preseason, is_prop, market_title
from .models import Event, Price, group_prices, is_moneyline, is_spread, is_upcoming, selection_label

NFL_KEY_NUMBERS = {3, 7}


def _best_by_point(prices: list[Price]) -> dict[float, Price]:
    best: dict[float, Price] = {}
    for p in prices:
        if p.point is not None and (p.point not in best or p.price > best[p.point].price):
            best[p.point] = p
    return best


def _leg_return(stake: float, decimal: float, result: str) -> float:
    return {"win": stake * decimal, "push": stake, "loss": 0.0}[result]


def _spread_result(margin: int, point: float, is_home: bool) -> str:
    """margin = home score - away score; point is from this side's perspective."""
    covered = (margin if is_home else -margin) + point
    return "win" if covered > 0 else "push" if covered == 0 else "loss"


def _total_result(total: int, point: float, is_over: bool) -> str:
    diff = (total - point) if is_over else (point - total)
    return "win" if diff > 0 else "push" if diff == 0 else "loss"


def _evaluate(event: Event, leg1: Price, leg2: Price, lo: float, hi: float, total_stake: float) -> dict | None:
    """leg1/leg2 sized for equal return if only one wins; scan every integer
    outcome in [lo, hi] for ones that pay more than that."""
    d1, d2 = leg1.price, leg2.price
    s1 = total_stake * d2 / (d1 + d2)
    s2 = total_stake - s1
    miss = s1 * d1 - total_stake  # P&L when exactly one leg wins (usually negative)

    hits = []
    for v in range(math.ceil(lo), math.floor(hi) + 1):
        if is_spread(leg1.market):
            r1 = _spread_result(v, leg1.point, leg1.outcome == event.home)
            r2 = _spread_result(v, leg2.point, leg2.outcome == event.home)
            text = f"{event.home} by {v}" if v > 0 else f"{event.away} by {-v}" if v < 0 else "Tie"
        else:
            r1 = _total_result(v, leg1.point, leg1.outcome == "Over")
            r2 = _total_result(v, leg2.point, leg2.outcome == "Over")
            text = f"{leg1.description}: {v}" if leg1.description else f"Total {v}"
        profit = _leg_return(s1, d1, r1) + _leg_return(s2, d2, r2) - total_stake
        if profit > miss + 1e-9:
            kind = "both win" if r1 == r2 == "win" else "win + push"
            hits.append({"value": v, "text": text, "kind": kind, "profit": profit})
    if not hits:
        return None

    worst_hit = min(h["profit"] for h in hits)
    breakeven = 0.0 if miss >= 0 else -miss / (worst_hit - miss)
    key_hit = event.sport == "nfl" and is_spread(leg1.market) and any(abs(h["value"]) in NFL_KEY_NUMBERS for h in hits)
    return {
        "event_id": event.id,
        "event": event.name,
        "commence_time": event.commence_time.isoformat(),
        "market": leg1.market,
        "market_title": market_title(leg1.market),
        "is_prop": is_prop(leg1.market),
        "player": leg1.description,
        "home": event.home,
        "away": event.away,
        "preseason": is_preseason(event.league),
        "legs": [
            {"selection": selection_label(p), "book": p.book, "book_title": book_title(p.book),
             "price": p.price, "stake": round(s, 2), "link": p.link}
            for p, s in ((leg1, s1), (leg2, s2))
        ],
        "gap": hi - lo,
        "hits": hits,
        "miss_pct": miss / total_stake,
        "hit_pct": max(h["profit"] for h in hits) / total_stake,
        "breakeven": breakeven,
        "key_number": key_hit,
    }


def find_middles(
    events: dict[str, Event],
    prices: list[Price],
    *,
    bettable: set[str],
    now: datetime,
    total_stake: float = 100.0,
) -> list[dict]:
    rows = []
    for event in events.values():
        if not is_upcoming(event, now):
            continue
        mine = [p for p in prices if p.event_id == event.id and p.book in bettable]

        away = _best_by_point([p for p in mine if is_spread(p.market) and p.outcome == event.away])
        home = _best_by_point([p for p in mine if is_spread(p.market) and p.outcome == event.home])
        for a, pa in away.items():
            for h, ph in home.items():
                if a + h > 0:  # margin window: -h <= home margin <= a
                    if row := _evaluate(event, pa, ph, -h, a, total_stake):
                        rows.append(row)

        # Over/Under markets: game totals and player props, one group per (market, player)
        over_under: dict[tuple, list[Price]] = defaultdict(list)
        for p in mine:
            if not is_spread(p.market) and not is_moneyline(p.market):
                over_under[(p.market, p.description)].append(p)
        for group in over_under.values():
            overs = _best_by_point([p for p in group if p.outcome == "Over"])
            unders = _best_by_point([p for p in group if p.outcome == "Under"])
            for x, po in overs.items():
                for y, pu in unders.items():
                    if y > x:
                        if row := _evaluate(event, po, pu, x, y, total_stake):
                            rows.append(row)
    rows.sort(key=lambda r: r["breakeven"])
    return rows


def find_low_hold(
    events: dict[str, Event],
    prices: list[Price],
    *,
    bettable: set[str],
    now: datetime,
) -> list[dict]:
    """Best available price on each side of the same line, across bettable books."""
    rows = []
    bettable_prices = [p for p in prices if p.book in bettable]
    for key, books in group_prices(events, bettable_prices).items():
        event = events[key.event_id]
        if not is_upcoming(event, now):
            continue
        best: dict[str, Price] = {}
        for outcomes in books.values():
            for outcome, p in outcomes.items():
                if outcome not in best or p.price > best[outcome].price:
                    best[outcome] = p
        if len(best) < 2:
            continue
        legs = sorted(best.values(), key=lambda p: p.outcome != event.away and p.outcome != "Over")
        hold = sum(1 / p.price for p in legs) - 1
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
            "legs": [
                {"selection": selection_label(p), "book": p.book, "book_title": book_title(p.book),
                 "price": p.price, "link": p.link}
                for p in legs
            ],
            "hold": hold,
            "n_books": len(books),
        })
    rows.sort(key=lambda r: r["hold"])
    return rows
