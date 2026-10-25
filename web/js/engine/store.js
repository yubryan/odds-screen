// Odds history: every fetch is appended as a snapshot. Port of oddscreen/store.py.
//
// Main lines are fetched per sport (kind 'main'); props per event (kind 'props',
// event_id set). The "current" view of a sport is its latest main fetch plus the
// latest props fetch of every event.
//
// Everything lives in memory (fast, synchronous queries, same semantics as the
// SQLite version); an optional persistence adapter (IndexedDB in the browser)
// mirrors every write so the history survives app restarts.

import { parseTime } from "./models.js";

const isQuote = (d) => Number.isFinite(d) && d > 1;

export const HISTORY_DAYS = 14;

/** (event, book, market, outcome, description) */
export const priceKey = (p) => JSON.stringify([p.event_id, p.book, p.market, p.outcome, p.description ?? ""]);

export class Store {
  constructor(persist = null) {
    this.persist = persist;
    this.fetches = []; // ascending id
    this.events = new Map(); // id -> event row, insertion order
    this.pricesByFetch = new Map(); // fetch id -> price rows, insertion order
    this.kvs = new Map();
    this.nextId = 1;
  }

  /** Load raw rows (from IndexedDB or a test fixture): {fetches, events, prices, kv}. */
  load({ fetches = [], events = [], prices = [], kv = [] }) {
    this.fetches = [...fetches].sort((a, b) => a.id - b.id);
    this.nextId = this.fetches.length ? this.fetches[this.fetches.length - 1].id + 1 : 1;
    for (const e of events) this.events.set(e.id, { ...e });
    for (const p of prices) {
      if (!this.pricesByFetch.has(p.fetch_id)) this.pricesByFetch.set(p.fetch_id, []);
      this.pricesByFetch.get(p.fetch_id).push(p);
    }
    for (const [k, v] of kv) this.kvs.set(k, v);
    return this;
  }

  // ---- writes -------------------------------------------------------------

  saveFetch(sport, payload, { markets, books, usage = {}, fetchedAt = new Date(), kind = "main", eventId = null }) {
    const fetch = {
      id: this.nextId++, sport, fetched_at: fetchedAt.toISOString(), markets: markets.join(","), books: books.join(","),
      n_events: payload.length, credits_last: usage.last ?? null, credits_remaining: usage.remaining ?? null,
      credits_used: usage.used ?? null, kind, event_id: eventId,
    };
    this.fetches.push(fetch);
    const rows = [];
    const touched = [];
    for (const ev of payload) {
      const cur = this.events.get(ev.id);
      const row = {
        id: ev.id, sport: cur ? cur.sport : sport, commence_time: ev.commence_time, home: ev.home_team, away: ev.away_team,
        league: ev.sport_key ?? cur?.league ?? null,
      };
      this.events.set(ev.id, row); // Map.set on an existing key keeps its position, like an SQL upsert
      touched.push(row);
      for (const bm of ev.bookmakers ?? []) {
        for (const mk of bm.markets ?? []) {
          const updated = mk.last_update ?? bm.last_update ?? null;
          for (const o of mk.outcomes ?? []) {
            if (!isQuote(o.price)) continue; // a suspended/placeholder price (1.0 or less) isn't a bettable quote
            rows.push({
              fetch_id: fetch.id, event_id: ev.id, book: bm.key, market: mk.key, outcome: o.name,
              description: o.description ?? null, point: o.point ?? null, price: o.price, last_update: updated,
              link: o.link ?? mk.link ?? bm.link ?? null,
            });
          }
        }
      }
    }
    this.pricesByFetch.set(fetch.id, rows);
    this.persist?.saveFetch(fetch, touched, rows);
    if (usage.remaining != null) this.setUsage(usage);
    return fetch.id;
  }

  setUsage(usage) {
    this.setKv("usage", { ...usage, at: new Date().toISOString() });
  }

  setKv(key, value) {
    this.kvs.set(key, value);
    this.persist?.setKv(key, value);
  }

  /** Drop snapshots older than `days`, then events no snapshot references. */
  prune(days = HISTORY_DAYS, now = new Date()) {
    const cutoff = now.getTime() - days * 86400e3;
    const drop = this.fetches.filter((f) => parseTime(f.fetched_at).getTime() < cutoff).map((f) => f.id);
    if (!drop.length) return 0;
    const dropSet = new Set(drop);
    this.fetches = this.fetches.filter((f) => !dropSet.has(f.id));
    for (const id of drop) this.pricesByFetch.delete(id);
    const live = new Set();
    for (const rows of this.pricesByFetch.values()) for (const p of rows) live.add(p.event_id);
    const goneEvents = [...this.events.keys()].filter((id) => !live.has(id));
    for (const id of goneEvents) this.events.delete(id);
    this.persist?.deleteFetches(drop, goneEvents);
    return drop.length;
  }

