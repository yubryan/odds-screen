"""Bundle ESPN team logos/colors and rosters (headshots) for the web app.

ESPN's site API doesn't allow browser (CORS) requests, so the phone app can't
fetch it directly; its images do load fine. Run this now and then (rosters
change) and redeploy:

    .venv/bin/python tools/build_media.py

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
from oddscreen.config import ESPN_PATHS  # noqa: E402

BASE = "https://site.api.espn.com/apis/site/v2/sports"
HEADSHOT_ID = re.compile(r"/players/full/(\d+)\.png")


def teams(client: httpx.Client, sport: str) -> list[dict]:
    r = client.get(f"{BASE}/{ESPN_PATHS[sport]}/teams", params={"limit": 1000})
    r.raise_for_status()
    return [t["team"] for t in r.json()["sports"][0]["leagues"][0]["teams"]]


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
    data = {"built_at": datetime.now(timezone.utc).isoformat(), "sports": {}}
    with httpx.Client(timeout=15) as client, ThreadPoolExecutor(8) as pool:
        for sport in ESPN_PATHS:
            ts = teams(client, sport)
            rosters = list(pool.map(lambda t: roster(client, sport, t["id"]), ts))
            data["sports"][sport] = {
                "teams": [[t["id"], t.get("displayName", ""), t.get("location"), t.get("name"), t.get("abbreviation"),
                           (t.get("logos") or [{}])[0].get("href"), t.get("color")] for t in ts],
                "players": {t["id"]: r for t, r in zip(ts, rosters) if r},
            }
            n = sum(len(r) for r in rosters)
            print(f"{sport}: {len(ts)} teams, {n} players")
    out = ROOT / "web" / "data" / "media.json"
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
