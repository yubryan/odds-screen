from oddscreen.fair import fair_for_line
from oddscreen.models import Price
from oddscreen.odds_math import devig


def line(**books):
    """books: name -> (over_price, under_price)"""
    return {b: {"Over": Price("e", b, "totals", "Over", o, 45.5), "Under": Price("e", b, "totals", "Under", u, 45.5)}
            for b, (o, u) in books.items()}


def test_books_sharing_a_feed_count_once():
    books = line(ballybet=(2.10, 1.75), betparx=(2.10, 1.75), draftkings=(1.91, 1.91), fanduel=(1.95, 1.87))
    fair = fair_for_line(books, method="multiplicative", reference="pinnacle", min_books=3)
    expect = sum(devig(d, "multiplicative")[0] for d in ([2.10, 1.75], [1.91, 1.91], [1.95, 1.87])) / 3  # [Over, Under]
    assert fair.n_books == 3
    assert abs(fair.probs["Over"] - expect) < 1e-12


def test_a_book_is_left_out_of_its_own_consensus():
    books = line(draftkings=(2.30, 1.60), fanduel=(1.91, 1.91), betmgm=(1.93, 1.89), espnbet=(1.90, 1.92))
    with_dk = fair_for_line(books, method="power", reference="pinnacle", min_books=3)
    without = fair_for_line(books, method="power", reference="pinnacle", min_books=3, exclude="draftkings")
    assert with_dk.n_books == 4 and without.n_books == 3
    # DK's generous Over price implies a low Over probability; leaving DK out stops it dragging the
    # fair probability toward its own price (which hid part of DK's edge)
    assert without.probs["Over"] > with_dk.probs["Over"]
    # excluding a book also drops its feed-mates
    books.update(line(ballybet=(1.95, 1.87), betparx=(1.95, 1.87)))
    assert fair_for_line(books, method="power", reference="pinnacle", min_books=3, exclude="betparx").n_books == 4
    # not enough independent sources once the book is out
    small = line(draftkings=(1.91, 1.91), fanduel=(1.95, 1.87), betmgm=(1.93, 1.89))
    assert fair_for_line(small, method="power", reference="pinnacle", min_books=3, exclude="fanduel") is None


def test_pinnacle_line_ignores_exclusion():
    books = line(pinnacle=(1.95, 1.95), draftkings=(2.05, 1.80))
    fair = fair_for_line(books, method="power", reference="pinnacle", exclude="draftkings")
    assert fair.source == "pinnacle" and abs(fair.probs["Over"] - 0.5) < 1e-12


def test_fair_modes():
    import pytest
    books = line(pinnacle=(1.95, 1.95), draftkings=(2.05, 1.80), fanduel=(1.91, 1.91), betmgm=(1.93, 1.89), espnbet=(1.90, 1.92))
    auto = fair_for_line(books, method="multiplicative", reference="pinnacle", exclude="draftkings")
    assert auto.source == "pinnacle"
    cons = fair_for_line(books, method="multiplicative", reference="pinnacle", exclude="draftkings", mode="consensus")
    assert cons.source == "consensus" and cons.n_books == 4  # Pinnacle votes; DK is out
    expect = sum(devig(d, "multiplicative")[0] for d in ([1.95, 1.95], [1.91, 1.91], [1.93, 1.89], [1.90, 1.92])) / 4
    assert abs(cons.probs["Over"] - expect) < 1e-12
    no_pin = line(draftkings=(2.05, 1.80), fanduel=(1.91, 1.91), betmgm=(1.93, 1.89), espnbet=(1.90, 1.92))
    assert fair_for_line(no_pin, method="power", reference="pinnacle", mode="pinnacle") is None
    assert fair_for_line(no_pin, method="power", reference="pinnacle", mode="auto").source == "consensus"
    with pytest.raises(ValueError):
        fair_for_line(books, method="power", reference="pinnacle", mode="nope")
