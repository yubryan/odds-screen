// Odds Screen: the whole app runs on-device. The engine (web/js/engine/*) is a
// port of the Python version, checked against it number-for-number by
// tests/web/parity.test.mjs. The UI talks to it through a local router that
// answers the same /api/... requests the Python server used to.

import {
  BOOK_COLORS, BOOK_TITLES, DEFAULT_BOOKS, MAIN_MARKETS, PREVIOUS_DEFAULT_BOOKS, PROP_MARKETS, REFERENCE_BOOK,
  marketTitle, refreshCost, withReference,
} from "./engine/config.js";
import { Media } from "./engine/media.js";
import { OddsAPIClient } from "./engine/oddsapi.js";
import { HISTORY_DAYS, openBrowserStore } from "./engine/store.js";
import { LocalApi } from "./router.js";

// ============================================================================
// state
// ============================================================================

const DEFAULTS = {
  sport: "nfl", tab: "ev", fmt: "american", books: null, kind: "all",
  method: "power", minEv: 0, kelly: 0.25, bankroll: 1000, minBooks: 3,
  market: "spreads", maxMiss: 5, maxHold: 5, stake: 100,
  maxStakePct: 1, parlayView: "slip", showOpen: false, evWindow: "all", fairMode: "auto",
  pullMarkets: ["h2h", "spreads", "totals"], propPull: {},
  gen: { sports: ["nfl"], kind: "all", minLegs: 2, maxLegs: 4, minOdds: "", maxOdds: "", minLegEv: 0, boost: 0, sort: "ev", maxReuse: 3 },
};
const TABS = ["ev", "screen", "middles", "lowhold", "parlays", "settings"];
const state = { ...DEFAULTS, ...loadSettings() };
state.gen = { ...DEFAULTS.gen, ...(state.gen || {}) };
let meta = null;
let lastData = null;
const media = {};          // sport -> {teams, players}
const sortState = {};      // tab -> {key, asc}
const openProps = new Set();   // expanded event ids on the props screen
const propData = {};       // event id -> props-screen payload
const propMarket = {};     // event id -> selected prop market

// API key + which books to fetch: kept apart from view settings
const CONFIG_KEY = "oddscreen-config";
const config = (() => {
  const base = { apiKey: "", books: [...DEFAULT_BOOKS] };
  try { return { ...base, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") }; } catch { return base; }
})();
// NoVig replaced BetOnline in the default books (2026-10-17): move devices still on the old default list
if ([...config.books].sort().join() === [...PREVIOUS_DEFAULT_BOOKS].sort().join()) {
  config.books = [...DEFAULT_BOOKS];
  saveConfig();
}
function saveConfig() {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* storage unavailable */ }
}
let localApi = null;
let store = null;
let mediaData = null;

function loadSettings() {
  try { return JSON.parse(localStorage.getItem("oddscreen") || "{}"); } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem("oddscreen", JSON.stringify(state)); } catch { /* storage unavailable */ }
}
function set(patch, reload = true) {
  Object.assign(state, patch);
  saveSettings();
  if (slip.legs.length && ["method", "minBooks", "kelly", "bankroll", "books"].some((k) => k in patch)) schedulePrice();
  if (reload) load(); else renderContent();
}

// ============================================================================
// helpers
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  try {
    return await localApi.handle(opts.method || "GET", path, opts.body ? JSON.parse(opts.body) : null);
  } catch (e) {
    if (!e.status) console.error(e);
    throw new Error(e.message || String(e));
  }
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

function odds(dec) {
  if (dec == null) return "–";
  if (state.fmt === "decimal") return dec.toFixed(2);
  const r = Math.round(dec >= 2 ? (dec - 1) * 100 : -100 / (dec - 1));
  return r > 0 ? `+${r}` : `${r}`;
}
const pct = (x, d = 1) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const money = (x) => `$${Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function point(p, spread) {
  if (p == null) return "";
  if (spread && p === 0) return "PK";
  return spread && p > 0 ? `+${p}` : `${p}`;
}
function kickoff(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function freshClass(iso) {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso)) / 60000;
  return m < 30 ? "fresh" : "stale";
}
const sportMeta = () => meta.sports.find((s) => s.id === state.sport);
const bookMeta = (key) => meta.books.find((b) => b.key === key) || { key, title: key, color: "#888" };
function booksParam() {
  return state.books ? `&books=${encodeURIComponent(state.books.join(","))}` : "";
}

function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = error ? "toast error" : "toast";
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), error ? 9000 : 5000);
}

// ---- media (logos / headshots) ---------------------------------------------

const teamInfo = (name, sport = state.sport) => media[sport]?.teams?.[name];
const initials = (name) => String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function teamLogo(name, cls = "", sport = state.sport) {
  const t = teamInfo(name, sport);
  if (t?.logo) {
    return `<img class="tlogo ${cls}" src="${esc(t.logo)}" alt="" loading="lazy" decoding="async" width="22" height="22" onerror="this.style.visibility='hidden'">`;
  }
  return `<span class="tlogo-fallback">${esc(initials(name))}</span>`;
}
const teamShort = (name, sport = state.sport) => teamInfo(name, sport)?.abbr || name;

function avatar(eventId, player, small = false, sport = state.sport) {
  const p = media[sport]?.players?.[`${eventId}|${player}`];
  const color = p?.team ? Object.values(media[sport].teams).find((t) => t.abbr === p.team)?.color : null;
  const ring = color ? `style="--ring:#${esc(color)}"` : "";
  const img = p?.headshot
    ? `<img src="${esc(p.headshot)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : "";
  const label = p?.jersey ? `#${esc(p.jersey)}` : esc(initials(player));
  return `<span class="avatar ${small ? "sm" : ""}" ${ring} title="${esc(player)}${p?.position ? ` · ${esc(p.position)}` : ""}${p?.team ? ` · ${esc(p.team)}` : ""}">${label}${img}</span>`;
}

async function loadMedia(sport = state.sport) {
  try { media[sport] = await api(`/api/media?sport=${sport}`); } catch { media[sport] = { teams: {}, players: {} }; }
}
const ensureMedia = (sports) => Promise.all([...new Set(sports)].filter((s) => !media[s]).map((s) => loadMedia(s)));
const preTag = (r) => (r.preseason ? `<span class="tag pre" title="NBA preseason">PRE</span>` : "");

// ---- shared cells -----------------------------------------------------------

function matchupCell(r, sport = state.sport) {
  return `<div class="matchup" title="${esc(r.event)}">
    <div class="logo-pair">${teamLogo(r.away, "", sport)}${teamLogo(r.home, "", sport)}</div>
    <div><div class="mu-names">${esc(teamShort(r.away, sport))} @ ${esc(teamShort(r.home, sport))}${preTag(r)}</div><span class="sub">${kickoff(r.commence_time)}</span></div>
  </div>`;
}

// a player's name/photo opens every prop for that game on the Odds Screen
const propLink = (r, inner) =>
  `<button class="prop-link" data-show-props="${esc(r.event_id)}" data-player="${esc(r.player)}" data-market="${esc(r.market)}"
    title="See all props for ${esc(teamShort(r.away))} @ ${esc(teamShort(r.home))}">${inner}</button>`;

function betCell(r) {
  if (r.is_prop) {
    return `<div class="bet">${propLink(r, `${avatar(r.event_id, r.player)}<div><b>${esc(r.player)} <span class="go">›</span></b>
      <span class="sub">${esc(r.outcome)} ${esc(point(r.point, false))} · ${esc(r.market_title)}</span></div>`)}</div>`;
  }
  const team = r.outcome === r.home || r.outcome === r.away;
  const icon = team ? teamLogo(r.outcome, "lg") : `<span class="ou-badge">${r.outcome === "Over" ? "O" : "U"}</span>`;
  return `<div class="bet">${icon}<div><b>${esc(r.selection)}</b><span class="sub">${esc(r.market_title)}</span></div></div>`;
}

function bookCell(key, link) {
  const b = bookMeta(key);
  const name = link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(b.title)} ↗</a>` : esc(b.title);
  return `<span class="book"><i style="background:${esc(b.color)}"></i>${name}</span>`;
}

function emptyState(title, body) {
  return `<div class="card empty-state"><h3>${title}</h3><p>${body}</p></div>`;
}

// ---- sortable table ----------------------------------------------------------

function table(tab, columns, rows, defaultSort) {
  const s = sortState[tab] || (sortState[tab] = { ...defaultSort });
  const col = columns.find((c) => c.key === s.key);
  if (col) {
    const v = col.value || ((r) => r[col.key]);
    rows = [...rows].sort((a, b) => {
      const x = v(a), y = v(b);
      const cmp = x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0;
      return s.asc ? cmp : -cmp;
    });
  }
  const head = columns.map((c) =>
    `<th data-sort="${c.key}" class="${c.num ? "num" : ""} ${c.key === s.key ? "sorted" + (s.asc ? " asc" : "") : ""}">${c.label}</th>`).join("");
  const body = rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? "num" : ""}">${c.html(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="card"><div class="table-wrap"><table data-tab="${tab}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

document.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const s = sortState[th.closest("table").dataset.tab];
  if (s.key === th.dataset.sort) s.asc = !s.asc; else { s.key = th.dataset.sort; s.asc = false; }
  renderContent();
});

// ============================================================================
// header
// ============================================================================

const LEAGUE_ICON = {
  nfl: `<img src="https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png" alt="">`,
  nba: `<img src="https://a.espncdn.com/i/teamlogos/leagues/500/nba.png" alt="">`,
  ncaab: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="#e8762c"/><g fill="none" stroke="#5a2a0c" stroke-width="1.3"><path d="M2.5 12h19M12 2.5v19"/><path d="M5.3 5.3c3 3 3 10.4 0 13.4M18.7 5.3c-3 3-3 10.4 0 13.4"/></g></svg>`,
};

function renderHeader() {
  $("#sports").innerHTML = meta.sports.map((s) =>
    `<button data-sport="${s.id}" class="${s.id === state.sport ? "active" : ""}">${LEAGUE_ICON[s.id] || ""}${s.title}${s.events ? `<span class="n">${s.events}</span>` : ""}</button>`).join("");
  const sport = sportMeta();
  const u = meta.usage;
  $("#credits-num").textContent = u ? `${u.remaining}` : "–";
  const total = u ? u.remaining + u.used : 500;
  $("#credits-bar").style.width = u ? `${Math.max(2, (u.remaining / total) * 100)}%` : "0";
  $("#credits-bar").parentElement.classList.toggle("low", !!u && u.remaining < 60);
  $("#credits").title = u ? `${u.used} used this month · last call cost ${u.last} · as of ${new Date(u.at).toLocaleString()}` : "Refresh once to see your balance";
  const cost = sport.refresh_cost > meta.refresh_cost ? `≤${sport.refresh_cost}` : sport.refresh_cost;
  $("#refresh-main").innerHTML = `↻ <span class="lbl">Main lines</span><span class="lbl-s">Lines</span> <span class="cost">${cost} cr</span>`;
  $("#refresh-main").title = sport.refresh_cost > meta.refresh_cost
    ? `${meta.refresh_cost} credits per feed with upcoming games (regular season + preseason). Empty feeds are skipped for free.` : "";
  $("#refresh-props").innerHTML = `＋ <span class="lbl">Player props</span><span class="lbl-s">Props</span> <span class="cost">≤${sport.props_cost_per_event}/gm</span>`;
  document.body.classList.toggle("on-settings", state.tab === "settings");
  $("#freshness").innerHTML =
    `<span><span class="dot ${freshClass(sport.last_fetch)}"></span>Main lines <b>${ago(sport.last_fetch)}</b></span>` +
    `<span><span class="dot ${freshClass(sport.last_props_fetch)}"></span>Props <b>${ago(sport.last_props_fetch)}</b></span>`;
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  document.querySelectorAll("#fmt button").forEach((b) => b.classList.toggle("active", b.dataset.fmt === state.fmt));
  const bettable = meta.books.filter((b) => !b.reference);
  const n = state.books ? state.books.length : bettable.length;
  $("#books-btn").innerHTML = `Books <span class="muted">${n}/${bettable.length}</span> ▾`;
}

function renderBooksPopover() {
  const chosen = new Set(state.books || meta.books.map((b) => b.key));
  $("#books-pop").innerHTML =
    `<div class="pop-actions"><button class="btn btn-sm" data-books="all">Select all</button><button class="btn btn-sm btn-ghost" data-books="none">Clear</button></div>` +
    meta.books.filter((b) => !b.reference).map((b) =>
      `<label><input type="checkbox" value="${b.key}" ${chosen.has(b.key) ? "checked" : ""}><span class="book"><i style="background:${esc(b.color)}"></i>${esc(b.title)}</span></label>`).join("") +
    `<p class="note">${esc(bookMeta(meta.reference).title)} is the fair-price reference, so it never appears as a bet.</p>`;
}

