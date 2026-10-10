"""Odds conversions, de-vig methods, EV and Kelly. All prices are decimal."""
from __future__ import annotations

from typing import Callable, Sequence


def american_to_decimal(american: float) -> float:
    if american >= 100:
        return 1 + american / 100
    if american <= -100:
        return 1 + 100 / -american
    raise ValueError(f"invalid American odds: {american}")


def decimal_to_american(decimal: float) -> float:
    if decimal <= 1:
        raise ValueError(f"invalid decimal odds: {decimal}")
    return (decimal - 1) * 100 if decimal >= 2 else -100 / (decimal - 1)


def overround(decimals: Sequence[float]) -> float:
    """Book hold expressed as total implied probability minus 1."""
    return sum(1 / d for d in decimals) - 1


def devig_multiplicative(decimals: Sequence[float]) -> list[float]:
    implied = [1 / d for d in decimals]
    total = sum(implied)
    return [p / total for p in implied]


def devig_additive(decimals: Sequence[float]) -> list[float]:
    implied = [1 / d for d in decimals]
    excess = (sum(implied) - 1) / len(implied)
    probs = [max(p - excess, 1e-6) for p in implied]
    total = sum(probs)
    return [p / total for p in probs]


def devig_power(decimals: Sequence[float]) -> list[float]:
    """Find k with sum(p_i ** k) == 1. Shades longshots more than favorites."""
    implied = [1 / d for d in decimals]
    lo, hi = 0.01, 20.0  # sum(p**k) is decreasing in k
    for _ in range(200):
        k = (lo + hi) / 2
        if sum(p**k for p in implied) > 1:
            lo = k
        else:
            hi = k
    k = (lo + hi) / 2
    probs = [p**k for p in implied]
    total = sum(probs)
    return [p / total for p in probs]


def devig_worst_case(decimals: Sequence[float]) -> list[float]:
    """Per outcome, the lowest fair probability any method assigns (most conservative EV)."""
    per_method = [f(decimals) for f in (devig_multiplicative, devig_additive, devig_power)]
    return [min(col) for col in zip(*per_method)]


DEVIG_METHODS: dict[str, Callable[[Sequence[float]], list[float]]] = {
    "multiplicative": devig_multiplicative,
    "additive": devig_additive,
    "power": devig_power,
    "worst_case": devig_worst_case,
}


def devig(decimals: Sequence[float], method: str = "power") -> list[float]:
    try:
        return DEVIG_METHODS[method](decimals)
    except KeyError:
        raise ValueError(f"unknown devig method {method!r}; choose from {sorted(DEVIG_METHODS)}") from None


def expected_value(prob: float, decimal: float) -> float:
    """EV per unit staked."""
    return prob * decimal - 1


def kelly_fraction(prob: float, decimal: float) -> float:
    """Full-Kelly bankroll fraction, floored at 0."""
    b = decimal - 1
    return max((prob * b - (1 - prob)) / b, 0.0)
