"""Thin client for The Odds API v4. Only /odds and /events/{id}/odds cost credits."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

BASE_URL = "https://api.the-odds-api.com/v4"


class OddsAPIError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class Usage:
    remaining: int | None
    used: int | None
    last: int | None

    @classmethod
    def from_headers(cls, headers: httpx.Headers) -> "Usage":
        def num(name: str) -> int | None:
            value = headers.get(name)
            return int(float(value)) if value is not None else None

        return cls(num("x-requests-remaining"), num("x-requests-used"), num("x-requests-last"))


class OddsAPIClient:
    def __init__(self, api_key: str, http: httpx.Client | None = None):
        if not api_key:
            raise OddsAPIError("ODDS_API_KEY is not set (put it in .env)")
        self.api_key = api_key
        self.http = http or httpx.Client(base_url=BASE_URL, timeout=20)

    def _get(self, path: str, **params: Any) -> tuple[Any, Usage]:
        params = {k: v for k, v in params.items() if v is not None}
        resp = self.http.get(path, params={"apiKey": self.api_key, **params})
        usage = Usage.from_headers(resp.headers)
        if resp.status_code != 200:
            try:
                detail = resp.json().get("message", resp.text)
            except ValueError:
                detail = resp.text
            raise OddsAPIError(f"{path}: HTTP {resp.status_code}: {detail}", resp.status_code)
        return resp.json(), usage

    def events(self, sport_key: str) -> list[dict]:
        """Upcoming/live events. Free -- does not touch the quota."""
        data, _ = self._get(f"/sports/{sport_key}/events")
        return data

    def odds(self, sport_key: str, markets: list[str], bookmakers: list[str]) -> tuple[list[dict], Usage]:
        """Bulk odds for every event in a sport. Costs markets x ceil(books/10)."""
        return self._get(
            f"/sports/{sport_key}/odds",
            markets=",".join(markets),
            bookmakers=",".join(bookmakers),
            oddsFormat="decimal",
            dateFormat="iso",
            includeLinks="true",
        )

    def event_odds(
        self, sport_key: str, event_id: str, markets: list[str], bookmakers: list[str]
    ) -> tuple[dict, Usage]:
        """Single-event odds -- the only route to player props. Costs
        (#markets returned) x ceil(books/10) per event, so props are expensive."""
        return self._get(
            f"/sports/{sport_key}/events/{event_id}/odds",
            markets=",".join(markets),
            bookmakers=",".join(bookmakers),
            oddsFormat="decimal",
            dateFormat="iso",
            includeLinks="true",
        )
