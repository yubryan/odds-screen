"""SQLite history of every odds fetch. Each refresh appends a snapshot.

Main lines are fetched per sport (kind='main'); props per event (kind='props',
event_id set). The "current" view of a sport is its latest main fetch plus the
latest props fetch of every event.
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .models import Event, Price

SCHEMA = """
CREATE TABLE IF NOT EXISTS fetches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    markets TEXT NOT NULL,
    books TEXT NOT NULL,
    n_events INTEGER NOT NULL,
    credits_last INTEGER,
    credits_remaining INTEGER,
    credits_used INTEGER,
    kind TEXT NOT NULL DEFAULT 'main',
    event_id TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    sport TEXT NOT NULL,
    commence_time TEXT NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    league TEXT
);
CREATE TABLE IF NOT EXISTS prices (
    fetch_id INTEGER NOT NULL REFERENCES fetches(id),
    event_id TEXT NOT NULL REFERENCES events(id),
    book TEXT NOT NULL,
    market TEXT NOT NULL,
    outcome TEXT NOT NULL,
    description TEXT,
    point REAL,
    price REAL NOT NULL,
    last_update TEXT,
    link TEXT
);
CREATE INDEX IF NOT EXISTS ix_prices_fetch ON prices(fetch_id);
CREATE INDEX IF NOT EXISTS ix_prices_event ON prices(event_id, market);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""

# Columns added after the first release; ALTERed into older databases.
_MIGRATIONS = {
    "fetches": {"kind": "TEXT NOT NULL DEFAULT 'main'", "event_id": "TEXT"},
    "events": {"league": "TEXT"},
}

PriceKey = tuple[str, str, str, str, str]  # event, book, market, outcome, description


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _row_to_price(r: sqlite3.Row) -> Price:
    return Price(
        event_id=r["event_id"], book=r["book"], market=r["market"], outcome=r["outcome"],
        price=r["price"], point=r["point"], description=r["description"],
        last_update=r["last_update"], link=r["link"], fetched_at=r["fetched_at"],
    )


def price_key(p: Price) -> PriceKey:
    return (p.event_id, p.book, p.market, p.outcome, p.description or "")


def _in(ids: list) -> str:
    return ",".join("?" * len(ids))