$("#sports").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-sport]");
  if (!b) return;
  state.sport = b.dataset.sport;
  evGames = null;
  saveSettings();
  if (!media[state.sport]) await loadMedia();
  load();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) location.hash = b.dataset.tab;
});
$("#filters-toggle").addEventListener("click", () => document.body.classList.toggle("show-filters"));
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (TABS.includes(t) && t !== state.tab) set({ tab: t });
});
$("#fmt").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-fmt]");
  if (b) set({ fmt: b.dataset.fmt }, false);
});
// Place the books dropdown under its button but always inside the screen: the
// toolbar wraps on narrower windows, which can put the button at either edge.
function placePopover(pop = $("#books-pop"), anchor = $("#books-btn")) {
  const btn = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight, margin = 8;
  const width = Math.min(260, vw - 2 * margin);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.min(Math.max(btn.right - width, margin), vw - width - margin)}px`;
  pop.style.top = `${btn.bottom + 6}px`;
  pop.style.maxHeight = `${Math.max(160, vh - btn.bottom - 6 - margin)}px`;
}
const closePopover = () => { $("#books-pop").hidden = true; $("#games-pop").hidden = true; };
window.addEventListener("resize", closePopover);
window.addEventListener("scroll", closePopover, { passive: true });

$("#books-btn").addEventListener("click", () => {
  const pop = $("#books-pop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) placePopover();
  if (!pop.hidden) renderBooksPopover();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover-wrap")) $("#books-pop").hidden = true;
  if (!e.target.closest("#games-pop, #games-btn")) $("#games-pop").hidden = true;
});
document.body.insertAdjacentHTML("beforeend", `<div id="games-pop" class="popover" hidden></div>`);
function setEvGames(next) {
  evGames = next;
  renderContent();
  updateCounts();
}
$("#games-pop").addEventListener("change", () => {
  const checked = [...document.querySelectorAll("#games-pop input:checked")].map((i) => i.value);
  const all = evGameList(lastData?.rows ?? []).length;
  setEvGames(checked.length === all ? null : new Set(checked));
  $("#games-pop").hidden = false; // keep it open while picking
  placePopover($("#games-pop"), $("#games-btn"));
});
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-games]");
  if (g) {
    setEvGames(g.dataset.games === "all" ? null : new Set());
    if (g.closest("#games-pop")) { renderGamesPopover(); $("#games-pop").hidden = false; placePopover($("#games-pop"), $("#games-btn")); }
    return;
  }
  if (e.target.closest("#games-btn")) {
    const pop = $("#games-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { renderGamesPopover(); placePopover(pop, $("#games-btn")); }
    return;
  }
  const fm = e.target.closest("[data-fair-mode]");
  if (fm) { if (fm.dataset.fairMode !== state.fairMode) set({ fairMode: fm.dataset.fairMode }); return; }
  const w = e.target.closest("[data-ev-window]");
  if (w) { state.evWindow = w.dataset.evWindow; saveSettings(); renderContent(); updateCounts(); }
});
$("#books-pop").addEventListener("change", () => {
  const checked = [...document.querySelectorAll("#books-pop input:checked")].map((i) => i.value);
  const all = meta.books.filter((b) => !b.reference).length;
  set({ books: checked.length === all ? null : checked });
});
$("#books-pop").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-books]");
  if (!b) return;
  set({ books: b.dataset.books === "all" ? null : [] });
  renderBooksPopover();
});
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("oddscreen-theme", next); } catch { /* ignore */ }
});

// ---- refreshes ----------------------------------------------------------------

async function afterRefresh() {
  pruneHistory();
  meta = await api("/api/meta");
  await loadMedia();
  Object.keys(propData).forEach((k) => delete propData[k]);
  await load();
}

function needKey() {
  if (config.apiKey) return false;
  toast("Add your Odds API key in Settings first");
  location.hash = "settings";
  return true;
}

$("#refresh-main").addEventListener("click", () => {
  if (!needKey()) openPullSheet();
});
$("#credits").addEventListener("click", () => { location.hash = "settings"; });

const ALL_BOOK_KEYS = Object.keys(BOOK_TITLES);
const creditsLeft = () => meta.usage?.remaining ?? null;
const pullMarkets = () => MAIN_MARKETS.filter((m) => state.pullMarkets.includes(m));
const propMarkets = (sport = state.sport) => PROP_MARKETS[sport].filter((m) => (state.propPull[sport] ?? PROP_MARKETS[sport]).includes(m));

/** Book checkboxes shared by the pull pickers and Settings; edits the saved fetch list. */
function bookChecklist() {
  const chosen = new Set(withReference(config.books));
  return `<div class="book-grid">${ALL_BOOK_KEYS.map((b) => `<label class="check"><input type="checkbox" data-book="${b}" ${chosen.has(b) ? "checked" : ""} ${b === REFERENCE_BOOK ? "disabled" : ""}>
    <span class="book"><i style="background:${BOOK_COLORS[b] ?? "#888"}"></i>${esc(BOOK_TITLES[b])}</span>${b === REFERENCE_BOOK ? `<span class="muted">fair price</span>` : ""}</label>`).join("")}</div>`;
}
async function toggleBook(key, on) {
  const chosen = new Set(config.books);
  if (on) chosen.add(key); else chosen.delete(key);
  config.books = ALL_BOOK_KEYS.filter((b) => chosen.has(b));
  saveConfig();
  state.books = null; // the toolbar's book filter refers to the old list
  saveSettings();
  meta = await api("/api/meta");
}
const tierNote = (n) => `${n} book${n === 1 ? "" : "s"} = ${Math.ceil(n / 10)} billing group${n > 10 ? "s" : ""}. The Odds API bills up to 10 books as one group,
  so leaving books out only saves credits when it takes you under a multiple of 10. Leaving out markets always saves.`;

function openPullSheet() {
  const sport = sportMeta();
  const feeds = Math.round(sport.refresh_cost / meta.refresh_cost); // NBA: regular season + preseason
  const draw = () => {
    const markets = pullMarkets();
    const books = withReference(config.books);
    const perFeed = refreshCost(books, markets);
    const left = creditsLeft();
    $("#modal-title").textContent = `Pull main lines · ${sport.title}`;
    $("#modal-body").innerHTML = `
      <h4>Markets</h4>
      <div class="chips">${MAIN_MARKETS.map((m) => `<button class="chip ${markets.includes(m) ? "on" : ""}" data-pull-market="${m}">${marketTitle(m)}</button>`).join("")}</div>
      <p class="foot-note">Each market is 1 credit per billing group. Markets you skip keep showing their last pull.</p>
      <h4>Books</h4>${bookChecklist()}
      <p class="foot-note">${tierNote(books.length)} Books you leave out won't appear until you pull them again.</p>
      <div class="plan-foot">
        <span class="plan-cost"><b>${markets.length * Math.ceil(books.length / 10) * feeds > 0 ? `${perFeed}${feeds > 1 ? `–${perFeed * feeds}` : ""}` : 0}</b> credits${feeds > 1 ? " (one charge per feed with upcoming games: regular season and preseason)" : ""}${left != null ? ` · <b>${left}</b> left` : ""}</span>
        <span style="display:flex;gap:8px"><button class="btn btn-ghost" id="pull-cancel">Cancel</button>
          <button class="btn btn-primary" id="pull-go" ${markets.length ? "" : "disabled"}>Pull ${perFeed}${feeds > 1 ? "+" : ""} cr</button></span>
      </div>`;
  };
  draw();
  $("#modal-body").onclick = async (e) => {
    const m = e.target.closest("[data-pull-market]");
    if (m) {
      const set_ = new Set(state.pullMarkets);
      if (set_.has(m.dataset.pullMarket)) set_.delete(m.dataset.pullMarket); else set_.add(m.dataset.pullMarket);
      state.pullMarkets = MAIN_MARKETS.filter((x) => set_.has(x));
      saveSettings();
      draw();
      return;
    }
    if (e.target.id === "pull-cancel") $("#modal").close();
    if (e.target.id === "pull-go") { $("#modal").close(); await pullMainLines(); }
  };
  $("#modal-body").onchange = async (e) => {
    const b = e.target.closest("[data-book]");
    if (b) { await toggleBook(b.dataset.book, b.checked); draw(); }
  };
  $("#modal").showModal();
}

async function pullMainLines() {
  const btn = $("#refresh-main");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  try {
    const r = await post(`/api/refresh/${state.sport}`, { markets: pullMarkets() });
    const feeds = r.feeds?.length > 1 ? ` (${r.feeds.length} feeds incl. preseason)` : r.feeds?.[0]?.endsWith("_preseason") ? " (preseason)" : "";
    const which = r.markets?.length < MAIN_MARKETS.length ? ` · ${r.markets.map(marketTitle).join(", ")} only` : "";
    toast(`${sportMeta().title} main lines: ${r.events} games${feeds}${which} · ${r.cost} credits · ${r.usage.remaining} left`);
  } catch (err) {
    toast(/quota/i.test(err.message) ? `${err.message} — see Settings → Credits to upgrade.` : err.message, true);
  } finally {
    btn.disabled = false;
    await afterRefresh();
  }
}
// keep the 14-day history trimmed as new snapshots arrive
const pruneHistory = () => store?.prune(HISTORY_DAYS);

async function pullProps(eventIds, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Pulling…"; }
  try {
    const r = await post(`/api/props/refresh/${state.sport}`, { event_ids: eventIds, markets: propMarkets() });
    const none = r.games_without_props ? ` (${r.games_without_props} had no props posted yet)` : "";
    toast(`Props: ${r.games} game${r.games === 1 ? "" : "s"}${none} · ${r.cost} credits${r.usage ? ` · ${r.usage.remaining} left` : ""}${r.stopped ? ` · stopped early: ${r.stopped}` : ""}`, !!r.stopped);
    eventIds.forEach((id) => openProps.add(id));
  } catch (err) {
    toast(/quota/i.test(err.message) ? `${err.message} — see Settings → Credits to upgrade.` : err.message, true);
  } finally {
    await afterRefresh();
  }
}

// "Refresh all props" planner: one free /events call, windows computed client-side
$("#refresh-props").addEventListener("click", async () => {
  if (needKey()) return;
  let plan;
  try { plan = await api(`/api/props/plan?sport=${state.sport}`); } catch (err) { toast(err.message, true); return; }
  if (!plan.events.length) { toast(`No upcoming ${sportMeta().title} games listed.`, true); return; }
  const windows = [["24h", 24], ["3 days", 72], ["7 days", 168], ["All", Infinity]];
  let hours = plan.events.some((e) => new Date(e.commence_time) - Date.now() <= 72 * 3600e3) ? 72 : Infinity;
  const fetched = {};
  try { (await api(`/api/screen?sport=${state.sport}&market=props`)).events.forEach((e) => (fetched[e.id] = e.props_fetched_at)); } catch { /* ignore */ }

  const draw = () => {
    // books don't post preseason props through The Odds API (verified 2026-10-10), so don't pre-select them
    const inWindow = (e) => !e.preseason && new Date(e.commence_time) - Date.now() <= hours * 3600e3;
    const pm = propMarkets();
    plan.per_event_cost = refreshCost(withReference(config.books), pm);
    $("#modal-title").textContent = `Pull player props · ${sportMeta().title}`;
    $("#modal-body").innerHTML = `
      <h4>Prop markets</h4>
      <div class="chips" style="flex-wrap:wrap">${PROP_MARKETS[state.sport].map((m) => `<button class="chip ${pm.includes(m) ? "on" : ""}" data-prop-pull="${m}">${marketTitle(m)}</button>`).join("")}</div>
      <div class="callout" style="margin-top:12px">Each game costs up to <b>${plan.per_event_cost} credit${plan.per_event_cost === 1 ? "" : "s"}</b>: one per chosen market the books have posted (per 10 books). Games with no props posted yet cost 0. Main lines are not touched.</div>
      ${plan.events.some((e) => e.preseason) ? `<div class="alert" style="margin-top:8px">Sportsbooks don't post player props for NBA preseason games, so those (tagged PRE) start unchecked. Regular-season props appear about a week or two before tip-off, often at one book first.</div>` : ""}
      <div style="display:flex;align-items:center;gap:10px;margin-top:14px"><span class="field">Games starting within</span>
        <div class="seg" id="plan-window">${windows.map(([label, h]) => {
          const n = plan.events.filter((e) => new Date(e.commence_time) - Date.now() <= h * 3600e3).length;
          return `<button data-h="${h}" class="${h === hours ? "active" : ""}">${label} <span class="muted">${n}</span></button>`;
        }).join("")}</div></div>
      <div class="plan-list">${plan.events.map((e) => `
        <label><input type="checkbox" value="${esc(e.id)}" ${inWindow(e) ? "checked" : ""}>
          <span class="logo-pair">${teamLogo(e.name.split(" @ ")[0])}${teamLogo(e.name.split(" @ ")[1])}</span>
          <span>${esc(e.name)}${e.preseason ? ` <span class="tag pre">PRE</span>` : ""}</span>
          <span class="when">${kickoff(e.commence_time)}${fetched[e.id] ? `<span class="sub">props ${ago(fetched[e.id])}</span>` : ""}</span>
        </label>`).join("")}</div>
      <div class="plan-foot"><span class="plan-cost" id="plan-cost"></span>
        <span style="display:flex;gap:8px"><button class="btn btn-ghost" id="plan-cancel">Cancel</button><button class="btn btn-primary" id="plan-go">Pull props</button></span></div>`;
    updateCost();
  };
  const selected = () => [...document.querySelectorAll("#modal-body .plan-list input:checked")].map((i) => i.value);
  const updateCost = () => {
    const n = selected().length;
    const remaining = meta.usage?.remaining;
    $("#plan-cost").innerHTML = `<b>${n}</b> game${n === 1 ? "" : "s"} · up to <b>${n * plan.per_event_cost}</b> credits${remaining != null ? ` · <b>${remaining}</b> left` : ""}`;
    $("#plan-go").disabled = n === 0 || !propMarkets().length;
  };
  draw();
  $("#modal-body").onclick = async (e) => {
    const w = e.target.closest("#plan-window button");
    if (w) { hours = Number(w.dataset.h); draw(); return; }
    const pmBtn = e.target.closest("[data-prop-pull]");
    if (pmBtn) {
      const cur = new Set(propMarkets());
      if (cur.has(pmBtn.dataset.propPull)) cur.delete(pmBtn.dataset.propPull); else cur.add(pmBtn.dataset.propPull);
      state.propPull = { ...state.propPull, [state.sport]: PROP_MARKETS[state.sport].filter((m) => cur.has(m)) };
      saveSettings();
      draw();
      return;
    }
    if (e.target.id === "plan-cancel") $("#modal").close();
    if (e.target.id === "plan-go") {
      const ids = selected();
      $("#modal").close();
      await pullProps(ids);
    }
  };
  $("#modal-body").onchange = updateCost;
  $("#modal").showModal();
});

// ============================================================================
// tab controls
// ============================================================================

const field = (key, label, step, unit = "") =>
  `<label class="field">${label}<input type="number" data-key="${key}" step="${step}" value="${state[key]}">${unit ? `<span class="unit">${unit}</span>` : ""}</label>`;
const methodSelect = () =>
  `<label class="field">De-vig<select data-key="method">${meta.methods.map((m) =>
    `<option value="${m}" ${m === state.method ? "selected" : ""}>${m.replace("_", " ")}</option>`).join("")}</select></label>`;
const kindSeg = () =>
  `<div class="seg" data-seg="kind">${[["all", "All"], ["main", "Main lines"], ["props", "Player props"]].map(([k, l]) =>
    `<button data-val="${k}" class="${state.kind === k ? "active" : ""}">${l}</button>`).join("")}</div>`;

function renderControls() {
  const c = $("#tab-controls");
  if (state.tab === "settings") {
    c.innerHTML = "";
  } else if (state.tab === "ev") {
    c.innerHTML = kindSeg() + methodSelect() + field("minEv", "Min EV", 0.5, "%") + field("kelly", "Kelly ×", 0.05) +
      field("bankroll", "Bankroll", 100, "$") + field("minBooks", "Consensus books", 1);
  } else if (state.tab === "screen") {
    const markets = [...meta.markets, { key: "props", title: "Player Props" }];
    c.innerHTML = `<div class="seg" data-seg="market">${markets.map((m) =>
      `<button data-val="${m.key}" class="${m.key === state.market ? "active" : ""}">${m.title}</button>`).join("")}</div>` + methodSelect() +
      `<button class="chip ${state.showOpen ? "on" : ""}" data-toggle-open>Opening odds</button>`;
  } else if (state.tab === "parlays") {
    c.innerHTML = `<div class="seg" data-seg="parlayView">${[["slip", "Slip analysis"], ["gen", "Generator"]].map(([k, l]) =>
      `<button data-val="${k}" class="${state.parlayView === k ? "active" : ""}">${l}</button>`).join("")}</div>` + methodSelect() +
      field("minBooks", "Consensus books", 1);
  } else if (state.tab === "middles") {
    c.innerHTML = kindSeg() + field("maxMiss", "Max cost if miss", 0.5, "%") + field("stake", "Total stake", 10, "$");
  } else {
    c.innerHTML = kindSeg() + field("maxHold", "Max hold", 0.5, "%");
  }
}

const SERVER_KEYS = new Set(["method", "minEv", "kelly", "bankroll", "minBooks", "stake"]);
$("#tab-controls").addEventListener("change", (e) => {
  const el = e.target.closest("[data-key]");
  if (!el) return;
  const key = el.dataset.key;
  set({ [key]: el.tagName === "SELECT" ? el.value : Number(el.value) }, SERVER_KEYS.has(key));
});
$("#tab-controls").addEventListener("click", (e) => {
  if (e.target.closest("[data-toggle-open]")) { set({ showOpen: !state.showOpen }, false); renderControls(); return; }
  const b = e.target.closest("[data-seg] button");
  if (b) set({ [b.parentElement.dataset.seg]: b.dataset.val });
});

// ============================================================================
// content
// ============================================================================

async function load() {
  renderHeader();
  renderControls();
  if (state.tab === "settings") {
    lastData = { has_data: true };
    renderContent();
    return;
  }
  if (state.tab === "parlays") {
    lastData = { has_data: true };
    renderContent();
    if (state.parlayView === "slip" && slip.legs.length && !slipResult) schedulePrice();
    return;
  }
  const s = state.sport;
  const k = `&kind=${state.kind}`;
  const urls = {
    ev: `/api/ev?sport=${s}${k}&method=${state.method}&min_ev=${state.minEv / 100}&kelly=${state.kelly}&bankroll=${state.bankroll}&min_books=${state.minBooks}&fair=${state.fairMode}`,
    screen: `/api/screen?sport=${s}&market=${state.market}&method=${state.method}`,
    middles: `/api/middles?sport=${s}${k}&stake=${state.stake}`,
    lowhold: `/api/lowhold?sport=${s}${k}`,
  };
  $("#content").innerHTML = `<div class="skeleton"></div>`;
  try {
    lastData = await api(urls[state.tab] + booksParam());
  } catch (err) {
    lastData = null;
    $("#content").innerHTML = emptyState("Couldn't load", esc(err.message));
    return;
  }
  renderContent();
  updateCounts();
}

function updateCounts() {
  document.querySelectorAll("[data-count]").forEach((el) => {
    if (el.dataset.count !== state.tab || !lastData?.rows) return;
    const rows = state.tab === "middles" ? lastData.rows.filter((r) => -r.miss_pct * 100 <= state.maxMiss)
      : state.tab === "ev" ? evFiltered(lastData.rows) : lastData.rows;
    el.textContent = rows ? rows.length : "";
  });
}

function renderContent() {
  renderHeader();
  const data = lastData;
  if (!data) return;
  if (!data.has_data && !config.apiKey) {
    $("#content").innerHTML = welcomeCard();
    return;
  }
  if (!data.has_data) {
    const what = state.kind === "props" || state.market === "props" ? "player props" : "odds";
    $("#content").innerHTML = emptyState(`No ${sportMeta().title} ${what} yet`,
      what === "odds"
        ? `Click <b>Main lines</b> above to pull every game (${sportMeta().refresh_cost} credits at most).`
        : `Click <b>Player props</b> above to choose games, or pull a single game from Odds Screen → Player Props.`);
    return;
  }
  const render = { ev: renderEV, screen: state.market === "props" ? renderPropsList : renderScreen, middles: renderMiddles, lowhold: renderLowHold, parlays: renderParlays, settings: renderSettings }[state.tab];
  addReg.clear();
  $("#content").innerHTML = render(data);
  ensurePropBodies();
  applyPropFocus();
}

// ---- Positive EV ---------------------------------------------------------------

// ---- EV filters: when the game starts, and which games ----
const EV_WINDOWS = [["all", "All", Infinity], ["24h", "24h", 24], ["3d", "3 days", 72], ["7d", "7 days", 168]];
let evGames = null; // Set of event ids, or null for every game

function inWindow(r, key = state.evWindow) {
  const hours = (EV_WINDOWS.find(([k]) => k === key) ?? EV_WINDOWS[0])[2];
  return new Date(r.commence_time) - Date.now() <= hours * 3600e3;
}
const evFiltered = (rows) => rows.filter((r) => inWindow(r) && (!evGames || evGames.has(r.event_id)));

/** Games in the EV list, soonest first, with how many bets each has in the current window. */
function evGameList(rows) {
  const games = new Map();
  for (const r of rows) {
    if (!games.has(r.event_id)) games.set(r.event_id, { ...r, n: 0 });
    if (inWindow(r)) games.get(r.event_id).n += 1;
  }
  return [...games.values()].sort((a, b) => a.commence_time.localeCompare(b.commence_time));
}

const FAIR_MODE_LABELS = [
  ["auto", "Auto", "Pinnacle when it posts the line, otherwise the consensus of the other books"],
  ["pinnacle", "Pinnacle", "Pinnacle's no-vig price only; bets on lines Pinnacle doesn't post are left out"],
  ["consensus", "Consensus", "Average no-vig price of the other books (Pinnacle included, the book being bet left out, shared feeds counted once, 3+ books)"],
];
function fairModeSeg() {
  return `<div class="fair-mode"><span class="field">Fair value</span><div class="seg">${FAIR_MODE_LABELS.map(([k, l, tip]) =>
    `<button data-fair-mode="${k}" class="${state.fairMode === k ? "active" : ""}" title="${esc(tip)}">${l}</button>`).join("")}</div></div>`;
}

function evFilterBar(rows) {
  const games = evGameList(rows);
  const label = !evGames ? "All games" : evGames.size === 1 ? `${teamShort(games.find((g) => evGames.has(g.event_id))?.away ?? "")} @ ${teamShort(games.find((g) => evGames.has(g.event_id))?.home ?? "")}` : `${evGames.size} games`;
  return `<div class="ev-filters">
    ${fairModeSeg()}
    <div class="seg">${EV_WINDOWS.map(([k, l]) => {
      const n = rows.filter((r) => inWindow(r, k) && (!evGames || evGames.has(r.event_id))).length;
      return `<button data-ev-window="${k}" class="${state.evWindow === k ? "active" : ""}">${l} <span class="muted">${n}</span></button>`;
    }).join("")}</div>
    <button class="btn btn-ghost ${evGames ? "filtered" : ""}" id="games-btn">${esc(label)} ▾</button>
    ${evGames ? `<button class="btn btn-sm btn-ghost" data-games="all">Clear</button>` : ""}
  </div>`;
}

function renderGamesPopover() {
  const games = evGameList(lastData?.rows ?? []);
  $("#games-pop").innerHTML =
    `<div class="pop-actions"><button class="btn btn-sm" data-games="all">All games</button><button class="btn btn-sm btn-ghost" data-games="none">Clear</button></div>` +
    games.map((g) => `<label class="game-opt ${g.n ? "" : "muted"}"><input type="checkbox" value="${esc(g.event_id)}" ${!evGames || evGames.has(g.event_id) ? "checked" : ""}>
      <span class="logo-pair">${teamLogo(g.away)}${teamLogo(g.home)}</span>
      <span class="g-name">${esc(teamShort(g.away))} @ ${esc(teamShort(g.home))}${preTag(g)}<span class="sub">${kickoff(g.commence_time)}</span></span>
      <span class="g-n">${g.n}</span></label>`).join("") +
    `<p class="note">Number = +EV bets in the selected time window.</p>`;
}

function renderEV(data) {
  if (!data.rows.length) {
    const why = state.fairMode === "pinnacle" ? " using Pinnacle only. Try Auto or Consensus to price lines Pinnacle doesn't post."
      : state.fairMode === "consensus" ? " using the consensus. Try Auto or Pinnacle." : ". Lines move, so try again after a refresh.";
    return (data.has_data ? `<div class="ev-filters">${fairModeSeg()}</div>` : "") +
      emptyState("No +EV bets right now", `Nothing at or above ${state.minEv}% EV in the latest snapshot${why}`);
  }
  const bar = evFilterBar(data.rows);
  const rows = evFiltered(data.rows);
  if (!rows.length) return bar + emptyState("No +EV bets match these filters", "Try a longer time window or pick more games.");
  const best = Math.max(...rows.map((r) => r.ev));
  const avg = rows.reduce((a, r) => a + r.ev, 0) / rows.length;
  const stake = rows.reduce((a, r) => a + r.stake, 0);
  const kpis = bar + `<div class="kpis">
    <div class="kpi"><div class="label">Opportunities</div><div class="value">${rows.length}</div></div>
    <div class="kpi"><div class="label">Best EV</div><div class="value pos">${pct(best, 2)}</div></div>
    <div class="kpi"><div class="label">Average EV</div><div class="value">${pct(avg, 2)}</div></div>
    <div class="kpi"><div class="label">Suggested stake (all)</div><div class="value">${money(stake)}</div></div>
  </div>`;
  const cols = [
    { key: "_add", label: "", html: (r) => addBtn(
        { sport: state.sport, event_id: r.event_id, market: r.market, outcome: r.outcome, point: r.point, description: r.player },
        legInfo(r), r.book, r.price) },
    { key: "ev", label: "EV", html: (r) => `<span class="ev-pill ${r.ev < 0.0005 ? "zero" : ""}">${pct(r.ev, 2)}</span>${r.warnings.length ? `<span class="warn-icon" title="${esc(r.warnings.join("; "))}">⚠</span>` : ""}` },
    { key: "commence_time", label: "Game", html: matchupCell },
    { key: "selection", label: "Bet", html: betCell },
    { key: "book", label: "Book", html: (r) => bookCell(r.book, r.link), value: (r) => bookMeta(r.book).title },
    { key: "price", label: "Odds", num: true, html: (r) => `<span class="price">${odds(r.price)}</span>` },
    { key: "open_price", label: "Open", num: true, html: openCell },
    { key: "fair_prob", label: "Fair", num: true, html: (r) => `${odds(r.fair_price)}<span class="sub">${pct(r.fair_prob)}</span>` },
    { key: "fair_source", label: "Fair from", html: (r) => r.fair_source === "consensus"
        ? `<span class="tag" title="Average no-vig price of ${r.fair_books} other books (not ${esc(bookMeta(r.book).title)} itself; books that share an odds feed count once)">${r.fair_books} other books</span>`
        : `<span class="tag">${esc(bookMeta(r.fair_source).title)} ${r.ref_price ? odds(r.ref_price) : ""}</span>` },
    { key: "ref_hold", label: "Hold", num: true, html: (r) => pct(r.ref_hold) },
    { key: "stake", label: "Stake", num: true, html: (r) => `${money(r.stake)}<span class="sub">${pct(r.kelly, 2)} of bankroll</span>` },
    { key: "age_min", label: "Age", num: true, html: (r) => (r.age_min == null ? "–" : `${Math.max(0, Math.round(r.age_min))}m`) },
  ];
  const fairNote = { auto: "Pinnacle's when it posts the line, otherwise the average of the other books", pinnacle: "Pinnacle's only", consensus: "the average of the other books, Pinnacle included" }[state.fairMode];
  const note = `EV is measured against the vig-free price: ${fairNote} (a consensus never includes the book being bet, and books that share an odds feed count once). Open is where this book's price for the bet started (the first price this device recorded); ▲ means it has moved in your favor since. Tap a player to see all of that game's props.`;
  if (isMobile()) return kpis + `<div class="m-list">${rows.map(evCard).join("")}</div><p class="foot-note">${note}</p>`;
  return kpis + table("ev", cols, rows, { key: "ev", asc: false }) + `<p class="foot-note">${note} Age is how old the book's price was when it was pulled.</p>`;
}

