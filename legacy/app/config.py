"""Configuration, entièrement pilotée par variables d'environnement."""

import os
from dataclasses import dataclass


def _str(name: str, default: str) -> str:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value and value.strip() else default


def _float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value and value.strip() else default


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "oui"}


def _list(name: str, default: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in _str(name, default).split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    db_path: str
    feed_url: str
    brands_url: str
    ingest_enabled: bool
    ingest_interval_minutes: int
    ingest_min_stations: int
    http_timeout_s: float
    default_radius_km: float
    max_radius_km: float
    radius_options_km: tuple[float, ...]
    geocoder_urls: tuple[str, ...]
    tile_url: str
    tile_attribution: str
    tile_max_zoom: int


def load_settings() -> Settings:
    max_radius = _float("MAX_RADIUS_KM", 50)
    default_radius = min(_float("DEFAULT_RADIUS_KM", 10), max_radius)
    options = sorted(
        {float(x) for x in _list("RADIUS_OPTIONS_KM", "5,10,15,20,30,50") if 0 < float(x) <= max_radius}
        | {default_radius}
    )
    return Settings(
        db_path=_str("DB_PATH", "./data/carburants.db"),
        feed_url=_str("FEED_URL", "https://donnees.roulez-eco.fr/opendata/instantane_ruptures"),
        brands_url=_str(
            "BRANDS_URL",
            "https://www.data.gouv.fr/api/1/datasets/r/0207ded0-2d19-47af-b1a6-62915ec1b721",
        ),
        ingest_enabled=_bool("INGEST_ENABLED", True),
        ingest_interval_minutes=max(5, _int("INGEST_INTERVAL_MINUTES", 10)),
        ingest_min_stations=_int("INGEST_MIN_STATIONS", 1000),
        http_timeout_s=_float("HTTP_TIMEOUT_S", 60),
        default_radius_km=default_radius,
        max_radius_km=max_radius,
        radius_options_km=tuple(options),
        geocoder_urls=_list(
            "GEOCODER_URLS",
            "https://data.geopf.fr/geocodage/search,https://api-adresse.data.gouv.fr/search/",
        ),
        tile_url=_str("TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
        tile_attribution=_str(
            "TILE_ATTRIBUTION",
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        ),
        tile_max_zoom=_int("TILE_MAX_ZOOM", 19),
    )
