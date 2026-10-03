from datetime import datetime

import pytest

from app.hours import PARIS, is_informative, open_now


def _at(day: int, hhmm: str) -> datetime:
    """Lundi 2026-09-14 = jour 1 ... dimanche 2026-09-20 = jour 7."""
    hour, minute = hhmm.split(":")
    return datetime(2026, 9, 13 + day, int(hour), int(minute), tzinfo=PARIS)


def _day(day: int, *slots: tuple[str, str], closed: bool = False) -> dict:
    return {"day": day, "closed": closed, "slots": [list(slot) for slot in slots]}


WEEK = [_day(day, ("07:00", "21:00")) for day in range(1, 8)]


@pytest.mark.parametrize("moment, expected", [
    ("06:59", False),
    ("07:00", True),
    ("20:59", True),
    ("21:00", False),
])
def test_open_now_simple_slot(moment, expected):
    assert open_now(WEEK, _at(3, moment)) is expected


def test_open_now_unknown_when_hours_are_not_usable():
    # Cas très fréquent dans le flux : tous les jours fermés, créneaux 01:00–01:00.
    useless = [_day(day, ("01:00", "01:00"), closed=True) for day in range(1, 8)]
    assert open_now(useless, _at(3, "10:00")) is None
    assert open_now(None, _at(3, "10:00")) is None
    assert open_now([], _at(3, "10:00")) is None
    assert is_informative(useless) is False
    assert is_informative(WEEK) is True


def test_open_now_overnight_slot():
    hours = [_day(day, ("22:00", "06:00")) for day in range(1, 8)]
    assert open_now(hours, _at(3, "23:30")) is True
    assert open_now(hours, _at(3, "02:00")) is True  # créneau ouvert la veille
    assert open_now(hours, _at(3, "12:00")) is False
    assert open_now([_day(1, ("22:00", "06:00"))], _at(2, "02:00")) is True  # lundi soir -> mardi matin


def test_open_now_closed_day_and_missing_day():
    hours = [_day(1, ("07:00", "21:00")), _day(2, closed=True)]
    assert open_now(hours, _at(2, "10:00")) is False  # mardi déclaré fermé
    assert open_now(hours, _at(4, "10:00")) is None  # jeudi non déclaré