/** The bet's opening line/price at this book, with ▲/▼ for movement in the bettor's favor since. */
function openMove(r) {
  if (r.open_price == null) return null;
  const now = favorability(r.market, r.outcome, r.point), was = favorability(r.market, r.outcome, r.open_point);
  if (now === was && r.price === r.open_price) return { cls: "same", arrow: "" };
  const up = now !== was ? now > was : r.price > r.open_price;
  return { cls: up ? "up" : "down", arrow: up ? "▲" : "▼" };
}
function openText(r) {
  const spread = r.market.includes("spreads");
  const pt = r.open_point != null && (r.market.includes("spreads") || r.market.includes("totals") || r.is_prop) ? `${point(r.open_point, spread)} ` : "";
  return `${pt}${odds(r.open_price)}`;
}
function openCell(r) {
  const m = openMove(r);
  if (!m) return `<span class="muted">–</span>`;
  return `<span class="open-val">${openText(r)}</span>${m.arrow ? `<span class="mv ${m.cls}">${m.arrow}</span>` : ""}`;
}

// ---- Odds Screen (main lines) ---------------------------------------------------------

function favorability(market, side, pt) {
  if (pt == null) return 0;
  if (market === "spreads" || side === "Under") return pt;
  return -pt;
}

// ---- one line at a time: books are only compared at the same line ----
const lineSel = new Map(); // "event|market[|player]" -> chosen line value
const sameLine = (a, b) => (a == null && b == null) || a === b;
function pickLine(group, key) {
  const want = lineSel.has(key) ? lineSel.get(key) : group.main_line;
  return group.lines.find((l) => sameLine(l.line, want)) ?? group.lines.find((l) => sameLine(l.line, group.main_line)) ?? group.lines[0];
}
function lineLabel(l, market) {
  const r = l.rows[0];
  return market === "spreads" ? `${teamShort(r.side)} ${point(r.point, true)}` : point(l.line, false);
}
function lineChips(group, key, market, chosen) {
  if (group.lines.length < 2) return "";
  return `<div class="line-chips" role="group" aria-label="Line">${group.lines.map((l) =>
    `<button class="chip ${l === chosen ? "on" : ""}" data-line-key="${esc(key)}" data-line-val='${JSON.stringify(l.line)}'>${esc(lineLabel(l, market))}
      <span class="muted">${l.n_books}</span></button>`).join("")}</div>`;
}
/** For books that aren't at the chosen line: (row index, book) -> the line they do post. */
function otherLines(group, chosen) {
  const by = chosen.rows.map(() => new Map());
  for (const l of group.lines) {
    if (l === chosen) continue;
    l.rows.forEach((r, i) => { for (const b of Object.keys(r.cells)) if (!by[i].has(b)) by[i].set(b, { line: l.line, point: r.point }); });
  }
  return (i, book) => by[i]?.get(book) ?? null;
}
const allCells = (group) => group.lines.flatMap((l) => l.rows.map((r) => r.cells));

