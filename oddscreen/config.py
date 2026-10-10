"""Static configuration: sports, markets, books, and quota math."""
from __future__ import annotations

import math
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DB_PATH = Path(os.getenv("ODDS_DB_PATH", ROOT / "data" / "odds.db"))
API_KEY = os.getenv("ODDS_API_KEY", "")

# Short alias -> The Odds API sport keys. A sport can span several feeds (NBA
# preseason is its own key); feeds with no upcoming games are skipped for free.
SPORTS: dict[str, dict] = {
    "nfl": {"keys": ["americanfootball_nfl"], "title": "NFL"},
    "nba": {"keys": ["basketball_nba", "basketball_nba_preseason"], "title": "NBA"},
    "ncaab": {"keys": ["basketball_ncaab"], "title": "NCAAB"},
}


def is_preseason(league: str | None) -> bool:
    return bool(league) and league.endswith("_preseason")


# Bulk-endpoint markets, fetched for a whole sport in one call.
MAIN_MARKETS = ["h2h", "spreads", "totals"]

# Core over/under player props. Only available per event (events/{id}/odds),
# billed per market actually returned.
_HOOPS_PROPS = ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"]
PROP_MARKETS: dict[str, list[str]] = {
    "nfl": ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions", "player_pass_tds"],
    "nba": _HOOPS_PROPS,
    "ncaab": _HOOPS_PROPS,
}

MARKET_TITLES = {
    "h2h": "Moneyline",
    "spreads": "Spread",
    "totals": "Total",
    "player_pass_yds": "Pass Yds",
    "player_rush_yds": "Rush Yds",
    "player_reception_yds": "Rec Yds",
    "player_receptions": "Receptions",
    "player_pass_tds": "Pass TDs",
    "player_points": "Points",
    "player_rebounds": "Rebounds",
    "player_assists": "Assists",
    "player_threes": "Threes",
    "player_points_rebounds_assists": "Pts+Reb+Ast",
}


def market_title(market: str) -> str:
    return MARKET_TITLES.get(market, market.removeprefix("player_").replace("_", " ").title())


def is_prop(market: str) -> bool:
    return market.startswith("player_")


# ESPN's public site API: team logos/colors and rosters with headshots (no key).
ESPN_PATHS = {"nfl": "football/nfl", "nba": "basketball/nba", "ncaab": "basketball/mens-college-basketball"}

# Sharp book used as the fair-price reference. Never treated as bettable.
REFERENCE_BOOK = "pinnacle"

BOOK_TITLES = {
    "pinnacle": "Pinnacle",
    "draftkings": "DraftKings",
    "fanduel": "FanDuel",
    "betmgm": "BetMGM",
    "williamhill_us": "Caesars",
    "betrivers": "BetRivers",
    "fanatics": "Fanatics",
    "espnbet": "theScore Bet",
    "hardrockbet": "Hard Rock",
    "betonlineag": "BetOnline",
    "ballybet": "Bally Bet",
    "betparx": "betPARX",
    "bovada": "Bovada",
    "lowvig": "LowVig",
    "mybookieag": "MyBookie",
    "betus": "BetUS",
    "fliff": "Fliff",
    "novig": "Novig",
    "prophetx": "ProphetX",
    "kalshi": "Kalshi",
    "polymarket": "Polymarket",
}

# Every 10 named bookmakers bill as one "region", so 10 books = cheapest tier.
# Caesars (williamhill_us) and Fanatics returned no NFL odds as of 2026-10-05.
_DEFAULT_BOOKS = (
    "pinnacle,draftkings,fanduel,betmgm,betrivers,"
    "espnbet,hardrockbet,ballybet,betparx,betonlineag"
)
BOOKS: list[str] = [b.strip() for b in os.getenv("ODDS_BOOKS", _DEFAULT_BOOKS).split(",") if b.strip()]
if REFERENCE_BOOK not in BOOKS:
    BOOKS.insert(0, REFERENCE_BOOK)


# Brand-adjacent accent per book, used for the small book marker in the UI.
BOOK_COLORS = {
    "pinnacle": "#f27a21",
    "draftkings": "#61b510",
    "fanduel": "#1493ff",
    "betmgm": "#c4a76a",
    "betrivers": "#3b6fd6",
    "espnbet": "#e2384d",
    "hardrockbet": "#9b8bf4",
    "ballybet": "#ef4b5f",
    "betparx": "#8e5fd9",
    "betonlineag": "#d84a3a",
}


def book_title(key: str) -> str:
    return BOOK_TITLES.get(key, key)


def _book_regions(books: list[str]) -> int:
    return max(1, math.ceil(len(books) / 10))


def refresh_cost(markets: list[str] | None = None, books: list[str] | None = None) -> int:
    """Credits billed by GET /odds: markets x ceil(books / 10)."""
    markets = markets if markets is not None else MAIN_MARKETS
    return len(markets) * _book_regions(books if books is not None else BOOKS)


def props_cost_per_event(sport: str) -> int:
    """Upper bound for one event's props call; billed only for markets returned."""
    return len(PROP_MARKETS[sport]) * _book_regions(BOOKS)
