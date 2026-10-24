from datetime import timedelta

import pytest

from conftest import KICKOFF, NOW
from oddscreen.ev import find_ev
from oddscreen.media import Media, match_team, norm
from oddscreen.middles import find_middles
from oddscreen.odds_api import Usage
from oddscreen.screen import build_prop_screen
from oddscreen.service import refresh_props

BETTABLE = {"draftkings", "fanduel", "betmgm"}
QB = "Josh Allen"


def props_event(over_dk=2.02, dk_point=245.5) -> dict:
    def ou(over, under, pt):
        return [("Over", over, pt, QB), ("Under", under, pt, QB)]

    books = {
        "pinnacle": ou(1.87, 1.95, 245.5),
        "draftkings": ou(over_dk, 1.80, dk_point),
        "fanduel": ou(1.87, 1.87, 243.5),
        "betmgm": ou(1.91, 1.91, 247.5),
    }
    return {
        "id": "g1", "sport_key": "americanfootball_nfl", "commence_time": KICKOFF,
        "home_team": "Chiefs", "away_team": "Bills",
        "bookmakers": [
            {"key": k, "title": k, "markets": [{"key": "player_pass_yds", "last_update": KICKOFF, "outcomes": [
                {"name": n, "price": p, "point": pt, "description": d} for n, p, pt, d in outs]}]}
            for k, outs in books.items()
        ],
    }


@pytest.fixture
def with_props(store):
    store.save_fetch("nfl", [props_event()], markets=["player_pass_yds"], books=["x"],
                     fetched_at=NOW + timedelta(minutes=1), kind="props", event_id="g1")
    return store


def test_snapshot_merges_main_and_props(with_props):
    fetch, events, prices = with_props.snapshot("nfl")
    assert fetch["kind"] == "main"  # header fetch is still the main-lines one
    assert {p.market for p in prices} >= {"h2h", "spreads", "totals", "player_pass_yds"}
    # a later MAIN refresh must not drop the props
    with_props.save_fetch("nfl", [], markets=["h2h"], books=["x"], fetched_at=NOW + timedelta(minutes=2))
    _, _, prices = with_props.snapshot("nfl")
    assert {p.market for p in prices} == {"player_pass_yds"}
    assert with_props.props_fetched("nfl") == {"g1": (NOW + timedelta(minutes=1)).isoformat()}


def test_prop_ev_and_label(with_props):
    _, events, prices = with_props.snapshot("nfl")
    props = [p for p in prices if p.market == "player_pass_yds"]
    rows = find_ev(events, props, bettable=BETTABLE, reference="pinnacle", method="multiplicative",
                   min_ev=0.0, now=NOW)
    top = rows[0]
    assert (top["player"], top["book"], top["outcome"]) == (QB, "draftkings", "Over")
    assert top["selection"] == "Josh Allen Over 245.5 Pass Yds"
    assert top["fair_source"] == "pinnacle" and top["is_prop"]


def test_prop_middle(with_props):
    _, events, prices = with_props.snapshot("nfl")
    props = [p for p in prices if p.market == "player_pass_yds"]
    rows = find_middles(events, props, bettable=BETTABLE, now=NOW)
    best = next(r for r in rows if [l["book"] for l in r["legs"]] == ["fanduel", "betmgm"])
    assert [h["value"] for h in best["hits"]] == [244, 245, 246, 247]
    assert best["hits"][0]["text"] == "Josh Allen: 244"


def test_prop_screen(with_props):
    _, events, prices = with_props.snapshot("nfl")
    out = build_prop_screen(events["g1"], prices, bettable=BETTABLE, reference="pinnacle",
                            method="power", previous={}, opening={})
    assert [m["market"] for m in out] == ["player_pass_yds"]
    player = out[0]["players"][0]
    assert player["player"] == QB and player["main_line"] == 245.5 and player["n_books"] == 4
    lines = {ln["line"]: ln for ln in player["lines"]}
    assert set(lines) == {245.5, 243.5, 247.5}
    over, under = lines[245.5]["rows"]
    assert set(over["cells"]) == {"pinnacle", "draftkings"}  # 243.5 and 247.5 aren't the same bet
    assert over["best_book"] == "draftkings"
    assert lines[243.5]["rows"][0]["best_book"] == "fanduel"


class PropsClient:
    def __init__(self, upcoming):
        self.upcoming, self.calls = upcoming, []

    def events(self, sport_key):
        return [{"id": e, "commence_time": "2099-01-01T00:00:00Z"} for e in self.upcoming]

    def event_odds(self, sport_key, event_id, markets, books):
        self.calls.append(event_id)
        return props_event(), Usage(remaining=480, used=20, last=5)


def test_refresh_props_only_hits_upcoming_games(store):
    client = PropsClient(["g1"])
    result = refresh_props(store, client, "nfl", ["g1", "gone"])
    assert client.calls == ["g1"]
    assert result["games"] == 1 and result["cost"] == 5
    assert store.props_fetched("nfl").keys() == {"g1"}


def test_refresh_props_stops_when_credits_run_low(store):
    store.set_usage({"remaining": 7, "used": 493, "last": 3})
    client = PropsClient(["g1", "g2", "g3"])

    def costly(*a):
        client.calls.append(a[1])
        return props_event(), Usage(remaining=2, used=498, last=5)

    client.event_odds = costly
    result = refresh_props(store, client, "nfl", ["g1", "g2", "g3"])
    assert client.calls == ["g1"] and result["stopped"]


def test_norm_and_team_matching():
    assert norm("Kenneth Walker III") == "kenneth walker"
    assert norm("Amon-Ra St. Brown") == "amon ra st brown"
    teams = [
        {"display": "LA Clippers", "location": "LA", "nickname": "Clippers", "espn_id": "12"},
        {"display": "Kentucky Wildcats", "location": "Kentucky", "nickname": "Wildcats", "espn_id": "96"},
        {"display": "Arizona Wildcats", "location": "Arizona", "nickname": "Wildcats", "espn_id": "12a"},
    ]
    assert match_team("Los Angeles Clippers", teams)["espn_id"] == "12"
    assert match_team("Arizona Wildcats", teams)["espn_id"] == "12a"
    assert match_team("Villanova Wildcats", teams) is None


def test_player_map_scoped_to_game(store):
    m = Media(store, http=object())
    with store.conn() as c:
        c.executemany("INSERT INTO media_teams VALUES (?,?,?,?,?,?,?,?)", [
            ("nfl", "2", "Buffalo Bills", "Buffalo", "Bills", "BUF", "buf.png", "00338d"),
            ("nfl", "30", "Jacksonville Jaguars", "Jacksonville", "Jaguars", "JAX", "jax.png", "006778"),
            ("nfl", "12", "Kansas City Chiefs", "Kansas City", "Chiefs", "KC", "kc.png", "e31837"),
        ])
        c.executemany("INSERT INTO media_players VALUES (?,?,?,?,?,?,?)", [
            ("nfl", "2", "josh allen", "Josh Allen", "qb.png", "17", "QB"),
            ("nfl", "30", "josh allen", "Josh Allen", "lb.png", "41", "LB"),
        ])
    got = m.player_map("nfl", [("g1", "Kansas City Chiefs", "Buffalo Bills", "Josh Allen")])
    assert got["g1|Josh Allen"]["headshot"] == "qb.png"
    assert m.team_map("nfl", {"Buffalo Bills"})["Buffalo Bills"]["abbr"] == "BUF"