// pick(row) -> {spec without point, info} makes each bettable cell selectable for the parlay slip.
// others(rowIndex, book) names the line a book posts when it isn't at this one.
function oddsCells(rows, books, market, spread, pick = null, others = null, lineKey = "") {
  return rows.map((row, ri) => {
    const fair = row.fair
      ? `<td class="oc fair-col" title="vig-free · ${esc(row.fair.source)}"><span class="pt">${point(row.fair.point, spread)}</span>${odds(row.fair.price)}</td>`
      : `<td class="oc fair-col empty">–</td>`;
    // Opening line: the reference book's first recorded price, else the best book's, else any book's
    const opener = [meta.reference, row.best_book, ...Object.keys(row.cells)]
      .map((k) => k && row.cells[k] && row.cells[k].open_price != null ? [k, row.cells[k]] : null).find(Boolean);
    const open = opener
      ? `<td class="oc open-col" title="Opened at ${esc(bookMeta(opener[0]).title)} (first price this device recorded)"><span class="pt">${point(opener[1].open_point, spread)}</span>${odds(opener[1].open_price)}</td>`
      : `<td class="oc open-col empty">–</td>`;
    const cells = books.map((b) => {
      const c = row.cells[b.key];
      if (!c) {
        const o = others?.(ri, b.key);
        if (!o) return `<td class="oc empty">–</td>`;
        const at = point(o.point, spread);
        return `<td class="oc other-line"><button class="other-line-btn" data-line-key="${esc(lineKey)}" data-line-val='${JSON.stringify(o.line)}'
          title="${esc(b.title)} posts ${esc(at)}, not this line, so its price isn't comparable here. Tap to compare at ${esc(at)}.">@ ${esc(at)}</button></td>`;
      }
      let mv = "";
      if (c.prev_price != null && (c.prev_price !== c.price || c.prev_point !== c.point)) {
        // better for the bettor = better line first, then better price
        const now = favorability(market, row.side, c.point), was = favorability(market, row.side, c.prev_point);
        const up = now !== was ? now > was : c.price > c.prev_price;
        mv = `<span class="mv ${up ? "up" : "down"}">${up ? "▲" : "▼"}</span>`;
      }
      const tip = c.open_price != null ? `Opened ${point(c.open_point, spread)} ${odds(c.open_price)}` : "";
      const cls = b.reference ? "ref" : row.best_book === b.key ? "best" : "";
      const openSub = state.showOpen && c.open_price != null
        ? `<span class="open-sub ${c.open_price !== c.price || c.open_point !== c.point ? "moved" : ""}">o ${point(c.open_point, spread)} ${odds(c.open_price)}</span>` : "";
      const inner = `<span class="pt">${point(c.point, spread)}</span>${odds(c.price)}${mv}${openSub}`;
      if (b.reference || !pick) return `<td class="oc ${cls}" title="${esc(tip)}">${inner}</td>`;
      const { spec, info } = pick(row);
      const leg = { ...spec, point: c.point };
      const picked = slip.legs.some((l) => legId(l.spec) === legId(leg) && l.book === b.key);
      const link = c.link ? `<a class="cell-link" href="${esc(c.link)}" target="_blank" rel="noopener" title="Open ${esc(b.title)}">↗</a>` : "";
      const hint = `${picked ? "In your parlay. Click to remove" : `Add to parlay at ${b.title}`}${tip ? ` · ${tip}` : ""}`;
      return `<td class="oc pickable ${cls} ${picked ? "picked" : ""}" ${pickAttr(leg, info, b.key, c.price)} title="${esc(hint)}">${inner}${link}</td>`;
    }).join("");
    return { fair, open, cells };
  });
}

function visibleBooks(cellsList) {
  const chosen = state.books ? new Set(state.books) : null;
  const posted = new Set(cellsList.flatMap((cells) => Object.keys(cells)));
  return meta.books.filter((b) => posted.has(b.key) && (b.reference || !chosen || chosen.has(b.key)));
}
const bookHeaders = (books) => books.map((b) =>
  `<th class="book-col"><i style="background:${esc(b.color)}"></i>${esc(b.title)}</th>`).join("");

function renderScreen(data) {
  if (!data.events.length) return emptyState("No upcoming games", "The latest snapshot has no games that haven't started.");
  const spread = state.market === "spreads";
  const books = visibleBooks(data.events.flatMap(allCells));
  return `<div class="events">${data.events.map((ev) => {
    const mt = meta.markets.find((m) => m.key === state.market).title;
    const key = `${ev.id}|${state.market}`;
    const chosen = pickLine(ev, key);
    const built = oddsCells(chosen.rows, books, state.market, spread, (row) => ({
      spec: { sport: state.sport, event_id: ev.id, market: state.market, outcome: row.side, description: null },
      info: legInfo(ev, { market_title: mt }),
    }), otherLines(ev, chosen), key);
    const rows = chosen.rows.map((row, i) => {
      const label = state.market === "totals"
        ? `<div class="bet"><span class="ou-badge">${row.side === "Over" ? "O" : "U"}</span><b>${esc(row.side)}</b></div>`
        : `<div class="bet">${teamLogo(row.side, "lg")}<b>${esc(isMobile() ? teamShort(row.side) : row.side)}</b></div>`;
      return `<tr><td class="side-cell">${label}</td>${built[i].fair}${built[i].open}${built[i].cells}</tr>`;
    }).join("");
    return `<div class="card">
      <div class="event-head">
        <div class="event-title"><span class="logo-pair">${teamLogo(ev.away, "lg")}${teamLogo(ev.home, "lg")}</span>
          <div><div class="names">${esc(ev.away)} @ ${esc(ev.home)}${preTag(ev)}</div><span class="sub">${kickoff(ev.commence_time)}</span></div></div>
        <div class="event-actions"><button class="btn btn-sm btn-ghost" data-history="${esc(ev.id)}" data-name="${esc(ev.name)}" data-market="${state.market}">Line history</button></div>
      </div>
      ${lineChips(ev, key, state.market, chosen)}
      <div class="table-wrap"><table><thead><tr><th>${esc(meta.markets.find((m) => m.key === state.market).title)}</th><th class="num fair-col">Fair</th><th class="num open-col">Open</th>${bookHeaders(books)}</tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  }).join("")}</div>
  <p class="foot-note">Books are compared at one line at a time (the one most books post, unless you pick another). A book on a different line shows "@ its line" instead of a price; tap it to compare at that line. Click any price to add that exact bet to your parlay (↗ opens the sportsbook). Green marks the best price at this line. ▲▼ show movement since the previous refresh. Open is the first line this device recorded (${esc(bookMeta(meta.reference).title)} when it posts one); turn on Opening odds in the filters to see every book's opener. ${esc(bookMeta(meta.reference).title)} is shown for reference only.</p>`;
}

// ---- Odds Screen (player props) ----------------------------------------------------

function renderPropsList(data) {
  if (!data.events.length) return emptyState("No upcoming games", "Pull main lines first so the games show up here.");
  const per = sportMeta().props_cost_per_event;
  return `<div class="events">${data.events.map((ev) => {
    const open = openProps.has(ev.id);
    const status = ev.props_fetched_at && ev.n_players
      ? `<span class="prop-status"><b>${ev.n_players}</b> players · ${ev.markets.length} markets · pulled ${ago(ev.props_fetched_at)}</span>`
      : ev.props_fetched_at
        ? `<span class="prop-status">No props posted yet · checked ${ago(ev.props_fetched_at)}</span>`
        : ev.preseason ? `<span class="prop-status">Books don't post preseason props</span>` : `<span class="prop-status">Props not pulled yet</span>`;
    return `<div class="card ${open ? "open" : ""}" data-prop-event="${esc(ev.id)}">
      <div class="event-head">
        <div class="event-title"><span class="logo-pair">${teamLogo(ev.away, "lg")}${teamLogo(ev.home, "lg")}</span>
          <div><div class="names">${esc(ev.away)} @ ${esc(ev.home)}${preTag(ev)}</div><span class="sub">${kickoff(ev.commence_time)}</span></div></div>
        <div class="event-actions">${status}
          <button class="btn btn-sm btn-secondary" data-pull="${esc(ev.id)}">${ev.props_fetched_at ? "↻ Refresh" : "Pull props"} <span class="cost">≤${per} cr</span></button>
          ${ev.props_fetched_at ? `<button class="icon-btn" data-toggle="${esc(ev.id)}" aria-label="Expand"><svg class="chev" width="14" height="14" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>` : ""}
        </div>
      </div>
      ${open && ev.props_fetched_at ? `<div class="prop-body" id="prop-body-${esc(ev.id)}">${propData[ev.id] ? renderPropBody(ev, propData[ev.id]) : `<div class="skeleton" style="height:160px;margin:12px"></div>`}</div>` : ""}
    </div>`;
  }).join("")}</div>
  <p class="foot-note">Each player is compared at one line at a time; a book on a different line shows "@ its line" (tap it, or the line chips, to switch). Click any price to add that exact bet to your parlay. Each pull is billed only for the prop markets books have posted for that game. Green marks the best price at the shown line.</p>`;
}

function renderPropBody(ev, data) {
  if (!data.markets.length) return `<div class="empty-state" style="padding:28px"><p>No books had props posted for this game at the last pull.</p></div>`;
  const sel = propMarket[ev.id] && data.markets.some((m) => m.market === propMarket[ev.id]) ? propMarket[ev.id] : data.markets[0].market;
  const market = data.markets.find((m) => m.market === sel);
  const books = visibleBooks(market.players.flatMap(allCells));
  const seg = `<div class="seg" data-prop-market="${esc(ev.id)}">${data.markets.map((m) =>
    `<button data-val="${esc(m.market)}" class="${m.market === sel ? "active" : ""}">${esc(m.title)} <span class="muted">${m.players.length}</span></button>`).join("")}</div>`;
  const body = market.players.map((pl, pi) => {
    const key = `${ev.id}|${sel}|${pl.player}`;
    const chosen = pickLine(pl, key);
    const built = oddsCells(chosen.rows, books, sel, false, (row) => ({
      spec: { sport: state.sport, event_id: ev.id, market: sel, outcome: row.side, description: pl.player },
      info: legInfo(ev, { is_prop: true, player: pl.player, market_title: market.title }),
    }), otherLines(pl, chosen), key);
    const chips = lineChips(pl, key, sel, chosen);
    return chosen.rows.map((row, i) => {
      const who = i === 0
        ? `<td class="side-cell" rowspan="2"><div class="bet">${avatar(ev.id, pl.player)}<div><b>${esc(pl.player)}</b><span class="sub">${pl.n_books} books
            · <a href="#" data-history="${esc(ev.id)}" data-name="${esc(pl.player)}" data-market="${esc(sel)}" data-desc="${esc(pl.player)}">history</a></span>${chips}</div></div></td>`
        : "";
      if (isMobile()) {
        const head = i === 0 ? `<tr class="player-head" data-player="${esc(pl.player)}"><td colspan="${books.length + 3}"><div class="bet">${avatar(ev.id, pl.player, true)}<b>${esc(pl.player)}</b>
          <span class="muted">${pl.n_books} books · <a href="#" data-history="${esc(ev.id)}" data-name="${esc(pl.player)}" data-market="${esc(sel)}" data-desc="${esc(pl.player)}">history</a></span></div>${chips}</td></tr>` : "";
        return `${head}<tr class="player-group ${i === 1 ? "last" : ""}" data-player="${esc(pl.player)}"><td class="side-cell muted">${row.side}</td>${built[i].fair}${built[i].open}${built[i].cells}</tr>`;
      }
      return `<tr class="player-group ${i === 1 ? "last" : ""}" data-player="${esc(pl.player)}">${who}<td class="muted" style="width:60px">${row.side}</td>${built[i].fair}${built[i].open}${built[i].cells}</tr>`;
    }).join("");
  }).join("");
  const head = isMobile() ? `<tr><th class="side-cell"></th><th class="num fair-col">Fair</th><th class="num open-col">Open</th>${bookHeaders(books)}</tr>`
    : `<tr><th>Player</th><th></th><th class="num fair-col">Fair</th><th class="num open-col">Open</th>${bookHeaders(books)}</tr>`;
  return seg + `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

