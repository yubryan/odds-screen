// Thin client for The Odds API v4, called straight from the browser (the API
// allows any origin and exposes its credit headers). Port of oddscreen/odds_api.py.
// Only /odds and /events/{id}/odds cost credits.

export const BASE_URL = "https://api.the-odds-api.com/v4";

export class OddsAPIError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

function usageFrom(headers) {
  const num = (name) => {
    const v = headers.get(name);
    return v == null ? null : Math.trunc(Number(v));
  };
  return { remaining: num("x-requests-remaining"), used: num("x-requests-used"), last: num("x-requests-last") };
}

export class OddsAPIClient {
  constructor(apiKey, fetchImpl = (...a) => fetch(...a)) {
    if (!apiKey) throw new OddsAPIError("Add your Odds API key in Settings");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async get(path, params = {}) {
    const url = new URL(BASE_URL + path);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    let resp;
    try {
      resp = await this.fetch(url.toString());
    } catch (e) {
      throw new OddsAPIError(`Network error reaching The Odds API (${e.message}). Check your connection.`);
    }
    const usage = usageFrom(resp.headers);
    if (resp.status !== 200) {
      let detail = await resp.text();
      try { detail = JSON.parse(detail).message ?? detail; } catch { /* plain text */ }
      throw new OddsAPIError(`${path}: HTTP ${resp.status}: ${detail}`, resp.status);
    }
    return { data: await resp.json(), usage };
  }

  /** Upcoming/live events. Free -- does not touch the quota. */
  async events(sportKey) {
    return (await this.get(`/sports/${sportKey}/events`)).data;
  }

  /** Bulk odds for every event in a sport. Costs markets x ceil(books/10). */
  odds(sportKey, markets, bookmakers) {
    return this.get(`/sports/${sportKey}/odds`, {
      markets: markets.join(","), bookmakers: bookmakers.join(","), oddsFormat: "decimal", dateFormat: "iso", includeLinks: "true",
    });
  }

  /** Single-event odds -- the only route to player props. Costs
   * (#markets returned) x ceil(books/10) per event. */
  eventOdds(sportKey, eventId, markets, bookmakers) {
    return this.get(`/sports/${sportKey}/events/${eventId}/odds`, {
      markets: markets.join(","), bookmakers: bookmakers.join(","), oddsFormat: "decimal", dateFormat: "iso", includeLinks: "true",
    });
  }
}
