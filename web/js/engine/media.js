// Team logos/colors and player headshots from the bundled ESPN snapshot
// (web/data/media.json, built by tools/build_media.py). Port of oddscreen/media.py.

const LEAGUE = { nfl: "nfl", nba: "nba", ncaab: "mens-college-basketball", soccer: "soccer" };
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** 'Kenneth Walker III' / 'Amon-Ra St. Brown' -> comparable key. */
export function norm(name) {
  let s = String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7f]/g, "").toLowerCase();
  s = s.replace(/[.'’]/g, "").replace(/[^a-z0-9]+/g, " ");
  return s.split(" ").filter((w) => w && !SUFFIXES.has(w)).join(" ");
}

/** Odds API team name -> ESPN team. Exact on full name first, then by nickname
 * ('Los Angeles Clippers' vs ESPN 'LA Clippers'), using location overlap to
 * break ties (college nicknames repeat). */
export function matchTeam(name, teams) {
  const n = norm(name);
  for (const t of teams) {
    if (n === norm(t.display) || n === norm(`${t.location} ${t.nickname}`)) return t;
  }
  const words = new Set(n.split(" "));
  const candidates = teams.filter((t) => t.nickname && (n.endsWith(" " + norm(t.nickname)) || n === norm(t.nickname)));
  if (candidates.length === 1) return candidates[0];
  let best = null, bestScore = 0;
  for (const t of candidates) {
    const score = norm(t.location || "").split(" ").filter((w) => w && words.has(w)).length;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

// Club-name noise that differs between The Odds API and ESPN ("FC", "1.", "Mainz 05").
const CLUB_WORDS = new Set(["fc", "afc", "cf", "sc", "sv", "fsv", "fk", "ac", "rc", "ca", "club", "de", "la", "and", "1", "04", "05", "07"]);
// Names that share no words with ESPN's (normalized Odds API name -> normalized ESPN name)
const SOCCER_ALIASES = { "1 fc koln": "fc cologne", "hamburger sv": "hamburg sv", "slavia praha": "slavia prague" };
const ASCII = { "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d" }; // no NFKD decomposition

function clubWords(name) {
  const n = norm(String(name || "").replace(/[øØæÆßłŁđ]/g, (c) => ASCII[c]).replace(/[/&]/g, " "));
  return (SOCCER_ALIASES[n] ?? n).split(" ").filter((w) => w && !CLUB_WORDS.has(w));
}

/** Odds API club -> ESPN club: same words (ignoring "FC" and the like) on the
 * full or short name, else the one club whose words all appear in the other
 * name ("Athletic Bilbao" ~ ESPN "Athletic", "Bournemouth" ~ "AFC Bournemouth"). */
export function matchClub(name, teams) {
  const words = clubWords(name);
  const key = [...words].sort().join(" ");
  const names = (t) => [t.display, t.nickname].map(clubWords).filter((w) => w.length);
  const exact = teams.find((t) => names(t).some((w) => [...w].sort().join(" ") === key));
  if (exact || !words.length) return exact ?? null;
  const contains = (a, b) => a.every((w) => b.includes(w));
  const loose = teams.filter((t) => names(t).some((w) => contains(w, words) || contains(words, w)));
  return loose.length === 1 ? loose[0] : null;
}

export class Media {
  constructor(data) {
    this.sports = {};
    for (const [sport, d] of Object.entries(data?.sports ?? {})) {
      const teams = d.teams.map(([espn_id, display, location, nickname, abbr, logo, color]) =>
        ({ espn_id, display, location, nickname, abbr, logo, color }));
      const players = new Map(Object.entries(d.players).map(([teamId, rows]) => [teamId, rows.map(([name, headshot, jersey, position]) =>
        ({ name, key: norm(name), headshot, jersey, position }))]));
      this.sports[sport] = { teams, players };
    }
    this.cache = new Map();
  }

  team(sport, name) {
    const k = `${sport}\u0000${name}`;
    if (!this.cache.has(k)) this.cache.set(k, (sport === "soccer" ? matchClub : matchTeam)(name, this.sports[sport]?.teams ?? []));
    return this.cache.get(k);
  }

  /** {name: {logo, abbr, color, espn_id}} for the names that match. */
  teamMap(sport, names) {
    const out = {};
    for (const name of names) {
      const t = this.team(sport, name);
      if (t) out[name] = { logo: t.logo, abbr: t.abbr, color: t.color, espn_id: t.espn_id };
    }
    return out;
  }

  /** wanted: [eventId, home, away, player] -> {"eventId|player": info}. Searched only
   * within the game's two rosters, so same-named players on other teams can't collide. */
  playerMap(sport, wanted) {
    const out = {};
    const d = this.sports[sport];
    if (!d) return out;
    for (const [eventId, home, away, player] of wanted) {
      const pool = [];
      for (const teamName of [home, away]) {
        const t = this.team(sport, teamName);
        if (t) for (const p of d.players.get(t.espn_id) ?? []) pool.push({ ...p, team: t.abbr });
      }
      const key = norm(player);
      let hit = pool.find((p) => p.key === key);
      if (!hit && key) { // "Gabe Davis" vs "Gabriel Davis": last name + first initial
        const last = key.split(" ").pop();
        const loose = pool.filter((p) => p.key.split(" ").pop() === last && p.key[0] === key[0]);
        hit = loose.length === 1 ? loose[0] : null;
      }
      if (hit) {
        out[`${eventId}|${player}`] = {
          headshot: hit.headshot ? `https://a.espncdn.com/i/headshots/${LEAGUE[sport]}/players/full/${hit.headshot}.png` : null,
          jersey: hit.jersey, position: hit.position, team: hit.team,
        };
      }
    }
    return out;
  }
}
