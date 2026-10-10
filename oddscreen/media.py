"""Team logos/colors and player headshots from ESPN's public site API.

Everything is cached in SQLite: the team list for 7 days, each roster for 24h.
Lookups used by the UI only read the cache; network calls happen during
refreshes (teams with main lines, the two rosters with a game's props), so
browsing never waits on ESPN. Images themselves load straight from ESPN's CDN.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import httpx

from .config import ESPN_PATHS
from .store import Store, parse_time

log = logging.getLogger(__name__)

BASE_URL = "https://site.api.espn.com/apis/site/v2/sports"
TEAMS_TTL = timedelta(days=7)
ROSTER_TTL = timedelta(hours=24)

SCHEMA = """
CREATE TABLE IF NOT EXISTS media_teams (
    sport TEXT NOT NULL, espn_id TEXT NOT NULL, display TEXT NOT NULL, location TEXT,
    nickname TEXT, abbr TEXT, logo TEXT, color TEXT,
    PRIMARY KEY (sport, espn_id)
);
CREATE TABLE IF NOT EXISTS media_players (
    sport TEXT NOT NULL, espn_team_id TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
    headshot TEXT, jersey TEXT, position TEXT,
    PRIMARY KEY (sport, espn_team_id, name_key)
);
"""

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm(name: str) -> str:
    """'Kenneth Walker III' / 'Amon-Ra St. Brown' -> comparable key."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[.'’]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(w for w in s.split() if w not in _SUFFIXES)


def _fresh(stamp: str | None, ttl: timedelta) -> bool:
    return bool(stamp) and datetime.now(timezone.utc) - parse_time(stamp) < ttl


def match_team(name: str, teams: list[dict]) -> dict | None:
    """Odds API team name -> ESPN team. Exact on full name first, then by
    nickname ('Los Angeles Clippers' vs ESPN 'LA Clippers'), using location
    overlap to break ties (college nicknames repeat)."""
    n = norm(name)
    for t in teams:
        if n in (norm(t["display"]), norm(f"{t['location']} {t['nickname']}")):
            return t
    words = set(n.split())
    candidates = [t for t in teams if t["nickname"] and (n.endswith(" " + norm(t["nickname"])) or n == norm(t["nickname"]))]
    if len(candidates) == 1:
        return candidates[0]
    scored = [(len(set(norm(t["location"] or "").split()) & words), t) for t in candidates]
    scored = [s for s in scored if s[0] > 0]
    return max(scored, key=lambda s: s[0])[1] if scored else None


class Media:
    def __init__(self, store: Store, http: httpx.Client | None = None):
        self.store = store
        self.http = http or httpx.Client(base_url=BASE_URL, timeout=10)
        with store.conn() as c:
            c.executescript(SCHEMA)

    # ---- network (called from refreshes; failures are logged, never raised) ----

    def ensure_teams(self, sport: str) -> None:
        stamp_key = f"media:teams:{sport}"
        if _fresh(self.store.kv(stamp_key), TEAMS_TTL):
            return
        try:
            resp = self.http.get(f"/{ESPN_PATHS[sport]}/teams", params={"limit": 1000})
            resp.raise_for_status()
            teams = [t["team"] for t in resp.json()["sports"][0]["leagues"][0]["teams"]]
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
            log.warning("ESPN teams fetch failed for %s: %s", sport, e)
            return
        rows = [
            (sport, t["id"], t.get("displayName", ""), t.get("location"), t.get("name"),
             t.get("abbreviation"), (t.get("logos") or [{}])[0].get("href"), t.get("color"))
            for t in teams
        ]
        with self.store.conn() as c:
            c.execute("DELETE FROM media_teams WHERE sport=?", (sport,))
            c.executemany("INSERT INTO media_teams VALUES (?,?,?,?,?,?,?,?)", rows)
        self.store.set_kv(stamp_key, datetime.now(timezone.utc).isoformat())

    def ensure_rosters(self, sport: str, team_names: list[str]) -> None:
        self.ensure_teams(sport)
        teams = self._teams(sport)
        for name in team_names:
            team = match_team(name, teams)
            if team is None:
                continue
            stamp_key = f"media:roster:{sport}:{team['espn_id']}"
            if _fresh(self.store.kv(stamp_key), ROSTER_TTL):
                continue
            try:
                resp = self.http.get(f"/{ESPN_PATHS[sport]}/teams/{team['espn_id']}/roster")
                resp.raise_for_status()
                athletes = resp.json().get("athletes", [])
            except (httpx.HTTPError, ValueError) as e:
                log.warning("ESPN roster fetch failed for %s: %s", name, e)
                continue
            if athletes and "items" in athletes[0]:  # NFL groups by offense/defense/...
                athletes = [a for group in athletes for a in group["items"]]
            rows = [
                (sport, team["espn_id"], norm(a.get("fullName") or a.get("displayName", "")),
                 a.get("fullName") or a.get("displayName", ""), (a.get("headshot") or {}).get("href"),
                 a.get("jersey"), (a.get("position") or {}).get("abbreviation"))
                for a in athletes
            ]
            with self.store.conn() as c:
                c.execute("DELETE FROM media_players WHERE sport=? AND espn_team_id=?", (sport, team["espn_id"]))
                c.executemany("INSERT OR REPLACE INTO media_players VALUES (?,?,?,?,?,?,?)", rows)
            self.store.set_kv(stamp_key, datetime.now(timezone.utc).isoformat())

    # ---- cache-only lookups ----

    def _teams(self, sport: str) -> list[dict]:
        with self.store.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM media_teams WHERE sport=?", (sport,))]

    def team_map(self, sport: str, names: set[str]) -> dict[str, dict]:
        teams = self._teams(sport)
        out = {}
        for name in names:
            t = match_team(name, teams)
            if t:
                out[name] = {"logo": t["logo"], "abbr": t["abbr"], "color": t["color"], "espn_id": t["espn_id"]}
        return out

    def player_map(self, sport: str, wanted: list[tuple[str, str, str, str]]) -> dict[str, dict]:
        """wanted: (event_id, home, away, player) -> {"event_id|player": info}.
        Searched only within the game's two rosters, so same-named players
        on other teams can't collide."""
        teams = self._teams(sport)
        with self.store.conn() as c:
            rows = [dict(r) for r in c.execute("SELECT * FROM media_players WHERE sport=?", (sport,))]
        by_team: dict[str, list[dict]] = {}
        for r in rows:
            by_team.setdefault(r["espn_team_id"], []).append(r)

        out = {}
        for event_id, home, away, player in wanted:
            pool = []
            for team_name in (home, away):
                t = match_team(team_name, teams)
                if t:
                    pool += [{**r, "team_abbr": t["abbr"]} for r in by_team.get(t["espn_id"], [])]
            key = norm(player)
            hit = next((r for r in pool if r["name_key"] == key), None)
            if hit is None and key:  # "Gabe Davis" vs "Gabriel Davis": last name + first initial
                parts = key.split()
                loose = [r for r in pool if r["name_key"].split()[-1:] == parts[-1:]
                         and r["name_key"][:1] == key[:1]]
                hit = loose[0] if len(loose) == 1 else None
            if hit:
                out[f"{event_id}|{player}"] = {
                    "headshot": hit["headshot"], "jersey": hit["jersey"],
                    "position": hit["position"], "team": hit["team_abbr"],
                }
        return out
