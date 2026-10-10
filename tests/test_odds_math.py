import pytest

from oddscreen.odds_math import (
    american_to_decimal, decimal_to_american, devig, expected_value, kelly_fraction, overround,
)


@pytest.mark.parametrize("american,decimal", [(100, 2.0), (150, 2.5), (-110, 1 + 100 / 110), (-200, 1.5)])
def test_conversions_round_trip(american, decimal):
    assert american_to_decimal(american) == pytest.approx(decimal)
    assert decimal_to_american(decimal) == pytest.approx(american)


@pytest.mark.parametrize("method", ["multiplicative", "additive", "power"])
def test_devig_sums_to_one(method):
    probs = devig([1.4, 3.1], method)
    assert sum(probs) == pytest.approx(1)
    assert probs[0] > probs[1]


def test_even_market_devigs_to_half():
    for method in ("multiplicative", "additive", "power", "worst_case"):
        assert devig([1.91, 1.91], method) == pytest.approx([0.5, 0.5])


def test_power_shades_longshot_more_than_multiplicative():
    mult = devig([1.25, 4.5], "multiplicative")
    power = devig([1.25, 4.5], "power")
    assert power[1] < mult[1]


def test_worst_case_is_minimum_of_methods():
    decimals = [1.25, 4.5]
    worst = devig(decimals, "worst_case")
    for m in ("multiplicative", "additive", "power"):
        assert all(w <= p + 1e-12 for w, p in zip(worst, devig(decimals, m)))


def test_ev_and_kelly():
    assert overround([1.91, 1.91]) == pytest.approx(2 / 1.91 - 1)
    assert expected_value(0.5, 2.1) == pytest.approx(0.05)
    assert kelly_fraction(0.5, 2.1) == pytest.approx(0.05 / 1.1)
    assert kelly_fraction(0.4, 2.0) == 0.0


def test_unknown_method():
    with pytest.raises(ValueError):
        devig([2, 2], "nope")
