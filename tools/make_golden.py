"""Freeze the Python engine's outputs on real snapshots so the JavaScript port
can be checked against them (tests/web/parity.test.mjs).

    .venv/bin/python tools/make_golden.py

Writes tests/golden/{sport}.json: the raw rows (fetches, events, prices) up to a
cutoff, plus every engine's output on them. Real odds data, so it's gitignored.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from oddscreen import config  # noqa: E402
from oddscreen.ev import find_ev  # noqa: E402
from oddscreen.middles import find_low_hold, find_middles  # noqa: E402
from oddscreen.odds_math import devig  # noqa: E402
from oddscreen.parlay import LegSpec, analyze, generate, joint_win_prob, metrics, price_legs  # noqa: E402
from oddscreen.screen import build_prop_screen, build_screen, props_summary  # noqa: E402
from oddscreen.store import Store, parse_time  # noqa: E402

OUT = ROOT / "tests" / "golden"
CASES = {
    # sport: (last fetch id to include, "now" for the upcoming filter)
    "nfl": (38, "2026-10-09T04:30:00+00:00"),
    "nba": (53, "2026-10-10T04:30:00+00:00"),
}
BETTABLE = set(config.BOOKS) - {config.REFERENCE_BOOK}


def rows(conn: sqlite3.Connection, sql: str, args=()) -> list[dict]:
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql, args)]


def build(sport: str, last_id: int, now_iso: str) -> dict:
    src = sqlite3.connect(config.DB_PATH)
    fetches = rows(src, "SELECT * FROM fetches WHERE sport=? AND id<=? ORDER BY id", (sport, last_id))
    ids = [f["id"] for f in fetches]
    prices = rows(src, f"SELECT * FROM prices WHERE fetch_id IN ({','.join('?' * len(ids))}) ORDER BY rowid", ids)
    ev_ids = sorted({p["event_id"] for p in prices})
    events = rows(src, f"SELECT * FROM events WHERE id IN ({','.join('?' * len(ev_ids))})", ev_ids)

    # Run the engines on a store holding exactly these rows.
    tmp = Path(tempfile.mkdtemp()) / "golden.db"
    store = Store(tmp)
    with store.conn() as c:
        cols = lambda r: ",".join(r)  # noqa: E731
        for table, data in (("fetches", fetches), ("events", events), ("prices", prices)):
            for r in data:
                c.execute(f"INSERT INTO {table} ({cols(r)}) VALUES ({','.join('?' * len(r))})", list(r.values()))

    now = parse_time(now_iso)
    fetch, evs, prs = store.snapshot(sport)
    previous = store.previous_prices(sport)
    out: dict = {"now": now_iso, "bettable": sorted(BETTABLE),
                 "rows": {"fetches": fetches, "events": events, "prices": prices}, "cases": {}}
    cases = out["cases"]

    def kind(ps, k):
        return ps if k == "all" else [p for p in ps if config.is_prop(p.market) == (k == "props")]

    ev_params = [
        {"kind": "all", "method": "power", "min_ev": -1.0, "min_books": 3, "kelly_mult": 0.25, "bankroll": 1000.0},
        {"kind": "props", "method": "worst_case", "min_ev": 0.0, "min_books": 3, "kelly_mult": 0.5, "bankroll": 2500.0},
        {"kind": "main", "method": "multiplicative", "min_ev": 0.01, "min_books": 2, "kelly_mult": 0.25, "bankroll": 1000.0},
        {"kind": "all", "method": "additive", "min_ev": 0.0, "min_books": 3, "kelly_mult": 0.25, "bankroll": 1000.0},
    ]
    cases["ev"] = []
    for prm in ev_params:
        p = dict(prm)
        k = p.pop("kind")
        cases["ev"].append({"params": prm, "out": find_ev(
            evs, kind(prs, k), bettable=BETTABLE, reference=config.REFERENCE_BOOK, now=now, **p)})

    cases["screen"] = []
    for market in config.MAIN_MARKETS:
        opening = store.opening_prices(list(evs), [market])
        cases["screen"].append({"market": market, "out": build_screen(
            evs, prs, market=market, bettable=BETTABLE, reference=config.REFERENCE_BOOK, method="power",
            previous=previous, opening=opening, now=now)})

    cases["props_summary"] = props_summary(evs, prs, store.props_fetched(sport), now=now)
    cases["prop_screen"] = []
    prop_events = [e["id"] for e in cases["props_summary"] if e["n_players"]][:3]
    for eid in prop_events:
        ps = [p for p in kind(prs, "props") if p.event_id == eid]
        cases["prop_screen"].append({"event_id": eid, "out": build_prop_screen(
            evs[eid], ps, bettable=BETTABLE, reference=config.REFERENCE_BOOK, method="power", previous=previous,
            opening=store.opening_prices([eid], config.PROP_MARKETS[sport]))})

    cases["middles"] = find_middles(evs, prs, bettable=BETTABLE, now=now, total_stake=100.0)
    cases["lowhold"] = find_low_hold(evs, prs, bettable=BETTABLE, now=now)

    # Parlays built from real +EV rows: cross-game, same-game (+quote), boosted, thin-line.
    snaps = {sport: (evs, prs)}
    ev_rows = cases["ev"][0]["out"]
    by_event: dict[str, dict] = {}
    for r in ev_rows:
        by_event.setdefault(r["event_id"], r)
    cross = [r for r in by_event.values()][:3]
    spec = lambda r: {"sport": sport, "event_id": r["event_id"], "market": r["market"], "outcome": r["outcome"],  # noqa: E731
                      "point": r["point"], "description": r["player"], "book": r["book"]}
    same_game = []
    for eid in by_event:
        legs = [r for r in ev_rows if r["event_id"] == eid]
        mk = {}
        for r in legs:
            mk.setdefault((r["market"], r["player"]), r)
        if len(mk) >= 2:
            same_game = list(mk.values())[:2]
            break
    parlay_cases = [
        {"name": "cross", "legs": [spec(r) for r in cross], "rho": [], "boost": 0.0, "quote": None, "book": cross[0]["book"]},
        {"name": "cross_boost", "legs": [spec(r) for r in cross[:2]], "rho": [], "boost": 0.25, "quote": None, "book": None},
    ]
    if same_game:
        legs = [spec(r) for r in same_game]
        ids = [LegSpec(**l).id for l in legs]
        parlay_cases.append({"name": "sgp_quote", "legs": legs, "rho": [[ids[0], ids[1], 0.3]], "boost": 0.0,
                             "quote": [same_game[0]["book"], 3.4], "book": same_game[0]["book"]})
        parlay_cases.append({"name": "sgp_noquote", "legs": legs, "rho": [[ids[0], ids[1], 0.45]], "boost": 0.1,
                             "quote": None, "book": None})
    # an off-market line: shift one leg's point to a line few books post
    alts = [p for p in prs if p.point is not None and not config.is_prop(p.market)]
    seen: dict = {}
    for p in alts:
        seen.setdefault((p.event_id, p.market, p.outcome, p.point), set()).add(p.book)
    thin = next(((k, b) for k, b in seen.items() if len(b) == 1 and evs[k[0]].commence_time > now), None)
    if thin:
        (eid, market, outcome, point), books = thin
        parlay_cases.append({"name": "thin", "legs": [{"sport": sport, "event_id": eid, "market": market, "outcome": outcome,
                             "point": point, "description": None}, spec(cross[1])], "rho": [], "boost": 0.0,
                             "quote": None, "book": next(iter(books))})
    cases["parlay"] = []
    for pc in parlay_cases:
        legs = price_legs([LegSpec(**l) for l in pc["legs"]], snaps, method="power",
                          reference=config.REFERENCE_BOOK, min_books=3)
        res = analyze(legs, rho={frozenset((a, b)): r for a, b, r in pc["rho"]}, bettable=BETTABLE,
                      boost=pc["boost"], sgp_quote=tuple(pc["quote"]) if pc["quote"] else None,
                      kelly_mult=0.25, bankroll=1000.0, max_stake_pct=0.01, book=pc["book"])
        cases["parlay"].append({**pc, "out": res})

    gen_params = [
        {"kind": "all", "min_legs": 2, "max_legs": 4, "min_decimal": 1.0, "max_decimal": 1e9, "min_leg_ev": 0.0,
         "boost": 0.0, "sort": "ev", "max_reuse": 3, "limit": 50},
        {"kind": "all", "min_legs": 2, "max_legs": 6, "min_decimal": 3.0, "max_decimal": 60.0, "min_leg_ev": -0.01,
         "boost": 0.25, "sort": "growth", "max_reuse": 2, "limit": 40},
        {"kind": "props", "min_legs": 2, "max_legs": 3, "min_decimal": 1.0, "max_decimal": 1e9, "min_leg_ev": 0.0,
         "boost": 0.0, "sort": "ev", "max_reuse": 3, "limit": 30},
    ]
    cases["generate"] = []
    for gp in gen_params:
        cases["generate"].append({"params": gp, "out": generate(
            snaps, bettable=BETTABLE, reference=config.REFERENCE_BOOK, method="power", min_books=3, now=now,
            kelly_mult=0.25, bankroll=1000.0, max_stake_pct=0.01, **gp)})

    cases["history"] = store.history(prop_events[0], "player_reception_yds") if prop_events and sport == "nfl" else \
        store.history(next(iter(evs)), "h2h")
    return out


def math_cases() -> dict:
    arrays = [[1.91, 1.91], [1.4, 3.1], [1.25, 4.5], [2.5, 1.6], [1.05, 13.0], [3.2, 3.4, 2.3]]
    corr = []
    for probs, r in [
        ([0.5, 0.5], 0.3), ([0.62, 0.41], 0.25), ([0.3, 0.7], -0.2), ([0.55, 0.48], 0.6),
    ]:
        corr.append({"probs": probs, "rho": r, "p": joint_win_prob(probs, np.array([[1, r], [r, 1]]))})
    for probs, m in [
        ([0.55, 0.5, 0.45], [[1, .3, .2], [.3, 1, .4], [.2, .4, 1]]),
        ([0.6, 0.52, 0.47, 0.5], [[1, .2, .1, .3], [.2, 1, .25, .1], [.1, .25, 1, .2], [.3, .1, .2, 1]]),
        ([0.5, 0.5, 0.5], [[1, .9, .9], [.9, 1, -.5], [.9, -.5, 1]]),  # not PSD: exercises the eigen fix
    ]:
        corr.append({"probs": probs, "matrix": m, "p": joint_win_prob(probs, np.array(m, dtype=float))})
    return {
        "devig": [{"decimals": a, "method": m, "out": devig(a, m)}
                  for a in arrays for m in ("multiplicative", "additive", "power", "worst_case")],
        "metrics": [{"args": a, "out": metrics(a[0], a[1], boost=a[2], kelly_mult=a[3], bankroll=a[4], max_stake_pct=a[5])}
                    for a in [(0.25, 3.6, 0.0, 0.25, 1000, 0.01), (0.25, 3.6, 0.5, 0.25, 1000, 0.01),
                              (0.08, 15.5, 0.0, 0.5, 2000, 0.05), (0.6, 1.8, 0.2, 1.0, 500, 1.0)]],
        "joint": corr,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for sport, (last_id, now) in CASES.items():
        data = build(sport, last_id, now)
        (OUT / f"{sport}.json").write_text(json.dumps(data, default=str))
        c = data["cases"]
        print(f"{sport}: {len(data['rows']['prices'])} prices | ev {[len(x['out']) for x in c['ev']]} | "
              f"middles {len(c['middles'])} | lowhold {len(c['lowhold'])} | props screens {len(c['prop_screen'])} | "
              f"parlays {[p['name'] for p in c['parlay']]} | gen {[len(g['out']) for g in c['generate']]}")
    (OUT / "math.json").write_text(json.dumps(math_cases()))
    print("math cases written")


if __name__ == "__main__":
    main()
