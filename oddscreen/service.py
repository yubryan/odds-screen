"""Refresh orchestration with quota guards. Main lines and props are separate
refreshes so props (billed per game) never ride along with a main-line pull."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta, timezone

from .config import BOOKS, PROP_MARKETS, SPORTS, is_preseason, props_cost_per_event, refresh_cost, sport_markets
from .media import Media
from .odds_api import OddsAPIClient, OddsAPIError
from .store import Store, parse_time


class RefreshRefused(RuntimeError):
    pass


def _title(sport: str) -> str:
    return SPORTS[sport]["title"]


def upcoming_events(client: OddsAPIClient, sport: str) -> list[dict]:
    """Upcoming games across all of a sport's feeds (e.g. NBA + NBA preseason),
    from the free /events endpoint, soonest first. Each keeps its `sport_key`."""
    if sport not in SPORTS:
        raise RefreshRefused(f"unknown sport {sport!r}")
    events, offered = [], 0
    for key in SPORTS[sport]["keys"]:
        try:
            batch = client.events(key)
        except OddsAPIError as e:
            if e.status == 404:  # feed not offered right now (off-season)
                continue
            raise
        offered += 1
        events += [{**e, "sport_key": e.get("sport_key") or key} for e in batch]
    if not offered:
        raise RefreshRefused(f"{_title(sport)} is not currently offered by The Odds API (off-season?)")
    now = datetime.now(timezone.utc)
    return sorted((e for e in events if parse_time(e["commence_time"]) > now), key=lambda e: e["commence_time"])


def _check_quota(store: Store, cost: int) -> None:
    usage = store.usage()
    if usage and usage.get("remaining") is not None and usage["remaining"] < cost:
        raise RefreshRefused(f"Only {usage['remaining']} credits left; this refresh can cost up to {cost}")


def refresh_sport(store: Store, client: OddsAPIClient, sport: str, media: Media | None = None) -> dict:
    """Main lines for one sport: one bulk call per feed that has upcoming games
    (the free /events check means an empty feed, e.g. preseason once it ends,
    never spends credits). All feeds land in a single snapshot."""
    feeds = sorted({e["sport_key"] for e in upcoming_events(client, sport)})
    if not feeds:
        raise RefreshRefused(f"No upcoming {_title(sport)} games listed, so no credits were spent")
    markets = sport_markets(sport)
    _check_quota(store, refresh_cost(markets=markets) * len(feeds))

    now = datetime.now(timezone.utc)
    payload, cost, used = [], 0, None
    for key in feeds:
        batch, used = client.odds(key, markets, BOOKS)
        payload += [{**e, "sport_key": e.get("sport_key") or key} for e in batch]
        cost += used.last or 0
    fetch_id = store.save_fetch(sport, payload, markets=markets, books=BOOKS, usage=asdict(used), fetched_at=now)
    if media:
        media.ensure_teams(sport)
    return {"fetch_id": fetch_id, "events": len(payload), "usage": asdict(used), "cost": cost, "feeds": feeds}


def props_plan(client: OddsAPIClient, sport: str, hours: float | None = None) -> dict:
    """What "refresh all props" would hit, and its worst-case cost. Free."""
    events = upcoming_events(client, sport)
    if hours is not None:
        cutoff = datetime.now(timezone.utc) + timedelta(hours=hours)
        events = [e for e in events if parse_time(e["commence_time"]) <= cutoff]
    per_event = props_cost_per_event(sport)
    return {
        "events": [{"id": e["id"], "name": f"{e['away_team']} @ {e['home_team']}",
                    "commence_time": e["commence_time"], "preseason": is_preseason(e["sport_key"])}
                   for e in events],
        "per_event_cost": per_event,
        "max_cost": per_event * len(events),
    }


def refresh_props(
    store: Store, client: OddsAPIClient, sport: str, event_ids: list[str], media: Media | None = None
) -> dict:
    """Props for the given games, one billed call each. Stops early (keeping
    what it already saved) if the remaining credits can't cover the next call."""
    markets = PROP_MARKETS[sport]
    per_event = props_cost_per_event(sport)
    upcoming = {e["id"]: e for e in upcoming_events(client, sport)}
    targets = [eid for eid in event_ids if eid in upcoming]
    if not targets:
        raise RefreshRefused("None of those games are upcoming, so no credits were spent")
    _check_quota(store, per_event)

    spent, done, empty, last_usage, stopped = 0, 0, 0, None, None
    for eid in targets:
        try:
            _check_quota(store, per_event)
        except RefreshRefused as e:
            stopped = str(e)
            break
        payload, used = client.event_odds(upcoming[eid]["sport_key"], eid, markets, BOOKS)
        payload.setdefault("sport_key", upcoming[eid]["sport_key"])
        last_usage = asdict(used)
        spent += used.last or 0
        has_props = any(bm.get("markets") for bm in payload.get("bookmakers", []))
        store.save_fetch(sport, [payload], markets=markets, books=BOOKS, usage=last_usage,
                         kind="props", event_id=eid)
        done += 1
        empty += not has_props
        if media and has_props:
            media.ensure_rosters(sport, [payload["home_team"], payload["away_team"]])
    return {"games": done, "games_without_props": empty, "cost": spent, "usage": last_usage, "stopped": stopped}
