"""Bundle ESPN team logos/colors and rosters (headshots) for the web app.

ESPN's site API doesn't allow browser (CORS) requests, so the phone app can't
fetch it directly; its images do load fine. Run this now and then (rosters
change) and redeploy:

    .venv/bin/python tools/build_media.py            # every sport
    .venv/bin/python tools/build_media.py soccer     # just these, keeping the rest

Writes web/data/media.json:
  {"built_at": ..., "sports": {sport: {"teams": [[espn_id, display, location, nickname, abbr, logo, color], ...],
                                        "players": {espn_team_id: [[name, headshot_id|null, jersey, pos], ...]}}}}
Headshot URLs are rebuilt from the id: https://a.espncdn.com/i/headshots/{league}/players/full/{id}.png
"""
from __future__ import annotations

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from oddscreen.config import ESPN_PATHS, ESPN_SOCCER_PATHS  # noqa: E402

BASE = "https://site.api.espn.com/apis/site/v2/sports"
HEADSHOT_ID = re.compile(r"/players/full/(\d+)\.png")


def teams(client: httpx.Client, path: str) -> list[dict]:
    r = client.get(f"{BASE}/{path}/teams", params={"limit": 1000})
    r.raise_for_status()
    return [t["team"] for t in r.json()["sports"][0]["leagues"][0]["teams"]]


def team_row(t: dict, nickname: str | None) -> list:
    return [t["id"], t.get("displayName", ""), t.get("location"), nickname, t.get("abbreviation"),
            (t.get("logos") or [{}])[0].get("href"), t.get("color")]


def soccer(client: httpx.Client) -> dict:
    """Clubs from every league feed, once each (UCL clubs repeat). The short
    name ("Spurs", "Inter Milan") goes in the nickname slot for matching."""
    clubs: dict[str, dict] = {}
    for path in ESPN_SOCCER_PATHS:
        for t in teams(client, path):
            clubs.setdefault(t["id"], t)
    print(f"soccer: {len(clubs)} clubs")
    return {"teams": [team_row(t, t.get("shortDisplayName")) for t in clubs.values()], "players": {}}


def roster(client: httpx.Client, sport: str, team_id: str) -> list[list]:
    try:
        r = client.get(f"{BASE}/{ESPN_PATHS[sport]}/teams/{team_id}/roster")
        r.raise_for_status()
        athletes = r.json().get("athletes", [])
    except (httpx.HTTPError, ValueError) as e:
        print(f"  roster {sport}/{team_id} failed: {e}")
        return []
    if athletes and "items" in athletes[0]:  # NFL groups by offense/defense/...
        athletes = [a for group in athletes for a in group["items"]]
    out = []
    for a in athletes:
        href = (a.get("headshot") or {}).get("href") or ""
        m = HEADSHOT_ID.search(href)
        out.append([a.get("fullName") or a.get("displayName", ""), m.group(1) if m else None,
                    a.get("jersey"), (a.get("position") or {}).get("abbreviation")])
    return out


def main() -> None:
    out = ROOT / "web" / "data" / "media.json"
    only = set(sys.argv[1:])
    unknown = only - set(ESPN_PATHS) - {"soccer"}
    if unknown:
        sys.exit(f"unknown sport(s): {', '.join(sorted(unknown))}")
    data = {"built_at": datetime.now(timezone.utc).isoformat(), "sports": {}}
    if only and out.exists():
        data["sports"] = json.loads(out.read_text())["sports"]
    with httpx.Client(timeout=15) as client, ThreadPoolExecutor(8) as pool:
        for sport in ESPN_PATHS:
            if only and sport not in only:
                continue
            ts = teams(client, ESPN_PATHS[sport])
            rosters = list(pool.map(lambda t: roster(client, sport, t["id"]), ts))
            data["sports"][sport] = {
                "teams": [team_row(t, t.get("name")) for t in ts],
                "players": {t["id"]: r for t, r in zip(ts, rosters) if r},
            }
            n = sum(len(r) for r in rosters)
            print(f"{sport}: {len(ts)} teams, {n} players")
        if not only or "soccer" in only:
            data["sports"]["soccer"] = soccer(client)
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
