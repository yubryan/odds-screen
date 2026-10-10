import math

import numpy as np
import pytest

from conftest import NOW, book, event
from oddscreen.odds_api import Usage
from oddscreen.parlay import (
    LegSpec, ParlayError, analyze, boosted, generate, joint_win_prob, metrics, parlay_prob, price_legs,
)
from oddscreen.service import refresh_sport

BETTABLE = {"draftkings", "fanduel", "betmgm"}


@pytest.fixture
def snaps(store, payload):
    # a second upcoming game so cross-game parlays exist
    store.save_fetch("nfl", payload + [event("g3", [
        book("pinnacle", {"h2h": [("Jets", 2.10, None), ("Bears", 1.80, None)]}),
        book("draftkings", {"h2h": [("Jets", 2.25, None), ("Bears", 1.70, None)]}),
        book("fanduel", {"h2h": [("Jets", 2.05, None), ("Bears", 1.78, None)]}),
    ], home="Bears", away="Jets")], markets=["h2h", "spreads", "totals"], books=["x"], fetched_at=NOW)
    _, events, prices = store.snapshot("nfl")
    return {"nfl": (events, prices)}


def legs_for(snaps, *specs):
    return price_legs([LegSpec("nfl", *s) for s in specs], snaps, method="multiplicative",
                      reference="pinnacle", min_books=2)


def test_copula_matches_closed_form():
    # P(Z1<=0, Z2<=0) for correlation r is 1/4 + asin(r) / (2 pi)
    for r in (0.0, 0.3, 0.6):
        got = joint_win_prob([0.5, 0.5], np.array([[1, r], [r, 1]]))
        assert got == pytest.approx(0.25 + math.asin(r) / (2 * math.pi), abs=1e-4)


def test_cross_game_parlay_is_exact(snaps):
    legs = legs_for(snaps, ("g1", "h2h", "Bills"), ("g3", "h2h", "Jets"))
    out = analyze(legs, rho={}, bettable=BETTABLE)
    p1 = 1 / 2.50 / (1 / 2.50 + 1 / 1.60)
    p2 = 1 / 2.10 / (1 / 2.10 + 1 / 1.80)
    assert out["fair_prob"] == pytest.approx(p1 * p2)
    dk = next(r for r in out["books"] if r["book"] == "draftkings")
    assert dk["decimal"] == pytest.approx(2.70 * 2.25)
    assert dk["ev"] == pytest.approx(p1 * p2 * 2.70 * 2.25 - 1)
    assert out["best"]["book"] == "draftkings"
    mgm = next(r for r in out["books"] if r["book"] == "betmgm")
    assert mgm["decimal"] is None and [m["label"] for m in mgm["missing"]] == ["Jets ML"]
    assert {c["label"] for c in out["contributions"]} == {"Bills ML", "Jets ML"}
    assert not out["is_sgp"] and not out["errors"]


def test_same_market_conflict(snaps):
    legs = legs_for(snaps, ("g1", "h2h", "Bills"), ("g1", "h2h", "Chiefs"))
    assert analyze(legs, rho={}, bettable=BETTABLE)["errors"]


def test_sgp_needs_quote_and_finds_break_even(snaps):
    legs = legs_for(snaps, ("g1", "h2h", "Chiefs"), ("g1", "totals", "Over", 47.5))
    out = analyze(legs, rho={}, bettable=BETTABLE)
    assert out["is_sgp"] and all(r["decimal"] is None for r in out["books"])
    # fair odds shorten as correlation rises
    fair = [c["fair_decimal"] for c in out["sgp"]["curve"]]
    assert fair == sorted(fair, reverse=True)

    quote = 3.2
    out = analyze(legs, rho={}, bettable=BETTABLE, sgp_quote=("fanduel", quote))
    be = out["sgp"]["break_even"]["rho"]
    assert be is not None and parlay_prob(legs, be) * quote == pytest.approx(1, abs=1e-3)


def test_correlation_raises_joint_probability(snaps):
    legs = legs_for(snaps, ("g1", "h2h", "Chiefs"), ("g1", "totals", "Over", 47.5))
    pair = frozenset(leg.spec.id for leg in legs)
    assert parlay_prob(legs, {pair: 0.4}) > parlay_prob(legs, {})