async function loadPropBody(eventId) {
  try {
    propData[eventId] = await api(`/api/props-screen?sport=${state.sport}&event_id=${encodeURIComponent(eventId)}&method=${state.method}${booksParam()}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  renderContent();
}

let focusProp = null; // {eventId, player}: scroll to this player once the game's props render

function showGameProps(eventId, player, market) {
  openProps.add(eventId);
  propMarket[eventId] = market;
  focusProp = { eventId, player };
  state.market = "props";
  saveSettings();
  if (state.tab === "screen") load(); else location.hash = "screen";
}

function applyPropFocus() {
  if (!focusProp) return;
  const body = document.getElementById(`prop-body-${focusProp.eventId}`);
  if (!body || !propData[focusProp.eventId]) return;
  const rows = [...body.querySelectorAll("tr[data-player]")].filter((tr) => tr.dataset.player === focusProp.player);
  const card = body.closest(".card");
  (rows[0] ?? card)?.scrollIntoView({ block: "center", behavior: "smooth" });
  rows.forEach((tr) => { tr.classList.add("flash"); setTimeout(() => tr.classList.remove("flash"), 2400); });
  focusProp = null;
}

document.addEventListener("click", (e) => {
  const sp = e.target.closest("[data-show-props]");
  if (sp) { e.preventDefault(); showGameProps(sp.dataset.showProps, sp.dataset.player, sp.dataset.market); }
});

$("#content").addEventListener("click", async (e) => {
  const pull = e.target.closest("button[data-pull]");
  if (pull) { if (!needKey()) await pullProps([pull.dataset.pull], pull); return; }

  const tog = e.target.closest("[data-toggle]");
  if (tog) {
    const id = tog.dataset.toggle;
    if (openProps.has(id)) openProps.delete(id); else openProps.add(id);
    renderContent();
    return;
  }

  const ls = e.target.closest("[data-line-key]");
  if (ls) { lineSel.set(ls.dataset.lineKey, JSON.parse(ls.dataset.lineVal)); renderContent(); return; }

  const pm = e.target.closest("[data-prop-market] button");
  if (pm) { propMarket[pm.parentElement.dataset.propMarket] = pm.dataset.val; renderContent(); return; }

  const h = e.target.closest("[data-history]");
  if (h) { e.preventDefault(); showHistory(h.dataset); }
});

// the props list renders before its bodies load; fetch any expanded body we don't have
const pendingBodies = new Set();
function ensurePropBodies() {
  if (state.tab !== "screen" || state.market !== "props") return;
  openProps.forEach((id) => {
    if (propData[id] || pendingBodies.has(id) || !document.getElementById(`prop-body-${id}`)) return;
    pendingBodies.add(id);
    loadPropBody(id).finally(() => pendingBodies.delete(id));
  });
}

// ---- Middles / Low hold ------------------------------------------------------------

function legsCell(r, withStake) {
  return `<div class="legs">${r.legs.map((l) =>
    `<div><span class="price">${odds(l.price)}</span> <b>${esc(l.selection)}</b> ${bookCell(l.book, l.link)}${withStake ? `<span class="muted">${money(l.stake)}</span>` : ""}</div>`).join("")}</div>`;
}
function subjectCell(r) {
  if (r.is_prop) return `<div class="bet">${propLink(r, `${avatar(r.event_id, r.player, true)}<div><b>${esc(r.player)} <span class="go">›</span></b><span class="sub">${esc(r.market_title)}</span></div>`)}</div>`;
  return `<span class="tag">${esc(r.market_title)}</span>`;
}

function renderMiddles(data) {
  const rows = data.rows.filter((r) => -r.miss_pct * 100 <= state.maxMiss);
  if (!rows.length) return emptyState("No middles in range", `None cost ${state.maxMiss}% or less if they miss. Main-line middles mostly show up after lines move, so try again after a refresh.`);
  if (isMobile()) return `<div class="m-list">${rows.map(middleCard).join("")}</div>
    <p class="foot-note">Break-even is how often the middle has to land to profit. The stakes pay the same if only one leg wins.</p>`;
  const cols = [
    { key: "breakeven", label: "Break-even", num: true, html: (r) => `<span class="price">${pct(r.breakeven)}</span>` },
    { key: "commence_time", label: "Game", html: matchupCell },
    { key: "market_title", label: "Market", html: subjectCell },
    { key: "legs", label: "Legs · equal-return stakes", html: (r) => legsCell(r, true), value: (r) => r.legs[0].selection },
    { key: "hits", label: "Lands on", html: (r) => r.hits.map((h) =>
        `<div>${esc(h.text)} <span class="muted">${h.kind} · <span class="pos">+${money(h.profit)}</span></span></div>`).join("") +
        (r.key_number ? `<span class="tag key">key number</span>` : ""), value: (r) => r.hits.length },
    { key: "gap", label: "Gap", num: true, html: (r) => r.gap },
    { key: "miss_pct", label: "If miss", num: true, html: (r) => `<span class="${r.miss_pct < 0 ? "neg" : "pos"}">${pct(r.miss_pct, 2)}</span>` },
  ];
  return table("middles", cols, rows, { key: "breakeven", asc: true }) +
    `<p class="foot-note">Break-even is how often the middle has to land to profit, counting whole-number results only. The stakes pay the same if only one leg wins.</p>`;
}

function renderLowHold(data) {
  const rows = data.rows.filter((r) => r.hold * 100 <= state.maxHold);
  if (!rows.length) return emptyState("Nothing under that hold", `No markets at or below ${state.maxHold}% combined hold.`);
  if (isMobile()) return `<div class="m-list">${rows.map(lowHoldCard).join("")}</div>`;
  const cols = [
    { key: "hold", label: "Hold", num: true, html: (r) => `<span class="price ${r.hold < 0 ? "pos" : ""}">${pct(r.hold, 2)}</span>${r.hold < 0 ? ` <span class="tag arb">arb</span>` : ""}` },
    { key: "commence_time", label: "Game", html: matchupCell },
    { key: "market_title", label: "Market", html: subjectCell },
    { key: "legs", label: "Best price each side", html: (r) => legsCell(r, false), value: (r) => r.legs[0].selection },
    { key: "n_books", label: "Books", num: true, html: (r) => r.n_books },
  ];
  return table("lowhold", cols, rows, { key: "hold", asc: true });
}

// ============================================================================
// parlays: slip state, add buttons, drawer, analysis + generator views
// ============================================================================

const SLIP_KEY = "oddscreen-slip";
const slip = (() => {
  const base = { legs: [], corr: {}, boost: 0, quote: null };
  try { return { ...base, ...JSON.parse(localStorage.getItem(SLIP_KEY) || "{}") }; } catch { return base; }
})();
let slipResult = null;
let slipError = null;
let slipTimer = null;
let genResults = null;
let genBusy = false;

function saveSlip() {
  try { localStorage.setItem(SLIP_KEY, JSON.stringify(slip)); } catch { /* ignore */ }
}
// must match parlay.LegSpec.id on the server
const legId = (s) => `${s.event_id}|${s.market}|${s.description || ""}|${s.outcome}|${s.point == null ? "" : String(s.point)}`;
const pairKey = (a, b) => [a, b].sort().join("~");

function legLabel(s) {
  if (s.market.startsWith("player_")) return `${s.description} ${s.outcome} ${s.point}`;
  if (s.market === "h2h") return `${s.outcome} ML`;
  return `${s.outcome} ${point(s.point, s.market === "spreads")}`;
}

// Picks register the exact bet they add (book, line, price); the registry is rebuilt on every render
const addReg = new Map();
let addSeq = 0;
function pickAttr(spec, info, book, price) {
  const key = String(++addSeq);
  addReg.set(key, { spec, info, book, price });
  return `data-add="${key}"`;
}
const isPicked = (spec, book) => slip.legs.some((l) => legId(l.spec) === legId(spec) && l.book === book);
function addBtn(spec, info, book, price) {
  const inSlip = isPicked(spec, book);
  return `<button class="add-btn ${inSlip ? "in" : ""}" ${pickAttr(spec, info, book, price)} title="${inSlip ? "In your parlay. Click to remove" : `Add to parlay at ${esc(bookMeta(book).title)}`}">${inSlip ? "✓" : "+"}</button>`;
}
const legInfo = (r, extra = {}) => ({
  event: r.event || r.name, home: r.home, away: r.away, commence_time: r.commence_time, preseason: r.preseason,
  is_prop: !!r.is_prop, player: r.player ?? null, market_title: r.market_title, event_id: r.event_id || r.id, ...extra,
});
const bookTitle = (key) => bookMeta(key).title;

function addLeg(spec, info, book, price) {
  const id = legId(spec);
  const existing = slip.legs.find((l) => legId(l.spec) === id);
  if (existing) {
    if (existing.book === book) { removeLeg(id); return; }
    existing.book = book;  // same bet, picked at a different book
    existing.price = price;
    toast(`${existing.label}: now at ${bookTitle(book)} ${odds(price)}`);
    afterSlipChange();
    return;
  }
  const clash = slip.legs.find((l) => l.spec.event_id === spec.event_id && l.spec.market === spec.market
    && (l.spec.description || "") === (spec.description || ""));
  if (clash) {
    slip.legs = slip.legs.filter((l) => l !== clash);
    toast(`Replaced ${clash.label}: books won't take two picks from the same market in one parlay`);
  }
  slip.legs.push({ spec, info, label: legLabel(spec), book, price });
  ensureMedia([spec.sport]);
  afterSlipChange();
  const fab = $("#slip-fab");
  fab.classList.remove("bump"); void fab.offsetWidth; fab.classList.add("bump");
}

function removeLeg(id) {
  slip.legs = slip.legs.filter((l) => legId(l.spec) !== id);
  const ids = new Set(slip.legs.map((l) => legId(l.spec)));
  for (const k of Object.keys(slip.corr)) if (!k.split("~").every((x) => ids.has(x))) delete slip.corr[k];
  afterSlipChange();
}

// The parlay is priced at the book you picked from. When picks span books,
// keep the current choice while some pick still uses it.
function syncSlipBook() {
  const used = [...new Set(slip.legs.map((l) => l.book).filter(Boolean))];
  if (used.length === 1) slip.book = used[0];
  else if (!used.includes(slip.book)) slip.book = used[0] ?? null;
}

function afterSlipChange() {
  syncSlipBook();
  saveSlip();
  slipResult = null;
  renderSlip();
  if (state.tab !== "parlays") renderContent(); // refresh picked marks
  schedulePrice();
}

function setSlipBook(book) {
  slip.book = book;
  saveSlip();
  schedulePrice();
}

function schedulePrice() {
  clearTimeout(slipTimer);
  if (!slip.legs.length) { slipResult = null; slipError = null; renderSlip(); if (state.tab === "parlays") renderContent(); return; }
  slipTimer = setTimeout(priceSlip, 220);
}

async function priceSlip() {
  const body = {
    legs: slip.legs.map((l) => ({ ...l.spec, book: l.book ?? null })),
    correlations: Object.entries(slip.corr).map(([k, rho]) => { const [a, b] = k.split("~"); return { a, b, rho }; }),
    boost: Number(slip.boost) || 0,
    sgp_quote: slip.book && slip.quote?.american ? { book: slip.book, american: Number(slip.quote.american) } : null,
    book: slip.book || null,
    books: state.books ? state.books.join(",") : null,
    method: state.method, min_books: state.minBooks, kelly: state.kelly, bankroll: state.bankroll,
    max_stake_pct: state.maxStakePct,
  };
  try {
    slipResult = await post("/api/parlay/price", body);
    slipError = null;
  } catch (err) {
    slipResult = null;
    slipError = err.message;
  }
  renderSlip();
  if (state.tab === "parlays" && state.parlayView === "slip") renderContent();
}

document.addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // the ↗ link inside a cell opens the book instead
  const at = e.target.closest("[data-price-at]");
  if (at) { setSlipBook(at.dataset.priceAt); return; }
  const b = e.target.closest("[data-add]");
  if (!b) return;
  const entry = addReg.get(b.dataset.add);
  if (entry) addLeg(entry.spec, entry.info, entry.book, entry.price);
});

// ---- leg presentation ----------------------------------------------------------

function legIcon(leg, small = false) {
  const s = leg.spec, i = leg.info || {};
  if (s.market.startsWith("player_")) return avatar(s.event_id, s.description, small, s.sport);
  if (s.outcome === i.home || s.outcome === i.away) return teamLogo(s.outcome, small ? "" : "lg", s.sport);
  return `<span class="ou-badge" ${small ? 'style="width:28px;height:28px"' : ""}>${s.outcome === "Over" ? "O" : "U"}</span>`;
}
function legSub(leg) {
  const i = leg.info || {}, s = leg.spec;
  const game = i.home ? `${teamShort(i.away, s.sport)} @ ${teamShort(i.home, s.sport)}` : (i.event || "");
  const mkt = s.market.startsWith("player_") ? i.market_title || "" : "";
  return [mkt, game, i.commence_time ? kickoff(i.commence_time) : ""].filter(Boolean).join(" · ");
}
const resultLeg = (id) => slipResult?.legs.find((l) => l.id === id);
const pickedBooks = () => [...new Set(slip.legs.map((l) => l.book).filter(Boolean))];

// ---- drawer ----------------------------------------------------------------------

function openSlip(open = true) {
  $("#slip").classList.toggle("open", open);
  document.body.classList.toggle("slip-open", open);
}
$("#slip-scrim").addEventListener("click", () => openSlip(false));
$("#slip-fab").addEventListener("click", () => openSlip(!$("#slip").classList.contains("open")));
$("#slip-close").addEventListener("click", () => openSlip(false));
$("#slip-clear").addEventListener("click", () => {
  slip.legs = []; slip.corr = {}; slip.quote = null; slip.book = null;
  afterSlipChange();
});

function sgpPairs() {
  const byGame = {};
  slip.legs.forEach((l) => (byGame[l.spec.event_id] ||= []).push(l));
  const pairs = [];
  Object.values(byGame).forEach((g) => {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) pairs.push([g[i], g[j]]);
  });
  return pairs;
}

