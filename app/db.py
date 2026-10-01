"""Stockage SQLite : stations, prix, ruptures et index spatial R*Tree."""

import logging
import sqlite3
from pathlib import Path

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    cp TEXT NOT NULL,
    city TEXT NOT NULL,
    address TEXT NOT NULL,
    pop TEXT,
    brand TEXT,
    automate_24_24 INTEGER NOT NULL DEFAULT 0,
    hours_json TEXT,
    services_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_stations_cp ON stations(cp);
CREATE INDEX IF NOT EXISTS idx_stations_lat_lon ON stations(lat, lon);

CREATE TABLE IF NOT EXISTS prices (
    station_id INTEGER NOT NULL,
    fuel TEXT NOT NULL,
    price REAL NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (station_id, fuel)
);
CREATE INDEX IF NOT EXISTS idx_prices_fuel_price ON prices(fuel, price);

CREATE TABLE IF NOT EXISTS ruptures (
    station_id INTEGER NOT NULL,
    fuel TEXT NOT NULL,
    kind TEXT NOT NULL,
    since TEXT,
    PRIMARY KEY (station_id, fuel)
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False : FastAPI peut ouvrir la connexion et l'utiliser
    # dans deux threads différents du pool (une connexion par requête).
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS station_rtree "
            "USING rtree(id, min_lat, max_lat, min_lon, max_lon)"
        )
    except sqlite3.OperationalError:
        log.warning("SQLite compilé sans R*Tree : repli sur l'index B-tree (lat, lon)")
    try:  # migration pour les bases créées avant l'ajout de la colonne
        conn.execute("ALTER TABLE stations ADD COLUMN brand TEXT")
    except sqlite3.OperationalError:
        pass
    conn.commit()


def has_rtree(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'station_rtree'").fetchone()
    return row is not None


def get_meta(conn: sqlite3.Connection) -> dict[str, str]:
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}


def set_meta(conn: sqlite3.Connection, **values: str) -> None:
    with conn:
        conn.executemany(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [(key, value) for key, value in values.items()],
        )