def test_boost_math():
    m = metrics(0.25, 3.6, boost=0.0, kelly_mult=0.25, bankroll=1000, max_stake_pct=0.01)
    assert m["ev"] == pytest.approx(-0.10)
    b = m["min_boost"]
    assert 0.25 * boosted(3.6, b) == pytest.approx(1.0)
    boosted_m = metrics(0.25, 3.6, boost=0.5, kelly_mult=0.25, bankroll=1000, max_stake_pct=0.01)
    assert boosted_m["ev"] == pytest.approx(0.25 * 4.9 - 1)
    assert boosted_m["stake_frac"] <= 0.01


def test_missing_game_raises(snaps):
    with pytest.raises(ParlayError):
        legs_for(snaps, ("nope", "h2h", "X"))


def test_generator_one_leg_per_game(snaps):
    rows = generate(snaps, bettable=BETTABLE, reference="pinnacle", method="multiplicative", min_books=2,
                    now=NOW, min_legs=2, max_legs=3)
    assert rows
    for r in rows:
        games = [leg["event_id"] for leg in r["legs"]]
        assert len(games) == len(set(games)) and 2 <= len(games) <= 3
        assert r["ev"] > 0
        assert r["decimal"] == pytest.approx(math.prod(leg["price"] for leg in r["legs"]))
    top = rows[0]
    assert top["book"] == "draftkings" and {leg["label"] for leg in top["legs"]} == {"Bills ML", "Jets ML"}


class FeedClient:
    """Two feeds: regular season has a game, preseason feed is empty."""

    def __init__(self, feeds):
        self.feeds, self.odds_calls = feeds, []

    def events(self, key):
        return [{"id": e, "commence_time": "2099-01-01T00:00:00Z"} for e in self.feeds.get(key, [])]

    def odds(self, key, markets, books):
        self.odds_calls.append(key)
        return [{"id": e, "commence_time": "2099-01-01T00:00:00Z", "home_team": "A", "away_team": "B",
                 "bookmakers": []} for e in self.feeds[key]], Usage(remaining=400, used=100, last=3)


def test_nba_refresh_spans_feeds_and_skips_empty_ones(store):
    client = FeedClient({"basketball_nba": [], "basketball_nba_preseason": ["p1", "p2"]})
    result = refresh_sport(store, client, "nba")
    assert client.odds_calls == ["basketball_nba_preseason"] and result["cost"] == 3
    # events with no prices aren't in the snapshot; check the stored league instead
    assert {e.league for e in store.events(["p1", "p2"]).values()} == {"basketball_nba_preseason"}

    client = FeedClient({"basketball_nba": ["r1"], "basketball_nba_preseason": ["p3"]})
    result = refresh_sport(store, client, "nba")
    assert sorted(client.odds_calls) == ["basketball_nba", "basketball_nba_preseason"] and result["cost"] == 6


def test_chosen_book_is_priced_not_the_best(snaps):
    legs = legs_for(snaps, ("g1", "h2h", "Bills"), ("g3", "h2h", "Jets"))
    out = analyze(legs, rho={}, bettable=BETTABLE, book="fanduel")
    assert out["best"]["book"] == "draftkings"
    assert out["chosen"]["book"] == "fanduel"
    assert out["chosen"]["decimal"] == pytest.approx(2.40 * 2.05)
    assert out["contributions_book"] == "fanduel"
    # a book the user filtered out still gets priced if it's the one they picked
    out = analyze(legs, rho={}, bettable={"draftkings"}, book="fanduel")
    assert out["chosen"]["decimal"] == pytest.approx(2.40 * 2.05)


def test_off_market_line_gets_rough_fair_price(snaps):
    # only DraftKings posts total 47 in g1: strict min_books=2 finds no fair price, so fall back and flag it
    legs = legs_for(snaps, ("g1", "totals", "Over", 47.0), ("g3", "h2h", "Jets"))
    assert legs[0].fair_thin and legs[0].fair_books == 1 and legs[0].fair_prob == pytest.approx(0.5)
    out = analyze(legs, rho={}, bettable=BETTABLE, book="draftkings")
    assert out["chosen"]["ev"] is not None
    assert any("only 1 book" in w for w in out["warnings"])
