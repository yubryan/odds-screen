from datetime import timedelta

import pytest

from conftest import NOW, STARTED
from oddscreen.odds_api import Usage
from oddscreen.service import RefreshRefused, refresh_sport


def test_snapshot_round_trip(store):
    fetch, events, prices = store.snapshot("nfl")
    assert fetch["credits_remaining"] == 490
    assert set(events) == {"g1", "g2"}
    dk = [p for p in prices if p.book == "draftkings" and p.market == "spreads"]
    assert {(p.outcome, p.point) for p in dk} == {("Bills", 3.5), ("Chiefs", -3.5)}
    assert store.usage()["remaining"] == 490


def test_previous_and_opening(store, payload):
    payload[0]["bookmakers"][1]["markets"][0]["outcomes"][0]["price"] = 2.60  # DK Bills ML moves
    store.save_fetch("nfl", payload, markets=["h2h"], books=["x"], fetched_at=NOW + timedelta(minutes=5))
    store.save_fetch("nfl", payload, markets=["h2h"], books=["x"], fetched_at=NOW + timedelta(minutes=9))
    key = ("g1", "draftkings", "h2h", "Bills", "")
    assert store.opening_prices(["g1"])[key].price == 2.70
    assert store.previous_prices("nfl")[key].price == 2.60
    assert len([r for r in store.history("g1", "h2h") if r["book"] == "draftkings" and r["outcome"] == "Bills"]) == 3


class FakeClient:
    def __init__(self, events, odds=None):
        self._events, self._odds, self.odds_calls = events, odds or [], 0

    def events(self, sport_key):
        return self._events

    def odds(self, sport_key, markets, books):
        self.odds_calls += 1
        return self._odds, Usage(remaining=487, used=13, last=3)


def test_refresh_skips_paid_call_when_no_upcoming_games(store):
    client = FakeClient([{"id": "x", "commence_time": STARTED}])
    with pytest.raises(RefreshRefused):
        refresh_sport(store, client, "nfl")
    assert client.odds_calls == 0


def test_refresh_refuses_when_quota_too_low(store):
    store.set_usage({"remaining": 1, "used": 499, "last": 3})
    client = FakeClient([{"id": "x", "commence_time": "2099-01-01T00:00:00Z"}])
    with pytest.raises(RefreshRefused):
        refresh_sport(store, client, "nfl")
    assert client.odds_calls == 0


def test_refresh_saves_snapshot(store, payload):
    client = FakeClient([{"id": "x", "commence_time": "2099-01-01T00:00:00Z"}], payload)
    result = refresh_sport(store, client, "nfl")
    assert result["cost"] == 3 and client.odds_calls == 1
    assert store.usage()["remaining"] == 487
