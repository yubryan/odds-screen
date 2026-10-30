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
    # one tab, four leagues: each league is its own feed (billed separately) and
    # can be left out of a pull; 3-way moneyline (home/draw/away) and totals only
    "soccer": {
        "keys": ["soccer_epl", "soccer_spain_la_liga", "soccer_germany_bundesliga", "soccer_uefa_champs_league"],
        "title": "Soccer", "markets": ["h2h", "totals"], "pick_leagues": True,
    },
}

LEAGUE_TITLES = {
    "soccer_epl": "EPL", "soccer_spain_la_liga": "La Liga", "soccer_germany_bundesliga": "Bundesliga",
    "soccer_uefa_champs_league": "UCL",
}


def is_preseason(league: str | None) -> bool:
    return bool(league) and league.endswith("_preseason")


# Bulk-endpoint markets, fetched for a whole sport in one call.
MAIN_MARKETS = ["h2h", "spreads", "totals"]


def sport_markets(sport: str) -> list[str]:
    """The main markets a sport offers, in MAIN_MARKETS order."""
    return SPORTS[sport].get("markets", MAIN_MARKETS)


# Core over/under player props. Only available per event (events/{id}/odds),
# billed per market actually returned.
_HOOPS_PROPS = ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"]
PROP_MARKETS: dict[str, list[str]] = {
    "nfl": ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions", "player_pass_tds"],
    "nba": _HOOPS_PROPS,
    "ncaab": _HOOPS_PROPS,
    "soccer": [],
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
# Soccer: logos only (no props, so no rosters), merged across the leagues' ESPN feeds
ESPN_SOCCER_PATHS = ["soccer/eng.1", "soccer/esp.1", "soccer/ger.1", "soccer/uefa.champions"]

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
# Caesars (williamhill_us) and Fanatics returned no NFL odds as of 2026-10-05
# (Caesars still none on 2026-10-17). NoVig (a US exchange) replaced BetOnline then.
_DEFAULT_BOOKS = (
    "pinnacle,draftkings,fanduel,betmgm,betrivers,"
    "espnbet,hardrockbet,ballybet,betparx,novig"
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
    "novig": "#22c3a6",
}


# Books that price from the same engine count as one source in a consensus.
# BetRivers, Bally Bet and betPARX all run on Kambi: in the stored snapshots Bally
# and betPARX quoted identical two-sided prices on 97.7% of shared markets and
# BetRivers matched them 39-46% of the time (vs ~20-30% for unrelated books),
# and Pikkit's sharpness rankings treat "Kambi" as one book.
FEEDS = {"betrivers": "kambi", "ballybet": "kambi", "betparx": "kambi"}


def feed_of(book: str) -> str:
    return FEEDS.get(book, book)


# How much each source counts in a consensus, by market type. Approximate, from
# Pikkit's published sharpness rankings (which books other books move toward):
# NBA props 2024: DraftKings 1.046, FanDuel 1.007, Caesars 0.995, Kambi 0.627;
# MLB props: FanDuel 1.236, Pinnacle 0.918, DraftKings 0.859, Kambi 0.531;
# Dec 2024 prop rankings: FanDuel 1st (NBA), Pinnacle 1st/FanDuel 2nd (NFL),
# NoVig 4th, Kambi last. NBA main markets: Pinnacle 1.076, DraftKings 1.069,
# BetOnline 1.058, BetMGM 0.944; Kambi last on main markets too.
SHARPNESS = {
    "props": {"fanduel": 1.15, "pinnacle": 1.05, "novig": 1.05, "draftkings": 1.0, "betonlineag": 0.95,
              "espnbet": 0.9, "hardrockbet": 0.9, "betmgm": 0.9, "kambi": 0.6},
    "main": {"pinnacle": 1.15, "draftkings": 1.05, "betonlineag": 1.05, "novig": 1.05, "fanduel": 1.0,
             "espnbet": 0.95, "hardrockbet": 0.95, "betmgm": 0.9, "kambi": 0.65},
}


def source_weight(source: str, market: str) -> float:
    """Weight of an odds source (a feed, see feed_of) in a consensus for this market."""
    return SHARPNESS["props" if is_prop(market) else "main"].get(source, 1.0)


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