  /** Delete every snapshot (keeps settings and the credit balance). */
  clear() {
    this.fetches = [];
    this.events = new Map();
    this.pricesByFetch = new Map();
    this.persist?.clear();
  }

  // ---- reads --------------------------------------------------------------

  kv(key) { return this.kvs.get(key) ?? null; }
  usage() { return this.kv("usage"); }

  /** Latest main-lines fetch. */
  latestFetch(sport) {
    for (let i = this.fetches.length - 1; i >= 0; i--) {
      const f = this.fetches[i];
      if (f.sport === sport && f.kind === "main") return f;
    }
    return null;
  }

  /** What makes up the current view (offset 0) or the one before it (offset 1):
   * for each main market, the Nth-latest main fetch that pulled it (so a
   * spreads-only pull doesn't hide the moneylines and totals from the last
   * full pull), plus the Nth-latest props fetch per event.
   * Returns Map<fetchId, Set<market> | null (= every row)>. */
  snapshotSelection(sport, offset = 0) {
    const seen = new Map();
    const out = new Map();
    for (let i = this.fetches.length - 1; i >= 0; i--) {
      const f = this.fetches[i];
      if (f.sport !== sport) continue;
      const scopes = f.kind === "main" ? f.markets.split(",").filter(Boolean).map((m) => ["main", m]) : [[f.kind, f.event_id ?? ""]];
      for (const [kind, sub] of scopes) {
        const scope = `${kind}\u0000${sub}`;
        const n = seen.get(scope) ?? 0;
        if (n === offset) {
          if (kind !== "main") out.set(f.id, null);
          else {
            if (!out.has(f.id)) out.set(f.id, new Set());
            out.get(f.id).add(sub);
          }
        }
        seen.set(scope, n + 1);
      }
    }
    return out;
  }

  snapshotFetchIds(sport, offset = 0) {
    return [...this.snapshotSelection(sport, offset).keys()];
  }

  /** event_id -> time of its latest props fetch. */
  propsFetched(sport) {
    const out = new Map();
    for (const f of this.fetches) {
      if (f.sport === sport && f.kind === "props" && (!out.has(f.event_id) || f.fetched_at > out.get(f.event_id))) {
        out.set(f.event_id, f.fetched_at);
      }
    }
    return out;
  }

  /** Price objects for a selection (fetch ids, or Map<id, Set<market>|null>), in
   * insertion order, with the fetch time attached. */
  pricesFor(selection) {
    const sel = selection instanceof Map ? selection : new Map([...selection].map((id) => [id, null]));
    const ids = [...sel.keys()].sort((a, b) => a - b);
    const byId = new Map(this.fetches.map((f) => [f.id, f]));
    const out = [];
    for (const id of ids) {
      const at = byId.get(id)?.fetched_at ?? null;
      const markets = sel.get(id);
      for (const r of this.pricesByFetch.get(id) ?? []) {
        // isQuote also screens out bad prices saved before ingestion filtered them
        if ((!markets || markets.has(r.market)) && isQuote(r.price)) out.push({ ...r, fetched_at: at });
      }
    }
    return out;
  }

  eventsFor(ids) {
    const want = new Set(ids);
    const out = new Map();
    for (const [id, r] of this.events) {
      if (want.has(id)) out.set(id, { ...r, commence_time: parseTime(r.commence_time) });
    }
    return out;
  }

  /** Current view of a sport: {fetch (latest main), events Map, prices}. */
  snapshot(sport) {
    const prices = this.pricesFor(this.snapshotSelection(sport));
    const events = this.eventsFor(new Set(prices.map((p) => p.event_id)));
    return { fetch: this.latestFetch(sport), events, prices };
  }

  /** Prices from the snapshot before the current one (for movement arrows). */
  previousPrices(sport) {
    const out = new Map();
    for (const p of this.pricesFor(this.snapshotSelection(sport, 1))) out.set(priceKey(p), p);
    return out;
  }

