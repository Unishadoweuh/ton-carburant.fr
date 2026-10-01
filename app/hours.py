"""Interprétation des horaires déclarés.

Les horaires du flux sont souvent approximatifs : beaucoup de stations déclarent
sept jours fermés, ou des créneaux « 01.00 – 01.00 » qui ne veulent rien dire.
On ne conclut donc que lorsque les créneaux sont exploitables, sinon on renvoie
None (« on ne sait pas ») plutôt que d'afficher une information fausse.
"""

from datetime import datetime, time
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")


def _parse(value: str | None) -> time | None:
    try:
        hour, minute = str(value).split(":")
        return time(int(hour), int(minute))
    except (ValueError, AttributeError):
        return None


def usable_slots(day: dict) -> list[tuple[time, time]]:
    slots = []
    for opening, closing in day.get("slots") or []:
        start, end = _parse(opening), _parse(closing)
        if start is None or end is None or start == end:
            continue
        slots.append((start, end))
    return slots


def is_informative(hours: list[dict] | None) -> bool:
    return bool(hours) and any(usable_slots(day) for day in hours)


def open_now(hours: list[dict] | None, now: datetime) -> bool | None:
    """True / False, ou None si les horaires ne permettent pas de conclure."""
    if not is_informative(hours):
        return None
    by_day = {day.get("day"): day for day in hours}
    today, current = now.isoweekday(), now.time()

    day = by_day.get(today)
    for start, end in usable_slots(day) if day else []:
        if start <= end:
            if start <= current < end:
                return True
        elif current >= start or current < end:  # créneau à cheval sur minuit
            return True

    yesterday = by_day.get(today - 1 or 7)
    for start, end in usable_slots(yesterday) if yesterday else []:
        if start > end and current < end:  # créneau de la veille qui déborde
            return True

    return False if day else None
