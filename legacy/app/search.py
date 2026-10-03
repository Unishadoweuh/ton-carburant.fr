"""Recherche de stations : rayon autour d'un point ou zone administrative."""

import json
import math
import sqlite3
import statistics
from datetime import datetime

from . import db
from .areas import cp_ranges
from .fuels import FUEL_CODES, FUEL_LABELS
from .hours import PARIS, open_now

EARTH_RADIUS_KM = 6371.0088
KM_PER_DEGREE = 111.195


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _within_radius(conn: sqlite3.Connection, lat: float, lon: float, radius_km: float) -> list[tuple[sqlite3.Row, float]]:
    # 1) boîte englobante via l'index spatial, 2) distance exacte sur les seuls candidats
    dlat = radius_km / KM_PER_DEGREE
    dlon = radius_km / (KM_PER_DEGREE * max(math.cos(math.radians(lat)), 0.01))
    if db.has_rtree(conn):
        sql = (
            "SELECT s.* FROM station_rtree t JOIN stations s ON s.id = t.id "
            "WHERE t.min_lat <= ? AND t.max_lat >= ? AND t.min_lon <= ? AND t.max_lon >= ?"
        )
        params = (lat + dlat, lat - dlat, lon + dlon, lon - dlon)
    else:
        sql = "SELECT * FROM stations WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"
        params = (lat - dlat, lat + dlat, lon - dlon, lon + dlon)
    candidates = []
    for row in conn.execute(sql, params):
        distance = haversine_km(lat, lon, row["lat"], row["lon"])
        if distance <= radius_km:
            candidates.append((row, distance))
    return candidates


def _in_departements(conn: sqlite3.Connection, departements: list[str]) -> list[tuple[sqlite3.Row, None]]:
    ranges = [r for code in departements for r in cp_ranges(code)]
    if not ranges:
        return []
    where = " OR ".join("(cp >= ? AND cp < ?)" for _ in ranges)
    params = [bound for r in ranges for bound in r]
    return [(row, None) for row in conn.execute(f"SELECT * FROM stations WHERE {where}", params)]


def _fuel_data(conn: sqlite3.Connection, ids: list[int]) -> tuple[dict, dict]:
    prices: dict[int, dict] = {}
    ruptures: dict[int, dict] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for row in conn.execute(f"SELECT station_id, fuel, price, updated_at FROM prices WHERE station_id IN ({marks})", chunk):
            prices.setdefault(row["station_id"], {})[row["fuel"]] = {"price": row["price"], "updated_at": row["updated_at"]}
        for row in conn.execute(f"SELECT station_id, fuel, kind, since FROM ruptures WHERE station_id IN ({marks})", chunk):
            ruptures.setdefault(row["station_id"], {})[row["fuel"]] = {"kind": row["kind"], "since": row["since"]}
    return prices, ruptures


def _station_base(row: sqlite3.Row, now: datetime) -> dict:
    return {
        "id": row["id"],
        "lat": row["lat"],
        "lon": row["lon"],
        "address": row["address"],
        "city": row["city"],
        "cp": row["cp"],
        "brand": row["brand"],
        "highway": row["pop"] == "A",
        "automate_24_24": bool(row["automate_24_24"]),
        "open_now": open_now(json.loads(row["hours_json"]) if row["hours_json"] else None, now),
    }


def search_stations(
    conn: sqlite3.Connection,
    fuel: str,
    *,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float | None = None,
    departements: list[str] | None = None,
) -> dict:
    if departements is not None:
        candidates = _in_departements(conn, departements)
    elif lat is not None and lon is not None and radius_km:
        candidates = _within_radius(conn, lat, lon, radius_km)
    else:
        raise ValueError("indiquer une position et un rayon, ou des départements")

    prices, ruptures = _fuel_data(conn, [row["id"] for row, _ in candidates])
    now = datetime.now(PARIS)
    available, out_of_stock, absent = [], [], 0
    for row, distance in candidates:
        station_prices = prices.get(row["id"], {})
        station_ruptures = ruptures.get(row["id"], {})
        item = {
            **_station_base(row, now),
            "distance_km": round(distance, 2) if distance is not None else None,
            "prices": {code: p["price"] for code, p in station_prices.items()},
            "status": "ok",
            "price": None,
            "price_updated_at": None,
        }
        rupture = station_ruptures.get(fuel)
        if rupture and rupture["kind"] == "temporaire":
            item["status"] = "rupture"
            item["rupture_since"] = rupture["since"]
            out_of_stock.append(item)
        elif fuel in station_prices:
            item["price"] = station_prices[fuel]["price"]
            item["price_updated_at"] = station_prices[fuel]["updated_at"]
            available.append(item)
        else:  # carburant non distribué ou non déclaré
            absent += 1

    available.sort(key=lambda s: (s["price"], s["distance_km"] or 0))
    out_of_stock.sort(key=lambda s: s["distance_km"] or 0)
    values = [s["price"] for s in available]
    stats = (
        {"min": min(values), "max": max(values), "median": round(statistics.median(values), 3)}
        if values else None
    )
    return {
        "fuel": fuel,
        "count": len(available),
        "rupture_count": len(out_of_stock),
        "absent_count": absent,
        "stats": stats,
        "stations": available + out_of_stock,
    }


def get_station(conn: sqlite3.Connection, station_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM stations WHERE id = ?", (station_id,)).fetchone()
    if row is None:
        return None
    prices, ruptures = _fuel_data(conn, [station_id])
    prices, ruptures = prices.get(station_id, {}), ruptures.get(station_id, {})

    fuels = []
    for code in FUEL_CODES:
        price, rupture = prices.get(code), ruptures.get(code)
        if rupture and rupture["kind"] == "temporaire":
            status = "rupture"
        elif price:
            status = "ok"
        elif rupture:
            status = "non_distribue"
        else:
            continue
        fuels.append({
            "code": code,
            "label": FUEL_LABELS[code],
            "status": status,
            "price": price["price"] if price else None,
            "updated_at": price["updated_at"] if price else None,
            "rupture_since": rupture["since"] if rupture else None,
        })

    return {
        **_station_base(row, datetime.now(PARIS)),
        "hours": json.loads(row["hours_json"]) if row["hours_json"] else None,
        "services": json.loads(row["services_json"] or "[]"),
        "fuels": fuels,
    }
