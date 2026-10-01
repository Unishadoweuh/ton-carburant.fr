"""Application FastAPI : API REST, planificateur d'import et fichiers statiques."""

import asyncio
import logging
import os
import sqlite3
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import db, search
from .areas import find_areas, normalize, resolve_area
from .config import Settings, load_settings
from .fuels import FUEL_CODES, FUEL_LABELS, normalize_fuel
from .geocode import Geocoder
from .ingest import run_ingest

log = logging.getLogger("toncarburant")
STATIC_DIR = Path(__file__).parent / "static"


def _age_seconds(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(iso)).total_seconds()
    except ValueError:
        return None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    interval_s = settings.ingest_interval_minutes * 60

    async def scheduler() -> None:
        conn = db.connect(settings.db_path)
        try:
            age = _age_seconds(db.get_meta(conn).get("last_success_at"))
        finally:
            conn.close()
        if age is not None and age < interval_s:
            log.info("Données récentes (%d s), prochain import dans %d s", age, interval_s - age)
            await asyncio.sleep(interval_s - age)
        while True:
            await asyncio.to_thread(run_ingest, settings)
            await asyncio.sleep(interval_s)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(
            level=os.getenv("LOG_LEVEL", "INFO").upper(),
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
        # Sinon chaque recherche des visiteurs (adresse tapée) finit dans les logs.
        logging.getLogger("httpx").setLevel(logging.WARNING)
        conn = db.connect(settings.db_path)
        db.init_db(conn)
        conn.close()
        app.state.geocoder = Geocoder(settings.geocoder_urls)
        task = asyncio.create_task(scheduler()) if settings.ingest_enabled else None
        try:
            yield
        finally:
            if task:
                task.cancel()
            app.state.geocoder.close()

    app = FastAPI(title="Ton-Carburant", docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json", lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "public, max-age=60")
        return response

    def get_conn() -> Iterator[sqlite3.Connection]:
        conn = db.connect(settings.db_path)
        try:
            yield conn
        finally:
            conn.close()

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict:
        return {"ok": True}

    @app.get("/api/config")
    def config() -> dict:
        return {
            "default_radius_km": settings.default_radius_km,
            "max_radius_km": settings.max_radius_km,
            "radius_options_km": settings.radius_options_km,
            "fuels": [{"code": code, "label": FUEL_LABELS[code]} for code in FUEL_CODES],
            "tile_url": settings.tile_url,
            "tile_attribution": settings.tile_attribution,
            "tile_max_zoom": settings.tile_max_zoom,
        }

    @app.get("/api/status")
    def status(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        meta = db.get_meta(conn)
        last_success = meta.get("last_success_at") or None
        age = _age_seconds(last_success)
        return {
            "stations": conn.execute("SELECT COUNT(*) FROM stations").fetchone()[0],
            "data_updated_at": meta.get("data_updated_at") or None,
            "last_success_at": last_success,
            "last_attempt_at": meta.get("last_attempt_at") or None,
            "last_error": meta.get("last_error") or None,
            "stale": age is None or age > max(3 * interval_s, 45 * 60),
            "interval_minutes": settings.ingest_interval_minutes,
        }

    @app.get("/api/geocode")
    def geocode(request: Request, q: str = Query(..., min_length=1, max_length=200)) -> dict:
        areas = find_areas(q)
        places = request.app.state.geocoder.search(q)
        if places is None and not areas:
            raise HTTPException(503, "Service de géocodage momentanément indisponible")
        places = places or []
        # "Paris" : la commune passe avant le département homonyme.
        same_city = bool(places) and places[0]["type"] == "municipality" and normalize(places[0]["label"]) == normalize(q)
        if areas and areas[0]["exact"] and not same_city:
            results = areas + places
        else:
            results = places + areas
        return {"results": results[:8]}

    @app.get("/api/stations")
    def stations(
        fuel: str = "Gazole",
        lat: float | None = Query(None, ge=-90, le=90),
        lon: float | None = Query(None, ge=-180, le=180),
        radius_km: float | None = Query(None, gt=0),
        area: str | None = Query(None, max_length=64, description="dept:35 ou region:bretagne"),
        conn: sqlite3.Connection = Depends(get_conn),
    ) -> dict:
        code = normalize_fuel(fuel)
        if not code:
            raise HTTPException(400, f"Carburant inconnu : {fuel}")
        if area:
            resolved = resolve_area(area)
            if not resolved:
                raise HTTPException(404, f"Zone inconnue : {area}")
            result = search.search_stations(conn, code, departements=resolved["departements"])
            result["area"] = {"key": resolved["key"], "label": resolved["label"]}
            return result
        if lat is None or lon is None:
            raise HTTPException(400, "Paramètres lat et lon, ou area, requis")
        radius = min(radius_km or settings.default_radius_km, settings.max_radius_km)
        result = search.search_stations(conn, code, lat=lat, lon=lon, radius_km=radius)
        result["radius_km"] = radius
        result["center"] = {"lat": lat, "lon": lon}
        return result

    @app.get("/api/stations/{station_id}")
    def station(station_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        found = search.get_station(conn, station_id)
        if not found:
            raise HTTPException(404, "Station introuvable")
        return found

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