  /** First price we ever recorded for each (event, book, market, outcome, player). */
  openingPrices(eventIds, markets = null) {
    const evs = new Set(eventIds);
    const mks = markets ? new Set(markets) : null;
    const out = new Map();
    for (const f of this.fetches) {
      for (const r of this.pricesByFetch.get(f.id) ?? []) {
        if (!evs.has(r.event_id) || (mks && !mks.has(r.market))) continue;
        const k = priceKey(r);
        if (!out.has(k)) out.set(k, { ...r, fetched_at: f.fetched_at });
      }
    }
    return out;
  }

  history(eventId, market, description = null) {
    const rows = [];
    for (const f of this.fetches) {
      for (const r of this.pricesByFetch.get(f.id) ?? []) {
        if (r.event_id !== eventId || r.market !== market || (description && r.description !== description)) continue;
        rows.push({ fetched_at: f.fetched_at, book: r.book, outcome: r.outcome, description: r.description, point: r.point, price: r.price, _f: f.id });
      }
    }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort((a, b) => a._f - b._f || cmp(a.book, b.book) || cmp(a.outcome, b.outcome));
    return rows.map(({ _f, ...r }) => r);
  }

  /** Rough size of what's stored, for the Settings screen. */
  stats() {
    let prices = 0;
    for (const rows of this.pricesByFetch.values()) prices += rows.length;
    return { fetches: this.fetches.length, events: this.events.size, prices };
  }
}

// ---- IndexedDB persistence (browser only) ------------------------------------------

const DB_NAME = "oddscreen";

function idb(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

/** Persistence adapter: writes are queued so callers never wait on disk. */
export class IdbPersist {
  static async open() {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("fetches", { keyPath: "id" });
      db.createObjectStore("events", { keyPath: "id" });
      db.createObjectStore("prices", { keyPath: "fetch_id" }); // one record per fetch: {fetch_id, rows}
      db.createObjectStore("kv");
    };
    const p = new IdbPersist();
    p.db = await idb(open);
    p.queue = Promise.resolve();
    return p;
  }

  async loadAll() {
    const tx = this.db.transaction(["fetches", "events", "prices", "kv"]);
    const [fetches, events, priceRecs, kvKeys, kvVals] = await Promise.all([
      idb(tx.objectStore("fetches").getAll()), idb(tx.objectStore("events").getAll()),
      idb(tx.objectStore("prices").getAll()), idb(tx.objectStore("kv").getAllKeys()), idb(tx.objectStore("kv").getAll()),
    ]);
    events.sort((a, b) => a.seq - b.seq); // keep first-seen order, like SQLite rowids
    priceRecs.sort((a, b) => a.fetch_id - b.fetch_id);
    return {
      fetches, events: events.map(({ seq, ...e }) => e), prices: priceRecs.flatMap((r) => r.rows),
      kv: kvKeys.map((k, i) => [k, kvVals[i]]), maxSeq: events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0),
    };
  }

  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => console.error("IndexedDB write failed", e));
    return this.queue;
  }

  saveFetch(fetch, events, rows) {
    return this.enqueue(async () => {
      const tx = this.db.transaction(["fetches", "events", "prices"], "readwrite");
      tx.objectStore("fetches").put(fetch);
      const evStore = tx.objectStore("events");
      for (const e of events) {
        const existing = await idb(evStore.get(e.id));
        evStore.put({ ...e, seq: existing?.seq ?? ++this.seq });
      }
      tx.objectStore("prices").put({ fetch_id: fetch.id, rows });
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    });
  }

  setKv(key, value) {
    return this.enqueue(async () => {
      const tx = this.db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      await new Promise((res) => { tx.oncomplete = res; });
    });
  }

  deleteFetches(ids, eventIds) {
    return this.enqueue(async () => {
      const tx = this.db.transaction(["fetches", "events", "prices"], "readwrite");
      for (const id of ids) { tx.objectStore("fetches").delete(id); tx.objectStore("prices").delete(id); }
      for (const id of eventIds) tx.objectStore("events").delete(id);
      await new Promise((res) => { tx.oncomplete = res; });
    });
  }

  clear() {
    return this.enqueue(async () => {
      const tx = this.db.transaction(["fetches", "events", "prices", "kv"], "readwrite");
      for (const s of ["fetches", "events", "prices"]) tx.objectStore(s).clear();
      await new Promise((res) => { tx.oncomplete = res; });
    });
  }

  flush() { return this.queue; }
}

/** Open the browser store: load history from IndexedDB, prune to 14 days. */
export async function openBrowserStore() {
  const persist = await IdbPersist.open();
  const data = await persist.loadAll();
  persist.seq = data.maxSeq;
  const store = new Store(persist).load(data);
  store.prune();
  return store;
}
