// Static configuration: sports, markets, books, and quota math.
// Port of oddscreen/config.py. The book list is user-configurable in Settings.

// Short alias -> The Odds API sport keys. A sport can span several feeds (NBA
// preseason is its own key); feeds with no upcoming games are skipped for free.
export const SPORTS = {
  nfl: { keys: ["americanfootball_nfl"], title: "NFL" },
  nba: { keys: ["basketball_nba", "basketball_nba_preseason"], title: "NBA" },
  ncaab: { keys: ["basketball_ncaab"], title: "NCAAB" },
};

export const isPreseason = (league) => Boolean(league) && league.endsWith("_preseason");

// Bulk-endpoint markets, fetched for a whole sport in one call.
export const MAIN_MARKETS = ["h2h", "spreads", "totals"];

// Core over/under player props. Only available per event (events/{id}/odds),
// billed per market actually returned.
const HOOPS_PROPS = ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"];
export const PROP_MARKETS = {
  nfl: ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions", "player_pass_tds"],
  nba: HOOPS_PROPS,
  ncaab: HOOPS_PROPS,
};

export const MARKET_TITLES = {
  h2h: "Moneyline",
  spreads: "Spread",
  totals: "Total",
  player_pass_yds: "Pass Yds",
  player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds",
  player_receptions: "Receptions",
  player_pass_tds: "Pass TDs",
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "Threes",
  player_points_rebounds_assists: "Pts+Reb+Ast",
};

const titleCase = (s) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

export function marketTitle(market) {
  if (market in MARKET_TITLES) return MARKET_TITLES[market];
  const base = market.startsWith("player_") ? market.slice(7) : market;
  return titleCase(base.replaceAll("_", " "));
}

export const isProp = (market) => market.startsWith("player_");

// Sharp book used as the fair-price reference. Never treated as bettable.
export const REFERENCE_BOOK = "pinnacle";

export const BOOK_TITLES = {
  pinnacle: "Pinnacle",
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  williamhill_us: "Caesars",
  betrivers: "BetRivers",
  fanatics: "Fanatics",
  espnbet: "theScore Bet",
  hardrockbet: "Hard Rock",
  betonlineag: "BetOnline",
  ballybet: "Bally Bet",
  betparx: "betPARX",
  bovada: "Bovada",
  lowvig: "LowVig",
  mybookieag: "MyBookie",
  betus: "BetUS",
  fliff: "Fliff",
  novig: "Novig",
  prophetx: "ProphetX",
  kalshi: "Kalshi",
  polymarket: "Polymarket",
};

// Every 10 named bookmakers bill as one "region", so 10 books = cheapest tier.
// Caesars (williamhill_us) and Fanatics returned no NFL odds as of 2026-10-05
// (Caesars still none on 2026-10-17). NoVig (a US exchange) replaced BetOnline then.
export const DEFAULT_BOOKS = [
  "pinnacle", "draftkings", "fanduel", "betmgm", "betrivers",
  "espnbet", "hardrockbet", "ballybet", "betparx", "novig",
];
/** The default before NoVig: devices still on exactly this list get migrated. */
export const PREVIOUS_DEFAULT_BOOKS = [
  "pinnacle", "draftkings", "fanduel", "betmgm", "betrivers",
  "espnbet", "hardrockbet", "ballybet", "betparx", "betonlineag",
];

// Brand-adjacent accent per book, used for the small book marker in the UI.
export const BOOK_COLORS = {
  pinnacle: "#f27a21",
  draftkings: "#61b510",
  fanduel: "#1493ff",
  betmgm: "#c4a76a",
  betrivers: "#3b6fd6",
  espnbet: "#e2384d",
  hardrockbet: "#9b8bf4",
  ballybet: "#ef4b5f",
  betparx: "#8e5fd9",
  betonlineag: "#d84a3a",
  novig: "#22c3a6",
};

export const bookTitle = (key) => BOOK_TITLES[key] ?? key;

/** The fetch list always includes the reference book. */
export function withReference(books) {
  return books.includes(REFERENCE_BOOK) ? [...books] : [REFERENCE_BOOK, ...books];
}

const bookRegions = (books) => Math.max(1, Math.ceil(books.length / 10));

/** Credits billed by GET /odds: markets x ceil(books / 10). */
export function refreshCost(books, markets = MAIN_MARKETS) {
  return markets.length * bookRegions(books);
}

/** Upper bound for one event's props call; billed only for markets returned. */
export function propsCostPerEvent(sport, books) {
  return PROP_MARKETS[sport].length * bookRegions(books);
}
