from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

NOW = datetime(2026, 10, 5, 12, tzinfo=timezone.utc)
KICKOFF = (NOW + timedelta(hours=5)).isoformat().replace("+00:00", "Z")
STARTED = (NOW - timedelta(hours=1)).isoformat().replace("+00:00", "Z")


def book(key: str, markets: dict[str, list[tuple]]) -> dict:
    """markets: {market_key: [(name, price, point), ...]}"""
    return {
        "key": key,
        "title": key,
        "last_update": KICKOFF,
        "link": f"https://{key}.example/event",
        "markets": [
            {
                "key": mk,
                "last_update": (NOW - timedelta(minutes=2)).isoformat(),
                "outcomes": [
                    {"name": n, "price": p, **({"point": pt} if pt is not None else {})} for n, p, pt in outs
                ],
            }
            for mk, outs in markets.items()
        ],
    }


def event(eid: str, bookmakers: list[dict], commence: str = KICKOFF, home="Chiefs", away="Bills") -> dict:
    return {"id": eid, "sport_key": "americanfootball_nfl", "commence_time": commence,
            "home_team": home, "away_team": away, "bookmakers": bookmakers}


@pytest.fixture
def payload() -> list[dict]:
    return [
        event("g1", [
            book("pinnacle", {
                "h2h": [("Bills", 2.50, None), ("Chiefs", 1.60, None)],
                "spreads": [("Bills", 1.95, 3.0), ("Chiefs", 1.95, -3.0)],
                "totals": [("Over", 1.93, 47.5), ("Under", 1.97, 47.5)],
            }),
            book("draftkings", {
                "h2h": [("Bills", 2.70, None), ("Chiefs", 1.50, None)],  # Bills ML is +EV
                "spreads": [("Bills", 1.91, 3.5), ("Chiefs", 1.91, -3.5)],
                "totals": [("Over", 1.91, 47.0), ("Under", 1.91, 47.0)],
            }),
            book("fanduel", {
                "h2h": [("Bills", 2.40, None), ("Chiefs", 1.58, None)],
                "spreads": [("Bills", 1.87, 2.5), ("Chiefs", 1.95, -2.5)],
                "totals": [("Over", 1.91, 48.5), ("Under", 1.91, 48.5)],
            }),
            book("betmgm", {
                "h2h": [("Bills", 2.45, None), ("Chiefs", 1.57, None)],
                "spreads": [("Bills", 1.91, 3.5), ("Chiefs", 1.91, -3.5)],
            }),
        ]),
        event("g2", [  # already started -> ignored everywhere
            book("pinnacle", {"h2h": [("Jets", 3.0, None), ("Bears", 1.45, None)]}),
            book("draftkings", {"h2h": [("Jets", 9.0, None), ("Bears", 1.45, None)]}),
        ], commence=STARTED, home="Bears", away="Jets"),
    ]


@pytest.fixture
def store(tmp_path, payload):
    from oddscreen.store import Store

    s = Store(tmp_path / "t.db")
    s.save_fetch("nfl", payload, markets=["h2h", "spreads", "totals"], books=["pinnacle"],
                 usage={"remaining": 490, "used": 10, "last": 3}, fetched_at=NOW)
    return s
