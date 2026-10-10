"""Core records and the market/line grouping every tool builds on."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import NamedTuple

from .config import is_prop, market_title


@dataclass(frozen=True)
class Event:
    id: str
    sport: str
    commence_time: datetime
    home: str
    away: str
    league: str | None = None  # Odds API sport key, e.g. basketball_nba_preseason

    @property
    def name(self) -> str:
        return f"{self.away} @ {self.home}"


@dataclass(frozen=True)
class Price:
    event_id: str
    book: str
    market: str
    outcome: str  # team name, "Over"/"Under"
    price: float  # decimal odds
    point: float | None = None
    description: str | None = None  # player name for props
    last_update: str | None = None
    link: str | None = None
    fetched_at: str | None = None  # when our snapshot containing this price was taken


class LineKey(NamedTuple):
    """One two-sided proposition: both sides share event, market, player and line.

    `line` is the home team's handicap for spreads, the total for O/U markets,
    and None for moneylines.
    """

    event_id: str
    market: str
    description: str | None
    line: float | None


def is_spread(market: str) -> bool:
    return "spreads" in market


def is_moneyline(market: str) -> bool:
    return market.startswith("h2h")


def line_of(p: Price, event: Event) -> float | None:
    if is_moneyline(p.market):
        return None
    if is_spread(p.market):
        if p.point is None:
            return None
        return p.point if p.outcome == event.home else -p.point
    return p.point


Grouped = dict[LineKey, dict[str, dict[str, Price]]]  # line -> book -> outcome -> price


def group_prices(events: dict[str, Event], prices: list[Price]) -> Grouped:
    grouped: Grouped = defaultdict(lambda: defaultdict(dict))
    for p in prices:
        event = events.get(p.event_id)
        if event is None:
            continue
        key = LineKey(p.event_id, p.market, p.description, line_of(p, event))
        grouped[key][p.book].setdefault(p.outcome, p)
    return grouped


def fmt_point(point: float | None, spread: bool) -> str:
    if point is None:
        return ""
    if spread and point == 0:
        return "PK"
    text = f"{point:g}"
    return f"+{text}" if spread and point > 0 else text


def selection_label(p: Price) -> str:
    if is_prop(p.market):
        return f"{p.description} {p.outcome} {fmt_point(p.point, False)} {market_title(p.market)}"
    if is_moneyline(p.market):
        return f"{p.outcome} ML"
    return f"{p.outcome} {fmt_point(p.point, is_spread(p.market))}"


def is_upcoming(event: Event, now: datetime) -> bool:
    return event.commence_time > now
