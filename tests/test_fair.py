from oddscreen.fair import fair_for_line
from oddscreen.models import Price
from oddscreen.odds_math import devig


def line(**books):
    """books: name -> (over_price, under_price)"""
    return {b: {"Over": Price("e", b, "totals", "Over", o, 45.5), "Under": Price("e", b, "totals", "Under", u, 45.5)}
            for b, (o, u) in books.items()}


def test_books_sharing_a_feed_count_once():
    books = line(ballybet=(2.10, 1.75), betparx=(2.10, 1.75), draftkings=(1.91, 1.91), fanduel=(1.95, 1.87))
    fair = fair_for_line(books, method="multiplicative", reference="pinnacle", min_books=3, weighted=False)
    expect = sum(devig(d, "multiplicative")[0] for d in ([2.10, 1.75], [1.91, 1.91], [1.95, 1.87])) / 3  # [Over, Under]
    assert fair.n_books == 3
    assert abs(fair.probs["Over"] - expect) < 1e-12


def test_a_book_is_left_out_of_its_own_consensus():
    books = line(draftkings=(2.30, 1.60), fanduel=(1.91, 1.91), betmgm=(1.93, 1.89), espnbet=(1.90, 1.92))
    with_dk = fair_for_line(books, method="power", reference="pinnacle", min_books=3)
    without = fair_for_line(books, method="power", reference="pinnacle", min_books=3, exclude="draftkings")
    assert with_dk.n_books == 4 and without.n_books == 3
    # DK's generous Over price implies a low Over probability; leaving DK out stops it dragging the
    # fair probability toward its own price (which hid part of DK's edge)
    assert without.probs["Over"] > with_dk.probs["Over"]
    # excluding a book also drops its feed-mates
    books.update(line(ballybet=(1.95, 1.87), betparx=(1.95, 1.87)))
    assert fair_for_line(books, method="power", reference="pinnacle", min_books=3, exclude="betparx").n_books == 4
    # not enough independent sources once the book is out
    small = line(draftkings=(1.91, 1.91), fanduel=(1.95, 1.87), betmgm=(1.93, 1.89))
    assert fair_for_line(small, method="power", reference="pinnacle", min_books=3, exclude="fanduel") is None


def test_pinnacle_line_ignores_exclusion():
    books = line(pinnacle=(1.95, 1.95), draftkings=(2.05, 1.80))
    fair = fair_for_line(books, method="power", reference="pinnacle", exclude="draftkings")
    assert fair.source == "pinnacle" and abs(fair.probs["Over"] - 0.5) < 1e-12


def test_fair_modes():
    import pytest
    books = line(pinnacle=(1.95, 1.95), draftkings=(2.05, 1.80), fanduel=(1.91, 1.91), betmgm=(1.93, 1.89), espnbet=(1.90, 1.92))
    auto = fair_for_line(books, method="multiplicative", reference="pinnacle", exclude="draftkings")
    assert auto.source == "pinnacle"
    cons = fair_for_line(books, method="multiplicative", reference="pinnacle", exclude="draftkings", mode="consensus",
                         weighted=False)
    assert cons.source == "consensus" and cons.n_books == 4  # Pinnacle votes; DK is out
    expect = sum(devig(d, "multiplicative")[0] for d in ([1.95, 1.95], [1.91, 1.91], [1.93, 1.89], [1.90, 1.92])) / 4
    assert abs(cons.probs["Over"] - expect) < 1e-12
    no_pin = line(draftkings=(2.05, 1.80), fanduel=(1.91, 1.91), betmgm=(1.93, 1.89), espnbet=(1.90, 1.92))
    assert fair_for_line(no_pin, method="power", reference="pinnacle", mode="pinnacle") is None
    assert fair_for_line(no_pin, method="power", reference="pinnacle", mode="auto").source == "consensus"
    with pytest.raises(ValueError):
        fair_for_line(books, method="power", reference="pinnacle", mode="nope")


def test_kambi_books_are_one_source_and_weighted_down():
    from oddscreen.config import source_weight
    # BetRivers, Bally Bet and betPARX all price from Kambi: one vote between them
    books = line(betrivers=(1.70, 2.15), ballybet=(1.72, 2.10), betparx=(1.72, 2.10),
                 draftkings=(1.91, 1.91), fanduel=(1.95, 1.87))
    assert fair_for_line(books, method="power", reference="pinnacle", min_books=3, weighted=False).n_books == 3
    assert fair_for_line(books, method="power", reference="pinnacle", min_books=4) is None
    # ...and that vote counts less than a sharp book's in a props market
    assert source_weight("kambi", "player_points") < source_weight("fanduel", "player_points")
    assert source_weight("kambi", "totals") < source_weight("pinnacle", "totals")


def test_weighted_consensus_leans_toward_sharper_books():
    from oddscreen.config import source_weight
    props = {b: {o: Price("e", b, "player_points", o, d, 18.5, "P") for o, d in (("Over", ov), ("Under", un))}
             for b, (ov, un) in dict(fanduel=(2.00, 1.80), draftkings=(1.91, 1.91), betrivers=(1.70, 2.15)).items()}
    flat = fair_for_line(props, method="multiplicative", reference="pinnacle", min_books=3, weighted=False)
    weighted = fair_for_line(props, method="multiplicative", reference="pinnacle", min_books=3)
    probs = {b: devig([m["Over"].price, m["Under"].price], "multiplicative")[0] for b, m in props.items()}
    w = {"fanduel": source_weight("fanduel", "player_points"), "draftkings": source_weight("draftkings", "player_points"),
         "betrivers": source_weight("kambi", "player_points")}
    expect = sum(w[b] * probs[b] for b in probs) / sum(w.values())
    assert abs(weighted.probs["Over"] - expect) < 1e-12
    assert weighted.probs["Over"] < flat.probs["Over"]  # Kambi's high Over counts for less


def test_market_width():
    from oddscreen.fair import market_width
    from oddscreen.odds_math import american_to_decimal as d
    assert round(market_width([d(-110), d(-110)]), 6) == 20
    assert round(market_width([d(125), d(-165)]), 6) == 40
    assert round(market_width([d(-165), d(125)]), 6) == 40
    assert round(market_width([d(105), d(105)]), 6) == -10  # an exchange-tight (negative-hold) market
    assert market_width([2.0, 3.0, 4.0]) is None
    pin = line(pinnacle=(d(-110), d(-110)))
    assert round(fair_for_line(pin, method="power", reference="pinnacle").width, 6) == 20


def test_ev_skips_bets_priced_off_wide_markets(snap_fixture=None):
    from datetime import datetime, timezone, timedelta
    from oddscreen.ev import find_ev
    from oddscreen.models import Event
    from oddscreen.odds_math import american_to_decimal as d
    ev = Event("e", "nba", datetime.now(timezone.utc) + timedelta(hours=3), "Home", "Away")
    prices = [Price("e", b, "totals", o, p, 45.5) for b, (ov, un) in
              dict(pinnacle=(d(125), d(-165)), draftkings=(d(140), d(-170))).items() for o, p in (("Over", ov), ("Under", un))]
    now = datetime.now(timezone.utc)
    rows = find_ev({"e": ev}, prices, bettable={"draftkings"}, reference="pinnacle", min_ev=-1, now=now)
    assert rows and all(round(r["width"]) == 40 for r in rows)
    assert not find_ev({"e": ev}, prices, bettable={"draftkings"}, reference="pinnacle", min_ev=-1, now=now, max_width=30)