class Store:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)
            for table, cols in _MIGRATIONS.items():
                have = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
                for col, ddl in cols.items():
                    if col not in have:
                        c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
            c.execute("CREATE INDEX IF NOT EXISTS ix_fetches_sport ON fetches(sport, kind, event_id)")

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ---- writes -------------------------------------------------------------

    def save_fetch(
        self,
        sport: str,
        payload: list[dict],
        *,
        markets: list[str],
        books: list[str],
        usage: dict[str, int | None] | None = None,
        fetched_at: datetime | None = None,
        kind: str = "main",
        event_id: str | None = None,
    ) -> int:
        usage = usage or {}
        fetched_at = fetched_at or datetime.now(timezone.utc)
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO fetches (sport, fetched_at, markets, books, n_events, credits_last,"
                " credits_remaining, credits_used, kind, event_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (sport, fetched_at.isoformat(), ",".join(markets), ",".join(books), len(payload),
                 usage.get("last"), usage.get("remaining"), usage.get("used"), kind, event_id),
            )
            fetch_id = cur.lastrowid
            rows = []
            for ev in payload:
                c.execute(
                    "INSERT INTO events (id, sport, commence_time, home, away, league) VALUES (?,?,?,?,?,?)"
                    " ON CONFLICT(id) DO UPDATE SET commence_time=excluded.commence_time,"
                    " home=excluded.home, away=excluded.away, league=COALESCE(excluded.league, league)",
                    (ev["id"], sport, ev["commence_time"], ev["home_team"], ev["away_team"], ev.get("sport_key")),
                )
                for bm in ev.get("bookmakers", []):
                    for mk in bm.get("markets", []):
                        updated = mk.get("last_update") or bm.get("last_update")
                        for o in mk.get("outcomes", []):
                            rows.append((
                                fetch_id, ev["id"], bm["key"], mk["key"], o["name"], o.get("description"),
                                o.get("point"), o["price"], updated,
                                o.get("link") or mk.get("link") or bm.get("link"),
                            ))
            c.executemany(
                "INSERT INTO prices (fetch_id, event_id, book, market, outcome, description, point,"
                " price, last_update, link) VALUES (?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
        if usage.get("remaining") is not None:
            self.set_usage(usage)
        return fetch_id

    def set_usage(self, usage: dict[str, Any]) -> None:
        self.set_kv("usage", {**usage, "at": datetime.now(timezone.utc).isoformat()})

    def set_kv(self, key: str, value: Any) -> None:
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", (key, json.dumps(value)))

    # ---- reads --------------------------------------------------------------

    def kv(self, key: str) -> Any:
        with self.conn() as c:
            row = c.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
        return json.loads(row["v"]) if row else None

    def usage(self) -> dict[str, Any] | None:
        return self.kv("usage")

    def latest_fetch(self, sport: str) -> dict | None:
        """Latest main-lines fetch."""
        with self.conn() as c:
            row = c.execute(
                "SELECT * FROM fetches WHERE sport=? AND kind='main' ORDER BY id DESC LIMIT 1", (sport,)
            ).fetchone()
        return dict(row) if row else None

    def snapshot_fetch_ids(self, sport: str, offset: int = 0) -> list[int]:
        """Fetches making up the current view (offset=0) or the one before it (offset=1):
        the Nth-latest main fetch plus the Nth-latest props fetch per event."""
        with self.conn() as c:
            rows = c.execute(
                "SELECT id, kind, event_id FROM fetches WHERE sport=? ORDER BY id DESC", (sport,)
            ).fetchall()
        seen: dict[tuple, int] = defaultdict(int)
        out = []
        for r in rows:
            scope = (r["kind"], r["event_id"])
            if seen[scope] == offset:
                out.append(r["id"])
            seen[scope] += 1
        return out

    def props_fetched(self, sport: str) -> dict[str, str]:
        """event_id -> time of its latest props fetch."""
        with self.conn() as c:
            rows = c.execute(
                "SELECT event_id, MAX(fetched_at) AS t FROM fetches WHERE sport=? AND kind='props'"
                " GROUP BY event_id", (sport,)
            ).fetchall()
        return {r["event_id"]: r["t"] for r in rows}

    def _prices(self, fetch_ids: list[int]) -> list[Price]:
        if not fetch_ids:
            return []
        with self.conn() as c:
            rows = c.execute(
                "SELECT p.*, f.fetched_at FROM prices p JOIN fetches f ON f.id = p.fetch_id"
                f" WHERE p.fetch_id IN ({_in(fetch_ids)})", fetch_ids,
            ).fetchall()
        return [_row_to_price(r) for r in rows]

    def events(self, ids: list[str]) -> dict[str, Event]:
        if not ids:
            return {}
        with self.conn() as c:
            rows = c.execute(f"SELECT * FROM events WHERE id IN ({_in(ids)})", ids).fetchall()
        return {
            r["id"]: Event(r["id"], r["sport"], parse_time(r["commence_time"]), r["home"], r["away"], r["league"])
            for r in rows
        }

    def snapshot(self, sport: str) -> tuple[dict | None, dict[str, Event], list[Price]]:
        """Current view of a sport: (latest main fetch row, events by id, prices)."""
        prices = self._prices(self.snapshot_fetch_ids(sport))
        events = self.events(sorted({p.event_id for p in prices}))
        return self.latest_fetch(sport), events, prices

    def previous_prices(self, sport: str) -> dict[PriceKey, Price]:
        """Prices from the snapshot before the current one (for movement arrows)."""
        return {price_key(p): p for p in self._prices(self.snapshot_fetch_ids(sport, offset=1))}

    def opening_prices(self, event_ids: list[str], markets: list[str] | None = None) -> dict[PriceKey, Price]:
        """First price we ever recorded for each (event, book, market, outcome, player)."""
        if not event_ids:
            return {}
        sql = f"SELECT p.*, f.fetched_at FROM prices p JOIN fetches f ON f.id = p.fetch_id WHERE p.event_id IN ({_in(event_ids)})"
        args: list = list(event_ids)
        if markets:
            sql += f" AND p.market IN ({_in(markets)})"
            args += markets
        with self.conn() as c:
            rows = c.execute(sql + " ORDER BY p.fetch_id ASC", args).fetchall()
        opening: dict[PriceKey, Price] = {}
        for r in rows:
            p = _row_to_price(r)
            opening.setdefault(price_key(p), p)
        return opening

    def history(self, event_id: str, market: str, description: str | None = None) -> list[dict]:
        sql = (
            "SELECT f.fetched_at, p.book, p.outcome, p.description, p.point, p.price"
            " FROM prices p JOIN fetches f ON f.id = p.fetch_id WHERE p.event_id=? AND p.market=?"
        )
        args: list = [event_id, market]
        if description:
            sql += " AND p.description=?"
            args.append(description)
        with self.conn() as c:
            rows = c.execute(sql + " ORDER BY f.id, p.book, p.outcome", args).fetchall()
        return [dict(r) for r in rows]
