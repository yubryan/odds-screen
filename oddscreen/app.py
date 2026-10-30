"""FastAPI app: JSON API under /api, single-page UI from /static."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .ev import find_ev
from .media import Media
from .middles import find_low_hold, find_middles
from .models import Price
from .odds_api import OddsAPIClient, OddsAPIError
from .odds_math import DEVIG_METHODS, american_to_decimal
from .parlay import LegSpec, ParlayError, analyze, generate, price_legs
from .screen import build_prop_screen, build_screen, props_summary
from .service import RefreshRefused, props_plan, refresh_props, refresh_sport
from .store import Store

app = FastAPI(title="Odds Screen")
store = Store(config.DB_PATH)
media = Media(store)
_client: OddsAPIClient | None = None

Kind = Literal["all", "main", "props"]


def client() -> OddsAPIClient:
    global _client
    if _client is None:
        _client = OddsAPIClient(config.API_KEY)
    return _client


def _sport(sport: str) -> str:
    if sport not in config.SPORTS:
        raise HTTPException(404, f"unknown sport {sport!r}")
    return sport


def _bettable(books: str | None) -> set[str]:
    chosen = set(books.split(",")) if books else set(config.BOOKS)
    return chosen - {config.REFERENCE_BOOK}


def _method(method: str) -> str:
    if method not in DEVIG_METHODS:
        raise HTTPException(400, f"method must be one of {sorted(DEVIG_METHODS)}")
    return method


def _of_kind(prices: list[Price], kind: Kind) -> list[Price]:
    if kind == "all":
        return prices
    want_props = kind == "props"
    return [p for p in prices if config.is_prop(p.market) == want_props]


def _snapshot(sport: str, kind: Kind = "all"):
    fetch, events, prices = store.snapshot(_sport(sport))
    return fetch, events, _of_kind(prices, kind), datetime.now(timezone.utc)


def _guarded(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except RefreshRefused as e:
        raise HTTPException(409, str(e))
    except OddsAPIError as e:
        raise HTTPException(502, str(e))


@app.get("/api/meta")
def meta():
    sports = []
    for alias, s in config.SPORTS.items():
        fetch = store.latest_fetch(alias)
        props = store.props_fetched(alias)
        sports.append({
            "id": alias,
            "title": s["title"],
            "last_fetch": fetch["fetched_at"] if fetch else None,
            "last_props_fetch": max(props.values()) if props else None,
            "events": fetch["n_events"] if fetch else 0,
            "prop_markets": [{"key": m, "title": config.market_title(m)} for m in config.PROP_MARKETS[alias]],
            "props_cost_per_event": config.props_cost_per_event(alias),
            # upper bound: one bulk call per feed (e.g. NBA + preseason); empty feeds are skipped
            "refresh_cost": config.refresh_cost() * len(s["keys"]),
        })
    return {
        "sports": sports,
        "books": [{"key": b, "title": config.book_title(b), "reference": b == config.REFERENCE_BOOK,
                   "color": config.BOOK_COLORS.get(b, "#888")} for b in config.BOOKS],
        "reference": config.REFERENCE_BOOK,
        "markets": [{"key": m, "title": config.market_title(m)} for m in config.MAIN_MARKETS],
        "methods": list(DEVIG_METHODS),
        "refresh_cost": config.refresh_cost(),
        "usage": store.usage(),
        "has_key": bool(config.API_KEY),
    }


# ---- refreshes (the only routes that spend credits) ---------------------------

@app.post("/api/refresh/{sport}")
def refresh(sport: str):
    return _guarded(refresh_sport, store, client(), _sport(sport), media)


@app.get("/api/props/plan")
def plan(sport: str, hours: float | None = Query(None, gt=0)):
    return _guarded(props_plan, client(), _sport(sport), hours)


class PropsRequest(BaseModel):
    event_ids: list[str]


@app.post("/api/props/refresh/{sport}")
def refresh_props_route(sport: str, req: PropsRequest):
    if not req.event_ids:
        raise HTTPException(400, "no games selected")
    return _guarded(refresh_props, store, client(), _sport(sport), req.event_ids, media)


# ---- tools (read the local snapshot only) --------------------------------------

@app.get("/api/ev")
def ev(
    sport: str,
    kind: Kind = "all",
    method: str = "power",
    min_ev: float = 0.0,
    books: str | None = None,
    kelly: float = Query(0.25, ge=0, le=1),
    bankroll: float = Query(1000.0, gt=0),
    min_books: int = Query(3, ge=1),
    fair: Literal["auto", "pinnacle", "consensus"] = "auto",
    weighted: bool = True,
    max_width: float | None = None,
):
    fetch, events, prices, now = _snapshot(sport, kind)
    rows = find_ev(
        events, prices, bettable=_bettable(books), reference=config.REFERENCE_BOOK,
        method=_method(method), min_ev=min_ev, min_books=min_books, kelly_mult=kelly,
        bankroll=bankroll, now=now, fair_mode=fair, weighted=weighted, max_width=max_width,
    )
    return {"fetch": fetch, "has_data": bool(prices), "rows": rows}


@app.get("/api/screen")
def screen(sport: str, market: str = "spreads", method: str = "power", books: str | None = None):
    fetch, events, prices, now = _snapshot(sport)
    if market == "props":
        return {"fetch": fetch, "has_data": bool(events),
                "events": props_summary(events, prices, store.props_fetched(sport), now=now)}
    if market not in config.sport_markets(_sport(sport)):
        raise HTTPException(400, f"market must be 'props' or one of {config.sport_markets(sport)}")
    rows = build_screen(
        events, prices, market=market, bettable=_bettable(books), reference=config.REFERENCE_BOOK,
        method=_method(method), previous=store.previous_prices(sport),
        opening=store.opening_prices(list(events), [market]), now=now,
    )
    return {"fetch": fetch, "has_data": bool(rows), "events": rows}


@app.get("/api/props-screen")
def props_screen(sport: str, event_id: str, method: str = "power", books: str | None = None):
    _, events, prices, _ = _snapshot(sport, "props")
    event = events.get(event_id)
    if event is None:
        return {"markets": []}
    prices = [p for p in prices if p.event_id == event_id]
    return {"markets": build_prop_screen(
        event, prices, bettable=_bettable(books), reference=config.REFERENCE_BOOK, method=_method(method),
        previous=store.previous_prices(sport),
        opening=store.opening_prices([event_id], config.PROP_MARKETS[sport]),
    )}


@app.get("/api/middles")
def middles(sport: str, kind: Kind = "all", books: str | None = None, stake: float = Query(100.0, gt=0)):
    fetch, events, prices, now = _snapshot(sport, kind)
    return {"fetch": fetch, "has_data": bool(prices),
            "rows": find_middles(events, prices, bettable=_bettable(books), now=now, total_stake=stake)}


@app.get("/api/lowhold")
def lowhold(sport: str, kind: Kind = "all", books: str | None = None):
    fetch, events, prices, now = _snapshot(sport, kind)
    return {"fetch": fetch, "has_data": bool(prices),
            "rows": find_low_hold(events, prices, bettable=_bettable(books), now=now)}


@app.get("/api/history")
def history(event_id: str, market: str, description: str | None = None):
    return {"rows": store.history(event_id, market, description)}


@app.get("/api/media")
def media_route(sport: str):
    """Logos for every team and headshots for every prop player in the current
    snapshot. Reads the cache; the only network call is a one-time team-list
    fetch (refreshed weekly) if this sport has none cached yet."""
    _, events, prices, _ = _snapshot(sport)
    if events:
        media.ensure_teams(sport)
    teams = {n for e in events.values() for n in (e.home, e.away)}
    wanted = {
        (p.event_id, events[p.event_id].home, events[p.event_id].away, p.description)
        for p in prices if p.description and p.event_id in events
    }
    return {"teams": media.team_map(sport, teams), "players": media.player_map(sport, sorted(wanted))}


# ---- parlays (local snapshot only) -------------------------------------------------

class LegIn(BaseModel):
    sport: str
    event_id: str
    market: str
    outcome: str
    point: float | None = None
    description: str | None = None
    book: str | None = None


class CorrIn(BaseModel):
    a: str
    b: str
    rho: float


class QuoteIn(BaseModel):
    book: str
    american: float


class PriceParlayIn(BaseModel):
    legs: list[LegIn]
    correlations: list[CorrIn] = []
    boost: float = 0.0  # percent, e.g. 25 for a 25% profit boost
    sgp_quote: QuoteIn | None = None
    books: str | None = None
    method: str = "power"
    min_books: int = 3
    kelly: float = 0.25
    bankroll: float = 1000.0
    max_stake_pct: float = 1.0  # percent of bankroll
    book: str | None = None  # where the parlay will be placed; priced even if another book pays more


def _snapshots(sports: set[str]):
    out = {}
    for sport in sports:
        _, events, prices = store.snapshot(_sport(sport))
        out[sport] = (events, prices)
    return out


@app.post("/api/parlay/price")
def parlay_price(req: PriceParlayIn):
    specs = [LegSpec(**leg.model_dump()) for leg in req.legs]
    quote = None
    if req.sgp_quote:
        try:
            quote = (req.sgp_quote.book, american_to_decimal(req.sgp_quote.american))
        except ValueError as e:
            raise HTTPException(400, str(e))
    try:
        legs = price_legs(specs, _snapshots({s.sport for s in specs}), method=_method(req.method),
                          reference=config.REFERENCE_BOOK, min_books=req.min_books)
        return analyze(
            legs, rho={frozenset((c.a, c.b)): c.rho for c in req.correlations}, bettable=_bettable(req.books),
            boost=req.boost / 100, sgp_quote=quote, kelly_mult=req.kelly, bankroll=req.bankroll,
            max_stake_pct=req.max_stake_pct / 100, book=req.book,
        )
    except ParlayError as e:
        raise HTTPException(400, str(e))


class GenerateIn(BaseModel):
    sports: list[str]
    kind: Kind = "all"
    books: str | None = None
    method: str = "power"
    min_books: int = 3
    min_legs: int = 2
    max_legs: int = 4
    min_odds: float | None = None  # American
    max_odds: float | None = None  # American
    min_leg_ev: float = 0.0  # percent
    boost: float = 0.0  # percent
    sort: Literal["ev", "growth"] = "ev"
    kelly: float = 0.25
    bankroll: float = 1000.0
    max_stake_pct: float = 1.0
    max_reuse: int = 3
    limit: int = 50


@app.post("/api/parlay/generate")
def parlay_generate(req: GenerateIn):
    if not 1 <= req.min_legs <= req.max_legs <= 8:
        raise HTTPException(400, "legs must satisfy 1 <= min <= max <= 8")
    try:
        lo = american_to_decimal(req.min_odds) if req.min_odds is not None else 1.0
        hi = american_to_decimal(req.max_odds) if req.max_odds is not None else 1e9
    except ValueError as e:
        raise HTTPException(400, str(e))
    rows = generate(
        _snapshots(set(req.sports)), bettable=_bettable(req.books), reference=config.REFERENCE_BOOK,
        method=_method(req.method), min_books=req.min_books, now=datetime.now(timezone.utc), kind=req.kind,
        min_legs=req.min_legs, max_legs=req.max_legs, min_decimal=lo, max_decimal=hi,
        min_leg_ev=req.min_leg_ev / 100, boost=req.boost / 100, sort=req.sort, kelly_mult=req.kelly,
        bankroll=req.bankroll, max_stake_pct=req.max_stake_pct / 100, max_reuse=req.max_reuse, limit=req.limit,
    )
    return {"rows": rows}


app.mount("/static", StaticFiles(directory=config.ROOT / "static"), name="static")


@app.middleware("http")
async def revalidate_assets(request, call_next):
    """Without Cache-Control, Safari guesses a freshness window and keeps
    serving an old app.js after an update. no-cache makes it revalidate (a
    cheap 304 when nothing changed)."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index():
    """index.html with asset URLs versioned by file mtime, so a browser never
    pairs a new page with a stale cached script or stylesheet."""
    static = config.ROOT / "static"
    html = (static / "index.html").read_text()
    for name in ("app.js", "style.css"):
        html = html.replace(f"/static/{name}", f"/static/{name}?v={int((static / name).stat().st_mtime)}")
    return HTMLResponse(html)
