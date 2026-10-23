import pytest

from conftest import NOW
from oddscreen.ev import find_ev
from oddscreen.middles import find_low_hold, find_middles
from oddscreen.odds_math import devig
from oddscreen.screen import build_screen

BETTABLE = {"draftkings", "fanduel", "betmgm"}


@pytest.fixture
def snap(store):
    fetch, events, prices = store.snapshot("nfl")
    return events, prices


def test_ev_uses_pinnacle_and_finds_bills_ml(snap):
    events, prices = snap
    rows = find_ev(events, prices, bettable=BETTABLE, reference="pinnacle", method="multiplicative",
                   min_ev=0.0, now=NOW)
    top = rows[0]
    fair_bills = devig([2.50, 1.60], "multiplicative")[0]
    assert (top["selection"], top["book"]) == ("Bills ML", "draftkings")
    assert top["fair_source"] == "pinnacle"
    assert top["ev"] == pytest.approx(fair_bills * 2.70 - 1)
    assert all(r["book"] != "pinnacle" for r in rows)
    assert all(r["event_id"] == "g1" for r in rows)  # started game excluded


def test_ev_falls_back_to_consensus_off_pinnacle_line(snap):
    events, prices = snap
    rows = find_ev(events, prices, bettable=BETTABLE, reference="pinnacle", method="power",
                   min_ev=-1, min_books=1, now=NOW)
    # +3.5 is posted by DK and MGM only: each is priced against the other, never itself
    spread_35 = {r["book"]: r for r in rows if r["selection"] == "Bills +3.5"}
    assert set(spread_35) == {"draftkings", "betmgm"}
    assert all(r["fair_source"] == "consensus" and r["fair_books"] == 1 for r in spread_35.values())
    assert not find_ev(events, prices, bettable=BETTABLE, reference="pinnacle", method="power", min_ev=-1,
                       min_books=2, now=NOW) or not [r for r in find_ev(events, prices, bettable=BETTABLE,
                       reference="pinnacle", method="power", min_ev=-1, min_books=2, now=NOW) if r["selection"] == "Bills +3.5"]
    # only DK posts total 47 -> below min_books, no row
    assert not [r for r in rows if r["selection"] == "Over 47"]


def test_middles_spread_and_total(snap):
    events, prices = snap
    rows = find_middles(events, prices, bettable=BETTABLE, now=NOW)
    by_legs = {tuple(leg["selection"] for leg in r["legs"]): r for r in rows}

    # Bills +3.5 / Chiefs -2.5 -> Chiefs by 3 wins both
    r = by_legs[("Bills +3.5", "Chiefs -2.5")]
    assert [h["text"] for h in r["hits"]] == ["Chiefs by 3"]
    assert r["hits"][0]["kind"] == "both win"
    assert r["key_number"] is True
    assert 0 < r["breakeven"] < 0.1
    assert r["miss_pct"] < 0 < r["hit_pct"]

    # Over 47 / Under 48.5 -> 48 wins both, 47 is win + push
    r = by_legs[("Over 47", "Under 48.5")]
    kinds = {h["value"]: h["kind"] for h in r["hits"]}
    assert kinds == {47: "win + push", 48: "both win"}


def test_low_hold_takes_best_price_each_side(snap):
    events, prices = snap
    rows = find_low_hold(events, prices, bettable=BETTABLE, now=NOW)
    ml = next(r for r in rows if r["market"] == "h2h")
    assert [(leg["selection"], leg["book"]) for leg in ml["legs"]] == [("Bills ML", "draftkings"), ("Chiefs ML", "fanduel")]
    assert ml["hold"] == pytest.approx(1 / 2.70 + 1 / 1.58 - 1)


def test_screen_best_line_and_fair(snap):
    events, prices = snap
    out = build_screen(events, prices, market="spreads", bettable=BETTABLE, reference="pinnacle",
                       method="multiplicative", previous={}, opening={}, now=NOW)
    assert [e["id"] for e in out] == ["g1"]
    bills, chiefs = out[0]["rows"]
    assert bills["side"] == "Bills" and bills["best_book"] in {"draftkings", "betmgm"}  # +3.5 beats +2.5
    assert chiefs["best_book"] == "fanduel"  # -2.5 beats -3.5
    assert bills["fair"]["point"] == 3.0 and bills["fair"]["source"] == "pinnacle"
    assert bills["fair"]["price"] == pytest.approx(2.0)
