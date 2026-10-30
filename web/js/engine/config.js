// Static configuration: sports, markets, books, and quota math.
// Port of oddscreen/config.py. The book list is user-configurable in Settings.

// Short alias -> The Odds API sport keys. A sport can span several feeds (NBA
// preseason is its own key); feeds with no upcoming games are skipped for free.
export const SPORTS = {
  nfl: { keys: ["americanfootball_nfl"], title: "NFL" },
  nba: { keys: ["basketball_nba", "basketball_nba_preseason"], title: "NBA" },
  ncaab: { keys: ["basketball_ncaab"], title: "NCAAB" },
  // one tab, four leagues: each league is its own feed (billed separately) and
  // can be left out of a pull; 3-way moneyline (home/draw/away) and totals only
  soccer: {
    keys: ["soccer_epl", "soccer_spain_la_liga", "soccer_germany_bundesliga", "soccer_uefa_champs_league"],
    title: "Soccer", markets: ["h2h", "totals"], pickLeagues: true,
  },
};

export const LEAGUE_TITLES = {
  soccer_epl: "EPL", soccer_spain_la_liga: "La Liga", soccer_germany_bundesliga: "Bundesliga", soccer_uefa_champs_league: "UCL",
};

export const isPreseason = (league) => Boolean(league) && league.endsWith("_preseason");

// Bulk-endpoint markets, fetched for a whole sport in one call.
export const MAIN_MARKETS = ["h2h", "spreads", "totals"];
/** The main markets a sport offers, in MAIN_MARKETS order. */
export const sportMarkets = (sport) => SPORTS[sport]?.markets ?? MAIN_MARKETS;

// Core over/under player props. Only available per event (events/{id}/odds),
// billed per market actually returned.
const HOOPS_PROPS = ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"];
export const PROP_MARKETS = {
  nfl: ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions", "player_pass_tds"],
  nba: HOOPS_PROPS,
  ncaab: HOOPS_PROPS,
  soccer: [],
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

// Books that price from the same engine count as one source in a consensus.
// BetRivers, Bally Bet and betPARX all run on Kambi: in the stored snapshots Bally
// and betPARX quoted identical two-sided prices on 97.7% of shared markets and
// BetRivers matched them 39-46% of the time (vs ~20-30% for unrelated books),
// and Pikkit's sharpness rankings treat "Kambi" as one book.
export const FEEDS = { betrivers: "kambi", ballybet: "kambi", betparx: "kambi" };
export const feedOf = (book) => FEEDS[book] ?? book;
export const SOURCE_TITLES = { kambi: "Kambi (BetRivers, Bally Bet, betPARX)" };

// How much each source counts in a consensus, by market type. Approximate, from
// Pikkit's published sharpness rankings (which books other books move toward):
// NBA props 2024: DraftKings 1.046, FanDuel 1.007, Caesars 0.995, Kambi 0.627;
// MLB props: FanDuel 1.236, Pinnacle 0.918, DraftKings 0.859, Kambi 0.531;
// Dec 2024 prop rankings: FanDuel 1st (NBA), Pinnacle 1st/FanDuel 2nd (NFL),
// NoVig 4th, Kambi last. NBA main markets: Pinnacle 1.076, DraftKings 1.069,
// BetOnline 1.058, BetMGM 0.944; Kambi last on main markets too.
export const SHARPNESS = {
  props: { fanduel: 1.15, pinnacle: 1.05, novig: 1.05, draftkings: 1.0, betonlineag: 0.95, espnbet: 0.9, hardrockbet: 0.9, betmgm: 0.9, kambi: 0.6 },
  main: { pinnacle: 1.15, draftkings: 1.05, betonlineag: 1.05, novig: 1.05, fanduel: 1.0, espnbet: 0.95, hardrockbet: 0.95, betmgm: 0.9, kambi: 0.65 },
};
/** Weight of an odds source (a feed, see feedOf) in a consensus for this market. */
export const sourceWeight = (source, market) => SHARPNESS[isProp(market) ? "props" : "main"][source] ?? 1.0;

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
