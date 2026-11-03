from datetime import datetime, timedelta, timezone

from oddscreen.ev import find_ev
from oddscreen.models import Event, Price
from oddscreen.odds_math import american_to_decimal as am
from oddscreen.outliers import split_outliers

NOW = datetime(2026, 11, 2, tzinfo=timezone.utc)
GAME = Event("e", "nba", NOW + timedelta(hours=3), "H", "A")


def totals(book, over, under, event="e"):
    return [Price(event, book, "totals", "Over", am(over), 220.5), Price(event, book, "totals", "Under", am(under), 220.5)]


def test_far_off_quote_is_dropped_but_not_the_reference_or_an_opinion():
    prices = totals("draftkings", -110, -110) + totals("fanduel", -105, -115) + totals("betmgm", -112, -108) + totals("novig", 105, -1000)
    kept, dropped = split_outliers({"e": GAME}, prices, reference="pinnacle")
    assert [(p.book, p.outcome) for p in dropped] == [("novig", "Under")]
    assert len(kept) == len(prices) - 1
    opinion = totals("draftkings", -110, -110) + totals("fanduel", -105, -115) + totals("novig", 120, -150)
    assert split_outliers({"e": GAME}, opinion, reference="pinnacle")[1] == []
    sharp_moved = totals("pinnacle", -300, 240) + totals("draftkings", -110, -110) + totals("fanduel", -108, -112)
    assert split_outliers({"e": GAME}, sharp_moved, reference="pinnacle")[1] == []


def test_ev_reports_why_prices_were_skipped():
    live = Event("live", "nba", NOW - timedelta(hours=1), "H", "A")
    thin = Event("thin", "nba", GAME.commence_time, "H2", "A2")
    prices = (totals("pinnacle", -105, -105, "live") + totals("draftkings", 110, -125, "live")
              + totals("draftkings", -110, -110, "thin") + totals("fanduel", -111, -109, "thin")
              + totals("pinnacle", -105, -105) + totals("draftkings", -111, -111))
    stats: dict = {}
    rows = find_ev({"live": live, "thin": thin, "e": GAME}, prices, bettable={"draftkings", "fanduel"},
                   reference="pinnacle", now=NOW, stats=stats)
    assert rows == []
    assert stats == {"checked": 6, "started": 1, "no_fair": 4, "too_wide": 0, "below_min": 2}