// Why the chosen book has no price yet.
function noPriceReason(r) {
  const c = r.chosen, name = slip.book ? bookTitle(slip.book) : "this book";
  if (!slip.book) return "Pick a book to place this parlay at.";
  if (c?.missing?.length && !r.is_sgp) {
    return `${name} doesn't offer ${c.missing.map((m) => `${m.label}${m.alt ? ` (has ${point(m.alt.point, m.spread)})` : ""}`).join(", ")} at your line.`;
  }
  if (r.is_sgp) return `Enter ${name}'s same-game parlay price below to get EV.`;
  return "Some legs have no fair price yet.";
}

function betterElsewhere(r) {
  const c = r.chosen, best = r.best;
  if (!best || best.book === slip.book || (c?.ev != null && best.ev <= c.ev + 1e-9)) return "";
  return `<div class="stats"><div style="grid-column:1/-1"><span>Better elsewhere</span>${esc(bookTitle(best.book))} pays
    <b>${odds(best.boosted_decimal)}</b> (${pct(best.ev, 2)} EV) <button class="btn btn-sm btn-ghost" data-price-at="${best.book}">Price there</button></div></div>`;
}

function summaryCard(r) {
  if (!r) return "";
  if (r.errors.length) return r.errors.map((e) => `<div class="alert error">${esc(e)}</div>`).join("");
  const c = r.chosen;
  const boostTxt = Number(slip.boost) ? ` <span class="tag">+${slip.boost}% boost</span>` : "";
  if (!c || c.ev == null) {
    return `<div class="summary"><div class="top"><div><span class="muted" style="font-size:12px">Fair odds</span><div class="big">${odds(r.fair_decimal)}</div></div>
      <div style="text-align:right"><span class="muted" style="font-size:12px">Win chance</span><div class="mono">${pct(r.fair_prob)}</div></div></div>
      <div class="stats"><div style="grid-column:1/-1"><span>No price at ${esc(slip.book ? bookTitle(slip.book) : "a book")}</span>${esc(noPriceReason(r))}</div></div>
      ${betterElsewhere(r)}</div>`;
  }
  return `<div class="summary">
    <div class="top">
      <div><span class="muted" style="font-size:12px">${bookCell(c.book)}${boostTxt}</span><div class="big">${odds(c.boosted_decimal)}</div></div>
      <div style="text-align:right"><span class="muted" style="font-size:12px">EV</span><div class="big ${c.ev > 0 ? "pos" : "neg"}">${pct(c.ev, 2)}</div></div>
    </div>
    <div class="stats">
      <div><span>Fair odds</span><b>${odds(c.fair_decimal)}</b></div>
      <div><span>Win chance</span><b>${pct(c.win_prob)}</b></div>
      <div><span>Stake</span><b>${c.stake > 0 ? money(c.stake) : "–"}</b></div>
    </div>
    ${c.ev <= 0 && c.min_boost > 0 ? `<div class="stats"><div style="grid-column:1/-1"><span>Break-even boost</span>A <b>${pct(c.min_boost, 0)}</b> profit boost at ${esc(bookTitle(c.book))} makes this +EV.</div></div>` : ""}
    ${betterElsewhere(r)}
  </div>`;
}

function bookPicker(r) {
  const used = pickedBooks();
  const counts = used.map((b) => `${bookTitle(b)} ×${slip.legs.filter((l) => l.book === b).length}`).join(", ");
  const options = meta.books.filter((b) => !b.reference).map((b) => {
    const row = r?.books.find((x) => x.book === b.key);
    const tag = row?.decimal ? ` · ${odds(row.boosted_decimal ?? row.decimal)}` : row?.missing?.length ? " · missing legs" : "";
    return `<option value="${b.key}" ${slip.book === b.key ? "selected" : ""}>${esc(b.title)}${tag}</option>`;
  }).join("");
  return `<div class="slip-section"><h4>Place at</h4><select data-slip-book style="width:100%">${slip.book ? "" : `<option value="">Choose a book</option>`}${options}</select>
    ${used.length > 1 ? `<div class="alert" style="margin-top:8px">Your picks come from ${used.length} books (${esc(counts)}). A parlay is one ticket at one book, so it's priced at ${esc(bookTitle(slip.book))}.</div>` : ""}</div>`;
}

