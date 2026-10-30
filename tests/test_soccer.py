"""Soccer: 3-way moneylines, Asian quarter-line totals."""
from datetime import datetime, timedelta, timezone

from oddscreen.ev import find_ev
from oddscreen.middles import find_low_hold, find_middles
from oddscreen.models import Event, Price
from oddscreen.screen import build_screen

NOW = datetime(2026, 10, 29, tzinfo=timezone.utc)
GAME = Event("s1", "soccer", NOW + timedelta(hours=5), "Chelsea", "Arsenal", "soccer_epl")
SIDES = ("Chelsea", "Draw", "Arsenal")


def h2h(book, *prices, event="s1"):
    return [Price(event, book, "h2h", o, d) for o, d in zip(SIDES, prices) if d]


def test_three_way_fair_price_ev_and_screen_order():
    prices = h2h("pinnacle", 2.50, 3.40, 2.95) + h2h("draftkings", 2.40, 3.75, 2.80) + h2h("fanduel", 2.45, 3.30, 2.90)
    rows = find_ev({"s1": GAME}, prices, bettable={"draftkings", "fanduel"}, reference="pinnacle", now=NOW)
    draw = next(r for r in rows if r["book"] == "draftkings" and r["outcome"] == "Draw")
    assert draw["ev"] > 0.05 and draw["selection"] == "Draw" and draw["event"] == "Chelsea vs Arsenal"
    [game] = build_screen({"s1": GAME}, prices, market="h2h", bettable={"draftkings", "fanduel"}, reference="pinnacle",
                          method="power", previous={}, opening={}, now=NOW)
    sides = game["lines"][0]["rows"]
    assert [r["side"] for r in sides] == list(SIDES)
    assert abs(sum(1 / r["fair"]["price"] for r in sides) - 1) < 1e-9


def test_low_hold_needs_all_three_outcomes():
    other = Event("s2", "soccer", GAME.commence_time, "Chelsea", "Arsenal", "soccer_epl")
    prices = h2h("draftkings", 2.6, 3.6, 3.1) + h2h("fanduel", 2.5, 0, 3.3) + h2h("draftkings", 2.6, 0, 3.1, event="s2")
    [row] = find_low_hold({"s1": GAME, "s2": other}, prices, bettable={"draftkings", "fanduel"}, now=NOW)
    assert [leg["selection"] for leg in row["legs"]] == ["Chelsea ML", "Draw", "Arsenal ML"]
    assert abs(row["hold"] - (1 / 2.6 + 1 / 3.6 + 1 / 3.3 - 1)) < 1e-12


def test_quarter_line_middle_settles_split_stakes():
    prices = [Price("s1", "betmgm", "totals", "Over", 1.95, 2.25), Price("s1", "espnbet", "totals", "Under", 1.95, 2.75)]
    [mid] = find_middles({"s1": GAME}, prices, bettable={"betmgm", "espnbet"}, now=NOW)
    # 2 goals: Over 2.25 half-pushes, Under 2.75 wins; 3 goals: the reverse
    assert [(h["value"], round(h["profit"], 2)) for h in mid["hits"]] == [(2, 22.5), (3, 22.5)]