function renderSlip() {
  $("#slip-count").textContent = slip.legs.length;
  const pc = document.querySelector('[data-count="parlays"]');
  if (pc) pc.textContent = slip.legs.length || "";
  const body = $("#slip-body");
  if (!slip.legs.length) {
    body.innerHTML = `<div class="empty-state" style="padding:40px 8px"><h3>Your slip is empty</h3>
      <p>Click any price on the Odds Screen, or <b>+</b> in Positive EV, to add that exact bet. Or load one from Parlays → Generator.</p></div>`;
    return;
  }
  const r = slipResult;
  const legs = slip.legs.map((l) => {
    const id = legId(l.spec);
    const res = resultLeg(id);
    const book = l.book || res?.best_book;
    const price = l.book ? l.price : res?.best_price;
    const ev = res?.fair_prob && price ? res.fair_prob * price - 1 : null;
    let note = "";
    if (l.book && slip.book && l.book !== slip.book && res) {
      const there = res.books[slip.book];
      note = `<span class="sub leg-warn">${there ? `At ${esc(bookTitle(slip.book))}: ${odds(there.price)}` : `Not at ${esc(bookTitle(slip.book))} on this line`}</span>`;
    }
    return `<div class="slip-leg">${legIcon(l, true)}<div class="grow"><b title="${esc(l.label)}">${esc(l.label)}${preTag(l.info || {})}</b><span class="sub">${esc(legSub(l))}</span>${note}</div>
      <div class="right">${price ? odds(price) : "–"}<span class="sub">${book ? esc(bookTitle(book)) : ""}${res?.books?.[book]?.link ? ` <a class="leg-link" href="${esc(res.books[book].link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</span>${ev != null ? `<span class="sub ${ev > 0 ? "pos" : "neg"}" ${res.fair_thin ? 'title="Rough: few books post this exact line"' : ""}>${res.fair_thin ? "≈" : ""}${pct(ev, 1)} EV</span>` : ""}</div>
      <button class="x" data-remove="${esc(id)}" aria-label="Remove">✕</button></div>`;
  }).join("");

  const pairs = sgpPairs();
  const corr = pairs.length ? `<div class="slip-section"><h4>Same-game correlation</h4>
      ${pairs.map(([a, b]) => {
        const k = pairKey(legId(a.spec), legId(b.spec));
        const v = slip.corr[k] ?? 0;
        return `<div class="corr-row"><span class="names" title="${esc(a.label)} × ${esc(b.label)}">${esc(a.label)} × ${esc(b.label)}</span>
          <input type="range" min="-0.3" max="0.9" step="0.05" value="${v}" data-corr="${esc(k)}"><output>${Number(v).toFixed(2)}</output></div>`;
      }).join("")}
      <div class="presets"><span class="muted" style="font-size:12px">All pairs:</span>${[0, 0.15, 0.3, 0.45].map((v) => `<button class="btn btn-sm btn-ghost" data-corr-all="${v}">${v}</button>`).join("")}</div>
      <label class="field" style="margin-top:10px;flex-direction:column;align-items:stretch;gap:4px">${esc(slip.book ? bookTitle(slip.book) : "Book")}'s SGP price (American)
        <input type="number" step="1" placeholder="+450" data-quote="american" value="${esc(slip.quote?.american ?? "")}"></label>
      </div>` : "";

  body.innerHTML = `<div class="slip-legs">${legs}</div>
    ${slipError ? `<div class="alert error">${esc(slipError)}</div>` : ""}
    ${bookPicker(r)}
    ${r ? r.warnings.filter((w) => !w.startsWith("Contains same-game")).map((w) => `<div class="alert">${esc(w)}</div>`).join("") : ""}
    ${r ? summaryCard(r) : `<div class="skeleton" style="height:130px"></div>`}
    ${corr}
    <div class="slip-section"><h4>Boost & sizing</h4><div class="slip-grid">
      <label class="field">Profit boost %<input type="number" step="5" min="0" value="${esc(slip.boost)}" data-slip="boost"></label>
      <label class="field">Max stake % bankroll<input type="number" step="0.25" min="0" value="${esc(state.maxStakePct)}" data-slip="maxStakePct"></label>
    </div><p class="foot-note" style="margin-top:8px">Stake is ${state.kelly}× Kelly on a $${state.bankroll} bankroll, capped at ${state.maxStakePct}%. Change Kelly and bankroll in Positive EV.</p></div>
    <button class="btn btn-primary" id="slip-analyze" style="justify-content:center">Full analysis →</button>`;
}

$("#slip-body").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) { removeLeg(rm.dataset.remove); return; }
  const all = e.target.closest("[data-corr-all]");
  if (all) {
    sgpPairs().forEach(([a, b]) => (slip.corr[pairKey(legId(a.spec), legId(b.spec))] = Number(all.dataset.corrAll)));
    saveSlip(); renderSlip(); schedulePrice(); return;
  }
  if (e.target.id === "slip-analyze") { openSlip(false); state.parlayView = "slip"; location.hash = "parlays"; if (state.tab === "parlays") load(); }
});
$("#slip-body").addEventListener("input", (e) => {
  const c = e.target.closest("[data-corr]");
  if (c) {
    slip.corr[c.dataset.corr] = Number(c.value);
    c.nextElementSibling.textContent = Number(c.value).toFixed(2);
    saveSlip(); schedulePrice();
  }
});
$("#slip-body").addEventListener("change", (e) => {
  const sb = e.target.closest("[data-slip-book]");
  if (sb) { setSlipBook(sb.value || null); return; }
  const q = e.target.closest("[data-quote]");
  if (q) { slip.quote = { american: q.value }; saveSlip(); schedulePrice(); return; }
  const f = e.target.closest("[data-slip]");
  if (f) {
    if (f.dataset.slip === "boost") slip.boost = Number(f.value) || 0;
    else { state.maxStakePct = Number(f.value) || 0; saveSettings(); }
    saveSlip(); schedulePrice();
  }
});

// ---- Parlays tab -------------------------------------------------------------------

function renderParlays() {
  return state.parlayView === "gen" ? renderGenerator() : renderSlipAnalysis();
}

function renderSlipAnalysis() {
  if (!slip.legs.length) return emptyState("Build a parlay", "Click any price on the <b>Odds Screen</b> (or <b>+</b> in Positive EV) to add that exact bet, or switch to <b>Generator</b> to find the best +EV parlays automatically.");
  const r = slipResult;
  if (!r) { schedulePrice(); return slipError ? emptyState("Couldn't price this parlay", esc(slipError)) : `<div class="skeleton"></div>`; }
  const c = r.chosen?.ev != null ? r.chosen : null;
  const best = r.best;
  const name = slip.book ? bookTitle(slip.book) : "–";
  const bestHint = best && best.book !== slip.book && (!c || best.ev > c.ev + 1e-9)
    ? `best: ${esc(bookTitle(best.book))} ${odds(best.boosted_decimal)} · ${pct(best.ev, 1)}` : "";
  const kpis = `<div class="kpis five">
    <div class="kpi"><div class="label">Fair odds</div><div class="value">${odds(r.fair_decimal)}</div><div class="hint">${pct(r.fair_prob, 2)} to hit</div></div>
    <div class="kpi"><div class="label">Price at ${esc(name)}</div><div class="value">${c ? odds(c.boosted_decimal) : "–"}</div><div class="hint">${c ? (bestHint || "your book") : esc(noPriceReason(r))}</div></div>
    <div class="kpi"><div class="label">Expected value</div><div class="value ${c ? (c.ev > 0 ? "pos" : "neg") : ""}">${c ? pct(c.ev, 2) : "–"}</div><div class="hint">${r.is_sgp ? "at your correlation settings" : ""}${Number(slip.boost) ? `${r.is_sgp ? " · " : ""}with ${slip.boost}% boost` : r.is_sgp ? "" : "no boost"}</div></div>
    <div class="kpi"><div class="label">Stake</div><div class="value">${c && c.stake > 0 ? money(c.stake) : "–"}</div><div class="hint">${c && c.stake > 0 ? `to win ${money(c.to_win)}` : "only +EV bets get a stake"}</div></div>
    <div class="kpi"><div class="label">Growth / bet</div><div class="value">${c ? `${(c.growth * 1e4).toFixed(1)} bp` : "–"}</div><div class="hint">expected bankroll growth (log)</div></div>
  </div>`;
  const used = pickedBooks();
  const mixed = used.length > 1 ? [`Your picks come from ${used.length} books (${used.map(bookTitle).join(", ")}). A parlay is one ticket at one book, so it's priced at ${name}. Pick another book in the table below to compare.`] : [];
  const alerts = [...r.errors.map((e) => `<div class="alert error">${esc(e)}</div>`), ...[...mixed, ...r.warnings].map((w) => `<div class="alert">${esc(w)}</div>`)].join("");

  // per-book pricing
  const bookRows = r.books.map((b) => {
    const missing = b.missing.length
      ? b.missing.map((m) => `<div class="muted">Missing ${esc(m.label)}${m.alt ? ` · has ${point(m.alt.point, m.spread)} ${odds(m.alt.price)}` : ""}</div>`).join("") : "";
    const price = b.decimal ? `<span class="price">${odds(b.boosted_decimal ?? b.decimal)}</span>` : r.is_sgp && !b.missing.length ? `<span class="muted">needs SGP quote</span>` : "–";
    const isChosen = b.book === slip.book;
    const action = isChosen ? `<span class="tag prop">your book</span>` : `<button class="btn btn-sm btn-ghost" data-price-at="${b.book}">Price here</button>`;
    return `<tr class="${isChosen ? "chosen-row" : ""}"><td>${bookCell(b.book, b.links?.[0])}</td><td class="num">${price}</td>
      <td class="num">${b.ev != null ? `<span class="ev-pill ${b.ev > 0 ? "" : "zero"}">${pct(b.ev, 2)}</span>` : "–"}</td>
      <td class="num">${b.win_prob != null ? pct(b.win_prob) : "–"}</td>
      <td class="num">${b.stake ? money(b.stake) : "–"}</td>
      <td class="num">${b.min_boost != null ? (b.min_boost > 0 ? pct(b.min_boost, 0) : `<span class="pos">already +EV</span>`) : "–"}</td>
      <td>${missing}</td><td>${action}</td></tr>`;
  }).join("");
  const shopped = r.shopped ? `<p class="foot-note">Best price on every leg, mixing books: <b class="mono">${odds(r.shopped.decimal)}</b> (${pct(r.shopped.ev, 2)} EV). You can't place this as one ticket. It shows the most your line shopping could get.</p>` : "";
  const booksTable = isMobile()
    ? `<div class="section-title"><h3>Price at every book</h3></div><div class="m-list">${r.books.map((b) => bookPriceCard(b, r)).join("")}</div>${shopped}`
    : `<div class="section-title"><h3>Price at every book</h3><p>A parlay has to be placed at one book</p></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Book</th><th class="num">Parlay odds</th><th class="num">EV</th><th class="num">Win %</th><th class="num">Stake</th><th class="num">Break-even boost</th><th>Notes</th><th></th></tr></thead><tbody>${bookRows}</tbody></table></div></div>${shopped}`;

  // legs × books matrix; your pick is outlined, the best price is green
  const books = meta.books.filter((b) => r.legs.some((l) => l.books[b.key]));
  const legRows = r.legs.map((l) => {
    const leg = slip.legs.find((x) => legId(x.spec) === l.id) || { spec: l.spec, info: l, label: l.label };
    const cells = books.map((b) => {
      const cell = l.books[b.key];
      const cls = [b.reference ? "ref" : l.best_book === b.key ? "best" : "", leg.book === b.key ? "picked" : ""].join(" ");
      return `<td class="oc ${cls}">${cell ? odds(cell.price) : l.alternates[b.key] ? `<span class="muted" title="different line">${point(l.alternates[b.key].point, l.spec.market === "spreads")}*</span>` : "–"}</td>`;
    }).join("");
    return `<tr><td class="side-cell"><div class="bet">${legIcon(leg, true)}<div><b>${esc(l.label)}</b><span class="sub">${esc(legSub(leg))}</span></div></div></td>
      <td class="oc fair-col" title="${l.fair_source ? `vig-free · ${esc(l.fair_source)}${l.fair_source === "consensus" ? ` (${l.fair_books} book${l.fair_books === 1 ? "" : "s"})` : ""}${l.fair_thin ? " · rough: few books post this line" : ""}` : "no fair price"}">${l.fair_thin ? "≈" : ""}${odds(l.fair_price)}</td>${cells}</tr>`;
  }).join("");
  const matrix = `<div class="section-title"><h3>Legs</h3><p>Outlined is your pick. Green is the best price. * means that book has a different line. ≈ means a rough fair price (few books post that line).</p></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Leg</th><th class="num fair-col">Fair</th>${bookHeaders(books)}</tr></thead><tbody>${legRows}</tbody></table></div></div>`;

  // contributions
  let contrib = "";
  if (r.contributions.length) {
    const basis = r.books.find((b) => b.book === r.contributions_book);
    contrib = `<div class="section-title"><h3>What each leg adds</h3><p>At ${esc(bookTitle(r.contributions_book))}. Parlays multiply each leg's edge, so drop any leg that costs EV.</p></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Leg</th><th class="num">Price</th><th class="num">Leg EV</th><th class="num">Parlay EV without it</th><th></th></tr></thead><tbody>${
      r.contributions.map((x) => {
        const helps = x.parlay_ev_without == null || basis.ev >= x.parlay_ev_without;
        return `<tr><td><b>${esc(x.label)}</b></td><td class="num">${odds(x.price)}</td><td class="num ${x.leg_ev > 0 ? "pos" : "neg"}">${pct(x.leg_ev, 2)}</td>
          <td class="num">${pct(x.parlay_ev_without, 2)}</td><td><span class="verdict ${helps ? "good" : "bad"}">${helps ? "adds edge" : "costs EV"}</span></td></tr>`;
      }).join("")}</tbody></table></div></div>`;
  }

  // same-game correlation curve
  let sgp = "";
  if (r.sgp) {
    const be = r.sgp.break_even;
    const quoted = slip.book && slip.quote?.american;
    const verdict = !quoted ? `Enter ${esc(name)}'s SGP price in the slip to compare it with these fair odds.`
      : be?.rho != null ? `At this quote, the parlay is +EV if the true correlation is <b>${be.rho.toFixed(2)}</b> or higher.` : esc(be?.note || "");
    sgp = `<div class="section-title"><h3>Same-game correlation</h3><p>Gaussian copula, one correlation for every same-game pair</p></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Correlation</th><th class="num">Fair odds</th>${quoted ? `<th class="num">EV at ${esc(name)} ${odds(americanToDecimal(Number(slip.quote.american)))}</th>` : ""}</tr></thead><tbody>${
        r.sgp.curve.map((x) => `<tr><td class="mono">${x.rho.toFixed(1)}</td><td class="num">${odds(x.fair_decimal)}</td>${quoted ? `<td class="num ${x.ev > 0 ? "pos" : "neg"}">${pct(x.ev, 1)}</td>` : ""}</tr>`).join("")
      }</tbody></table></div></div>
      <p class="foot-note">${verdict} Books shorten SGP prices because these legs move together. You make money only when the book's adjustment is smaller than the real correlation.</p>`;
  }
  return kpis + alerts + booksTable + sgp + contrib + matrix;
}

function americanToDecimal(a) {
  if (!a || Math.abs(a) < 100) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

function renderGenerator() {
  const g = state.gen;
  const sportChips = meta.sports.map((s) => `<button class="chip ${g.sports.includes(s.id) ? "on" : ""}" data-gen-sport="${s.id}">${s.title}</button>`).join("");
  const num = (k, label, step, ph = "") => `<label class="field">${label}<input type="number" step="${step}" data-gen="${k}" value="${esc(g[k])}" placeholder="${ph}"></label>`;
  const controls = `<div class="card"><div class="gen-controls">
    <label class="field">Sports<div class="chips">${sportChips}</div></label>
    <label class="field">Markets<div class="seg" data-gen-seg="kind">${[["all", "All"], ["main", "Main"], ["props", "Props"]].map(([k, l]) => `<button data-val="${k}" class="${g.kind === k ? "active" : ""}">${l}</button>`).join("")}</div></label>
    ${num("minLegs", "Min legs", 1)}${num("maxLegs", "Max legs", 1)}
    ${num("minOdds", "Min odds", 50, "+200")}${num("maxOdds", "Max odds", 100, "+2000")}
    ${num("minLegEv", "Min leg EV %", 0.5)}${num("boost", "Profit boost %", 5)}${num("maxReuse", "Max uses per leg", 1)}
    <label class="field">Rank by<div class="seg" data-gen-seg="sort"><button data-val="ev" class="${g.sort === "ev" ? "active" : ""}">EV</button><button data-val="growth" class="${g.sort === "growth" ? "active" : ""}">Growth</button></div></label>
    <button class="btn btn-primary" id="gen-run" ${genBusy ? "disabled" : ""}>${genBusy ? "Searching…" : "Generate"}</button>
  </div></div>
  <p class="foot-note">Searches the cached odds only, so it's free. Each parlay takes one leg per game, so the legs are independent and the book's price is exact. Ranking by EV favors long shots. Ranking by Growth favors parlays that grow your bankroll fastest at the suggested stake.</p>`;

  if (!genResults) return controls + emptyState("Ready when you are", "Choose your filters and press <b>Generate</b>. To find more parlays, lower Min leg EV a little or add a profit boost.");
  if (!genResults.length) return controls + emptyState("No +EV parlays found", "Try more sports, a wider odds range, a profit boost, or pull fresh odds first.");
  const rows = genResults.map((p, i) => `<tr>
    <td class="mono muted">${i + 1}</td>
    <td>${bookCell(p.book)}</td>
    <td><div class="leg-stack">${p.legs.map((l) => {
      const leg = { spec: l.spec, info: l, label: l.label };
      return `<div class="leg-line">${legIcon(leg, true)}<div><span class="lbl">${esc(l.is_prop ? `${l.player} ${l.outcome} ${l.point} ${l.market_title}` : l.label)}</span>${preTag(l)}
        <div class="meta">${esc(legSub(leg))} · <span class="${l.leg_ev > 0 ? "pos" : "neg"}">${pct(l.leg_ev, 1)}</span></div></div><span class="price">${odds(l.price)}</span></div>`;
    }).join("")}</div></td>
    <td class="num"><span class="price">${odds(p.boosted_decimal)}</span><span class="sub">fair ${odds(p.fair_decimal)}</span></td>
    <td class="num"><span class="ev-pill">${pct(p.ev, 2)}</span></td>
    <td class="num">${pct(p.win_prob, 1)}</td>
    <td class="num">${money(p.stake)}<span class="sub">to win ${money(p.to_win)}</span></td>
    <td class="num">${(p.growth * 1e4).toFixed(1)} bp</td>
    <td><button class="btn btn-sm btn-secondary" data-load="${i}">Load</button></td></tr>`).join("");
  if (isMobile()) return controls + `<div class="section-title"><h3>${genResults.length} +EV parlays</h3></div><div class="m-list">${genResults.map(genCard).join("")}</div>`;
  return controls + `<div class="section-title"><h3>${genResults.length} +EV parlays</h3><p>Click <b>Load</b> to open one in the slip and see its full breakdown</p></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>#</th><th>Book</th><th>Legs</th><th class="num">Odds</th><th class="num">EV</th><th class="num">Win %</th><th class="num">Stake</th><th class="num">Growth</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

async function runGenerator() {
  const g = state.gen;
  genBusy = true; renderContent();
  const n = (v) => (v === "" || v == null ? null : Number(v));
  try {
    const res = await post("/api/parlay/generate", {
      sports: g.sports, kind: g.kind, books: state.books ? state.books.join(",") : null, method: state.method,
      min_books: state.minBooks, min_legs: Number(g.minLegs), max_legs: Number(g.maxLegs),
      min_odds: n(g.minOdds), max_odds: n(g.maxOdds), min_leg_ev: Number(g.minLegEv) || 0, boost: Number(g.boost) || 0,
      sort: g.sort, kelly: state.kelly, bankroll: state.bankroll, max_stake_pct: state.maxStakePct, max_reuse: Number(g.maxReuse) || 3,
    });
    genResults = res.rows;
    await ensureMedia(g.sports);
  } catch (err) {
    toast(err.message, true);
  } finally {
    genBusy = false; renderContent();
  }
}

$("#content").addEventListener("click", (e) => {
  if (state.tab !== "parlays") return;
  const chip = e.target.closest("[data-gen-sport]");
  if (chip) {
    const s = chip.dataset.genSport, cur = state.gen.sports;
    state.gen.sports = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    if (!state.gen.sports.length) state.gen.sports = [s];
    saveSettings(); renderContent(); return;
  }
  const seg = e.target.closest("[data-gen-seg] button");
  if (seg) { state.gen[seg.parentElement.dataset.genSeg] = seg.dataset.val; saveSettings(); renderContent(); return; }
  if (e.target.id === "gen-run") { runGenerator(); return; }
  const ld = e.target.closest("[data-load]");
  if (ld) {
    const p = genResults[Number(ld.dataset.load)];
    slip.legs = p.legs.map((l) => ({ spec: l.spec, info: legInfo(l), label: legLabel(l.spec), book: p.book, price: l.price }));
    slip.corr = {}; slip.quote = null; slip.boost = Number(state.gen.boost) || 0; slip.book = p.book;
    afterSlipChange();
    state.parlayView = "slip"; saveSettings(); load();
    openSlip(true);
  }
});
$("#content").addEventListener("change", (e) => {
  const f = e.target.closest("[data-gen]");
  if (f) { state.gen[f.dataset.gen] = f.value; saveSettings(); }
});

// ============================================================================
// phone layout: cards instead of wide tables
// ============================================================================

const mq = matchMedia("(max-width: 760px)");
const isMobile = () => mq.matches;
mq.addEventListener?.("change", () => { if (lastData) renderContent(); renderSlip(); });

function matchupInline(r) {
  return `<span class="m-game">${teamLogo(r.away)}${teamLogo(r.home)}<span>${esc(teamShort(r.away))} @ ${esc(teamShort(r.home))}</span>${preTag(r)}<span class="muted">· ${kickoff(r.commence_time)}</span></span>`;
}

function evCard(r) {
  const source = r.fair_source === "consensus" ? `${r.fair_books} other books` : bookMeta(r.fair_source).title;
  const warn = r.warnings.length ? ` <span class="warn-icon" title="${esc(r.warnings.join("; "))}">⚠</span>` : "";
  return `<article class="m-card">
    <div class="m-top">${betCell(r)}<span class="ev-pill ${r.ev < 0.0005 ? "zero" : ""}">${pct(r.ev, 2)}</span></div>
    <div class="m-sub">${matchupInline(r)}</div>
    <div class="m-stats">
      <div><span>Odds</span><b class="price">${odds(r.price)}</b></div>
      <div><span>Open</span><b>${openCell(r)}</b></div>
      <div><span>Fair · ${pct(r.fair_prob, 0)}</span><b>${odds(r.fair_price)}</b></div>
      <div><span>Stake</span><b>${money(r.stake)}</b></div>
    </div>
    <div class="m-foot">${bookCell(r.book, r.link)}<span class="muted m-note">fair: ${esc(source)}${r.age_min != null ? ` · ${Math.max(0, Math.round(r.age_min))}m old` : ""}${warn}</span>
      ${addBtn({ sport: state.sport, event_id: r.event_id, market: r.market, outcome: r.outcome, point: r.point, description: r.player }, legInfo(r), r.book, r.price)}</div>
  </article>`;
}

function legsList(r, withStake) {
  return `<div class="m-legs">${r.legs.map((l) => `<div><span class="price">${odds(l.price)}</span><b>${esc(l.selection)}</b>${bookCell(l.book, l.link)}${withStake ? `<span class="muted">${money(l.stake)}</span>` : ""}</div>`).join("")}</div>`;
}

function middleCard(r) {
  return `<article class="m-card">
    <div class="m-top"><div><div class="m-big">${pct(r.breakeven)}</div><span class="sub">break-even hit rate</span></div>
      <div style="text-align:right"><span class="${r.miss_pct < 0 ? "neg" : "pos"} mono">${pct(r.miss_pct, 2)}</span><span class="sub">if it misses</span></div></div>
    <div class="m-sub">${matchupInline(r)} ${r.is_prop ? `<span class="tag prop">${esc(r.player)} · ${esc(r.market_title)}</span>` : `<span class="tag">${esc(r.market_title)}</span>`}</div>
    ${legsList(r, true)}
    <div class="m-hits">${r.hits.map((h) => `<div>${esc(h.text)} <span class="muted">${h.kind}</span> <span class="pos">+${money(h.profit)}</span></div>`).join("")}${r.key_number ? `<span class="tag key">key number</span>` : ""}</div>
  </article>`;
}

function lowHoldCard(r) {
  return `<article class="m-card">
    <div class="m-top"><div class="m-sub">${matchupInline(r)}</div><span class="price ${r.hold < 0 ? "pos" : ""}">${pct(r.hold, 2)}${r.hold < 0 ? ` <span class="tag arb">arb</span>` : ""}</span></div>
    <div class="m-sub">${r.is_prop ? `<span class="tag prop">${esc(r.player)} · ${esc(r.market_title)}</span>` : `<span class="tag">${esc(r.market_title)}</span>`} <span class="muted">${r.n_books} books</span></div>
    ${legsList(r, false)}
  </article>`;
}

function genCard(p, i) {
  return `<article class="m-card">
    <div class="m-top"><div>${bookCell(p.book)}<div class="m-big">${odds(p.boosted_decimal)}</div><span class="sub">fair ${odds(p.fair_decimal)} · ${pct(p.win_prob, 1)} to hit</span></div>
      <span class="ev-pill">${pct(p.ev, 2)}</span></div>
    <div class="leg-stack">${p.legs.map((l) => {
      const leg = { spec: l.spec, info: l, label: l.label };
      return `<div class="leg-line">${legIcon(leg, true)}<div><span class="lbl">${esc(l.is_prop ? `${l.player} ${l.outcome} ${l.point} ${l.market_title}` : l.label)}</span>${preTag(l)}
        <div class="meta">${esc(legSub(leg))}</div></div><span class="price">${odds(l.price)}</span></div>`;
    }).join("")}</div>
    <div class="m-foot"><span class="muted">Stake ${money(p.stake)} · to win ${money(p.to_win)} · ${(p.growth * 1e4).toFixed(1)} bp</span>
      <button class="btn btn-sm btn-secondary" data-load="${i}">Load</button></div>
  </article>`;
}

function bookPriceCard(b, r) {
  const isChosen = b.book === slip.book;
  const price = b.decimal ? `<span class="price">${odds(b.boosted_decimal ?? b.decimal)}</span>` : r.is_sgp && !b.missing.length ? `<span class="muted">needs SGP quote</span>` : `<span class="muted">–</span>`;
  return `<article class="m-card ${isChosen ? "chosen" : ""}">
    <div class="m-top">${bookCell(b.book, b.links?.[0])}${price}</div>
    ${b.ev != null ? `<div class="m-stats"><div><span>EV</span><b class="${b.ev > 0 ? "pos" : "neg"}">${pct(b.ev, 2)}</b></div><div><span>Win</span><b>${pct(b.win_prob)}</b></div>
      <div><span>Stake</span><b>${b.stake ? money(b.stake) : "–"}</b></div><div><span>BE boost</span><b>${b.min_boost > 0 ? pct(b.min_boost, 0) : "+EV"}</b></div></div>` : ""}
    ${b.missing.length ? `<div class="m-note">${b.missing.map((m) => `Missing ${esc(m.label)}${m.alt ? ` · has ${point(m.alt.point, m.spread)} ${odds(m.alt.price)}` : ""}`).join("<br>")}</div>` : ""}
    <div class="m-foot">${isChosen ? `<span class="tag prop">your book</span>` : `<button class="btn btn-sm btn-ghost" data-price-at="${b.book}">Price here</button>`}</div>
  </article>`;
}

// ============================================================================
// settings
// ============================================================================

const ALL_BOOKS = Object.keys(BOOK_TITLES);

function keyForm() {
  return `<label class="field stack">The Odds API key
      <div class="key-row"><input id="api-key" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        value="${esc(config.apiKey)}" placeholder="Paste your key"><button class="btn btn-ghost" data-action="toggle-key">Show</button></div></label>
    <div class="row-actions"><button class="btn btn-primary" data-action="save-key">Save key</button><button class="btn" data-action="test-key">Check credits</button></div>
    <p class="foot-note">Free keys (500 credits a month) at <a href="https://the-odds-api.com/" target="_blank" rel="noopener">the-odds-api.com</a>.
      The key is stored only on this device and sent only to The Odds API.</p>`;
}

function welcomeCard() {
  return `<div class="card welcome">
    <h2>Welcome to Odds Screen</h2>
    <p>Everything runs on this device: odds are pulled straight from The Odds API, and your history stays here. Add your API key to start.</p>
    ${keyForm()}
  </div>`;
}

function renderSettings() {
  const fetchBooks = withReference(config.books);
  const perRefresh = refreshCost(fetchBooks);
  const stats = store.stats();
  const seg = (attr, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button ${attr}="${v}" class="${cur === v ? "active" : ""}">${l}</button>`).join("")}</div>`;
  const books = ALL_BOOKS.map((b) => `<label class="check"><input type="checkbox" data-book="${b}" ${fetchBooks.includes(b) ? "checked" : ""} ${b === REFERENCE_BOOK ? "disabled" : ""}>
      <span class="book"><i style="background:${BOOK_COLORS[b] ?? "#888"}"></i>${esc(BOOK_TITLES[b])}</span>${b === REFERENCE_BOOK ? `<span class="muted">fair-price reference</span>` : ""}</label>`).join("");
  const built = mediaData?.built_at ? new Date(mediaData.built_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "unknown";
  return `<div class="settings">
    ${config.apiKey ? "" : `<div class="card welcome"><h2>Welcome to Odds Screen</h2><p>Everything runs on this device: odds come straight from The Odds API and your history stays here. Add your API key to start.</p></div>`}
    <section class="card set-card"><h3>Odds API</h3>${keyForm()}</section>
    <section class="card set-card" id="credits-card"><h3>Credits</h3>
      <p>${meta.usage ? `<b>${meta.usage.remaining}</b> left · ${meta.usage.used} used this period (as of ${new Date(meta.usage.at).toLocaleString()}).` : "Pull odds or tap Check credits to see your balance."}
        Free keys get 500 a month.</p>
      <div class="row-actions">
        <a class="btn btn-primary" href="https://the-odds-api.com/#get-access" target="_blank" rel="noopener">See plans ↗</a>
        <a class="btn" href="https://dash.the-odds-api.com/" target="_blank" rel="noopener">Upgrade in your account ↗</a>
      </div>
      <p class="foot-note">Paid plans: 20K credits for $30/mo, 100K for $59/mo. Your API key stays the same when you upgrade, and the new credits are available right away.</p></section>
    <section class="card set-card"><h3>Books to fetch</h3>
      <p class="foot-note">${fetchBooks.length} books selected. A main-lines refresh costs <b>${perRefresh} credits</b> per sport feed. Up to 10 books bill as one region; every extra 10 adds the same again.</p>
      <div class="book-grid">${books}</div></section>
    <section class="card set-card"><h3>Staking & pricing</h3><div class="set-grid">
      ${field("bankroll", "Bankroll", 100, "$")}${field("kelly", "Kelly ×", 0.05)}${field("maxStakePct", "Max parlay stake", 0.25, "%")}
      ${field("minBooks", "Consensus books", 1)}${methodSelect()}</div></section>
    <section class="card set-card"><h3>Display</h3><div class="set-grid">
      <label class="field">Odds ${seg("data-set-fmt", state.fmt, [["american", "American"], ["decimal", "Decimal"]])}</label>
      <label class="field">Theme ${seg("data-set-theme", document.documentElement.dataset.theme, [["dark", "Dark"], ["light", "Light"]])}</label></div></section>
    <section class="card set-card"><h3>Data on this device</h3>
      <p>${stats.fetches} snapshots · ${stats.prices.toLocaleString()} prices · ${stats.events} games. Snapshots older than ${HISTORY_DAYS} days are deleted automatically.</p>
      <div class="row-actions"><button class="btn" data-action="clear-history">Clear odds history</button></div>
      <p class="foot-note">Team logos and rosters come from an ESPN snapshot dated ${esc(built)}.</p></section>
    <section class="card set-card"><h3>App version</h3>
      <p>Updates normally load on their own. If something looks out of date, this clears the saved app files and reloads.
        Your API key, settings and odds history are kept.</p>
      <div class="row-actions"><a class="btn" href="reset.html">Update to latest version</a></div></section>
  </div>`;
}

async function reloadMeta() {
  meta = await api("/api/meta");
  renderHeader();
}

$("#content").addEventListener("click", async (e) => {
  if (state.tab !== "settings" && !e.target.closest(".welcome")) return;
  const a = e.target.closest("[data-action]");
  const fmt = e.target.closest("[data-set-fmt]");
  const theme = e.target.closest("[data-set-theme]");
  if (fmt) { set({ fmt: fmt.dataset.setFmt }, false); return; }
  if (theme) {
    document.documentElement.dataset.theme = theme.dataset.setTheme;
    try { localStorage.setItem("oddscreen-theme", theme.dataset.setTheme); } catch { /* ignore */ }
    renderContent();
    return;
  }
  if (!a) return;
  const input = $("#api-key");
  if (a.dataset.action === "toggle-key") {
    input.type = input.type === "password" ? "text" : "password";
    a.textContent = input.type === "password" ? "Show" : "Hide";
  } else if (a.dataset.action === "save-key") {
    config.apiKey = input.value.trim();
    saveConfig();
    await reloadMeta();
    toast(config.apiKey ? "Key saved on this device" : "Key removed");
    if (config.apiKey && !store.stats().fetches) { location.hash = "ev"; }
    else renderContent();
  } else if (a.dataset.action === "test-key") {
    const key = input.value.trim() || config.apiKey;
    try {
      const { usage } = await new OddsAPIClient(key).get("/sports"); // free endpoint
      if (usage.remaining != null) store.setUsage(usage);
      await reloadMeta();
      toast(`Key works · ${usage.remaining ?? "?"} credits left this month (checking was free)`);
    } catch (err) {
      toast(err.message, true);
    }
  } else if (a.dataset.action === "clear-history") {
    if (!confirm("Delete all saved odds snapshots on this device? Your settings and API key stay.")) return;
    store.clear();
    Object.keys(propData).forEach((k) => delete propData[k]);
    await reloadMeta();
    toast("Odds history cleared");
    renderContent();
  }
});

$("#content").addEventListener("change", async (e) => {
  if (state.tab !== "settings") return;
  const bk = e.target.closest("[data-book]");
  if (bk) {
    const chosen = new Set(config.books);
    if (bk.checked) chosen.add(bk.dataset.book); else chosen.delete(bk.dataset.book);
    config.books = ALL_BOOKS.filter((b) => chosen.has(b));
    saveConfig();
    state.books = null; // the toolbar's book filter refers to the old list
    saveSettings();
    await reloadMeta();
    renderContent();
    return;
  }
  const el = e.target.closest("[data-key]");
  if (el) {
    const key = el.dataset.key;
    set({ [key]: el.tagName === "SELECT" ? el.value : Number(el.value) }, false);
  }
});

// ---- line history modal ---------------------------------------------------------------

async function showHistory({ history: eventId, name, market, desc }) {
  const q = `/api/history?event_id=${encodeURIComponent(eventId)}&market=${encodeURIComponent(market)}${desc ? `&description=${encodeURIComponent(desc)}` : ""}`;
  const { rows } = await api(q);
  const spread = market === "spreads";
  const times = [...new Set(rows.map((r) => r.fetched_at))];
  const books = meta.books.filter((bk) => rows.some((r) => r.book === bk.key));
  const sides = [...new Set(rows.map((r) => r.outcome))];
  const title = market.startsWith("player_") ? `${name} · ${market.replace("player_", "").replaceAll("_", " ")}` : `${name} · ${meta.markets.find((m) => m.key === market)?.title}`;
  $("#modal-title").textContent = `${title} · line history`;
  $("#modal-body").onclick = null;
  $("#modal-body").onchange = null;
  $("#modal-body").innerHTML = sides.map((side) => {
    const head = `<tr><th>Snapshot</th>${bookHeaders(books)}</tr>`;
    const body = times.map((t) => `<tr><td>${new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>${books.map((bk) => {
      const r = rows.find((x) => x.fetched_at === t && x.book === bk.key && x.outcome === side);
      return `<td class="oc">${r ? `<span class="pt">${point(r.point, spread)}</span>${odds(r.price)}` : "–"}</td>`;
    }).join("")}</tr>`).join("");
    return `<h4>${esc(side)}</h4><div class="card"><div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
  }).join("") + (times.length < 2 ? `<p class="foot-note">Only one snapshot so far. Each refresh adds another.</p>` : "");
  $("#modal").showModal();
}
$("#modal-close").addEventListener("click", () => $("#modal").close());

// ============================================================================
// boot
// ============================================================================

async function init() {
  const t = location.hash.slice(1);
  if (TABS.includes(t)) state.tab = t;
  try {
    [store, mediaData] = await Promise.all([
      openBrowserStore(),
      fetch("data/media.json").then((r) => r.json()).catch(() => ({ sports: {} })),
    ]);
  } catch (e) {
    $("#content").innerHTML = emptyState("Storage unavailable", `This browser blocked local storage (${esc(e.message)}). Private browsing can cause this.`);
    return;
  }
  localApi = new LocalApi({ store, media: new Media(mediaData), settings: () => config });
  meta = await api("/api/meta");
  if (!config.apiKey && !location.hash) state.tab = "settings";
  await loadMedia();
  await ensureMedia(slip.legs.map((l) => l.spec.sport));
  renderSlip();
  await load();
  if (slip.legs.length) schedulePrice();
}
init();
