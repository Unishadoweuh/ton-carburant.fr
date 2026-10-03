"""Téléchargement et import du flux instantané v2 des prix des carburants.

Format constaté (septembre 2026) : archive ZIP contenant un XML ISO-8859-1.

    <pdv id="..." latitude="4811090" longitude="-168365" cp="35000" pop="R|A">
      <adresse/> <ville/>
      <horaires automate-24-24="1|"> <jour id="1" nom="Lundi" ferme="1|">
        <horaire ouverture="07.00" fermeture="21.00"/> </jour> </horaires>
      <services> <service>…</service> </services>
      <prix nom="Gazole" id="1" maj="2026-09-14 12:06:54" valeur="2.345"/>
      <rupture nom="E85" id="3" debut="…" fin="" type="temporaire|definitive"/>
    </pdv>

Les coordonnées sont en degrés × 100 000 (parfois décimales), les prix en euros
(anciennement en millièmes d'euro : les deux formats sont acceptés).
Un carburant est soit dans <prix>, soit dans <rupture> ; une rupture sans date
de fin est en cours. Les stations peu actives ne déclarent pas tous leurs
carburants : l'absence d'un carburant n'est donc pas une rupture.

Usage manuel : python -m app.ingest [--file flux.zip]
"""

import argparse
import io
import json
import logging
import re
import sqlite3
import zipfile
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

import httpx

from . import brands, db
from .config import Settings, load_settings
from .fuels import normalize_fuel

log = logging.getLogger(__name__)

PARIS = ZoneInfo("Europe/Paris")
USER_AGENT = "Ton-Carburant/1.0 (+https://toncarburant.fr)"


class FeedError(Exception):
    """Flux illisible ou incomplet."""


def fetch_feed(url: str, timeout: float) -> bytes:
    with httpx.Client(timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.content


def extract_xml(payload: bytes) -> bytes:
    if payload[:4] == b"PK\x03\x04":
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                names = [n for n in archive.namelist() if n.lower().endswith(".xml")]
                if not names:
                    raise FeedError("archive ZIP sans fichier XML")
                return archive.read(names[0])
        except zipfile.BadZipFile as exc:
            raise FeedError(f"archive ZIP invalide : {exc}") from exc
    if payload.lstrip()[:1] == b"<":
        return payload
    raise FeedError("format de flux inattendu (ni ZIP ni XML)")


def _paris_iso(value: str | None) -> str | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value.strip(), fmt).replace(tzinfo=PARIS).isoformat()
        except ValueError:
            continue
    return None


def _price(value: str | None) -> float | None:
    try:
        price = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if price > 100:  # ancien format en millièmes d'euro
        price /= 1000
    return round(price, 3) if 0 < price < 10 else None


def _hhmm(value: str | None) -> str | None:
    match = re.fullmatch(r"(\d{1,2})[.:h](\d{2})", (value or "").strip())
    return f"{int(match.group(1)):02d}:{match.group(2)}" if match else None


_LOWERCASE_WORDS = {"de", "du", "des", "la", "le", "les", "sur", "sous", "en", "et", "au", "aux", "l", "d", "lès", "lez"}


def pretty_city(raw: str) -> str:
    """"SAINT-JEAN-D'ILLAC" -> "Saint-Jean-d'Illac"."""
    parts = re.split(r"([\s\-']+)", (raw or "").strip().lower())
    out, first = [], True
    for part in parts:
        if not part or re.fullmatch(r"[\s\-']+", part):
            out.append(part)
            continue
        out.append(part if not first and part in _LOWERCASE_WORDS else part[:1].upper() + part[1:])
        first = False
    return "".join(out)


def _pretty_address(raw: str) -> str:
    """Adresses saisies tout en majuscules -> casse normale ; les autres sont gardées telles quelles."""
    return pretty_city(raw) if raw.isupper() else raw


def _text(element: ET.Element | None) -> str:
    return " ".join((element.text or "").split()) if element is not None else ""


def parse_station(pdv: ET.Element) -> dict | None:
    try:
        station_id = int(pdv.get("id", ""))
        lat = float(pdv.get("latitude", ""))
        lon = float(pdv.get("longitude", ""))
    except ValueError:
        return None
    if abs(lat) > 90:  # degrés × 100 000
        lat, lon = lat / 100_000, lon / 100_000
    if (lat == 0 and lon == 0) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None

    prices: dict[str, dict] = {}
    for node in pdv.iter("prix"):
        fuel, price = normalize_fuel(node.get("nom")), _price(node.get("valeur"))
        if fuel and price is not None:
            prices[fuel] = {"price": price, "updated_at": _paris_iso(node.get("maj"))}

    ruptures: dict[str, dict] = {}
    for node in pdv.iter("rupture"):
        fuel = normalize_fuel(node.get("nom"))
        if not fuel or node.get("fin"):  # une date de fin = rupture terminée
            continue
        kind = "temporaire" if node.get("type") == "temporaire" else "definitive"
        if kind == "definitive" and fuel in prices:  # un prix déclaré prime
            continue
        ruptures[fuel] = {"kind": kind, "since": _paris_iso(node.get("debut"))}

    hours, automate = None, False
    horaires = pdv.find("horaires")
    if horaires is not None:
        automate = horaires.get("automate-24-24") == "1"
        days = []
        for jour in horaires.findall("jour"):
            slots = [[_hhmm(h.get("ouverture")), _hhmm(h.get("fermeture"))] for h in jour.findall("horaire")]
            days.append({
                "day": int(jour.get("id") or 0),
                "closed": jour.get("ferme") == "1",
                "slots": [slot for slot in slots if all(slot)],
            })
        hours = sorted(days, key=lambda d: d["day"]) or None

    return {
        "id": station_id,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "cp": (pdv.get("cp") or "").strip(),
        "city": pretty_city(_text(pdv.find("ville"))),
        "address": _pretty_address(_text(pdv.find("adresse"))),
        "pop": pdv.get("pop"),
        "automate_24_24": automate,
        "hours": hours,
        "services": [_text(s) for s in pdv.iter("service") if _text(s)],
        "prices": prices,
        "ruptures": ruptures,
    }


def parse_feed(xml_bytes: bytes) -> list[dict]:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise FeedError(f"XML invalide : {exc}") from exc
    return [s for s in (parse_station(pdv) for pdv in root.iter("pdv")) if s is not None]


def _brands_cache_path(settings: Settings) -> Path:
    return Path(settings.db_path).with_name("brands_cache.json")


def load_brand_map(settings: Settings, fetch: Callable[[], bytes] | None = None) -> dict[int, str]:
    """Charge l'association id -> enseigne. Ne lève jamais : en cas d'échec,
    retombe sur le dernier référentiel récupéré avec succès (en cache sur disque)."""
    if not settings.brands_url:
        return {}
    fetch = fetch or (lambda: brands.fetch_brands_payload(settings.brands_url, settings.http_timeout_s))
    cache_path = _brands_cache_path(settings)
    try:
        brand_map = brands.parse_brands(fetch())
        try:
            cache_path.write_text(json.dumps(brand_map, ensure_ascii=False), encoding="utf-8")
        except OSError:
            log.warning("Impossible d'écrire le cache des enseignes")
        return brand_map
    except Exception:
        log.warning("Référentiel des enseignes indisponible, repli sur le cache", exc_info=True)
        try:
            return {int(k): v for k, v in json.loads(cache_path.read_text(encoding="utf-8")).items()}
        except (OSError, ValueError):
            return {}


def store_stations(conn: sqlite3.Connection, stations: list[dict]) -> None:
    """Remplace toutes les données en une transaction : les lecteurs (WAL)
    continuent de voir l'ancienne version jusqu'au commit."""
    rtree = db.has_rtree(conn)
    with conn:
        for table in ("prices", "ruptures", "stations") + (("station_rtree",) if rtree else ()):
            conn.execute(f"DELETE FROM {table}")
        conn.executemany(
            "INSERT OR REPLACE INTO stations (id, lat, lon, cp, city, address, pop, brand, automate_24_24, hours_json, services_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (s["id"], s["lat"], s["lon"], s["cp"], s["city"], s["address"], s["pop"], s.get("brand"), int(s["automate_24_24"]),
                 json.dumps(s["hours"], ensure_ascii=False) if s["hours"] else None,
                 json.dumps(s["services"], ensure_ascii=False))
                for s in stations
            ],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO prices (station_id, fuel, price, updated_at) VALUES (?, ?, ?, ?)",
            [(s["id"], fuel, p["price"], p["updated_at"]) for s in stations for fuel, p in s["prices"].items()],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO ruptures (station_id, fuel, kind, since) VALUES (?, ?, ?, ?)",
            [(s["id"], fuel, r["kind"], r["since"]) for s in stations for fuel, r in s["ruptures"].items()],
        )
        if rtree:
            conn.executemany(
                "INSERT OR REPLACE INTO station_rtree (id, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?)",
                [(s["id"], s["lat"], s["lat"], s["lon"], s["lon"]) for s in stations],
            )


def _latest_price_date(stations: list[dict]) -> str | None:
    horizon = datetime.now(timezone.utc) + timedelta(days=1)  # ignore les dates aberrantes
    dates = [
        datetime.fromisoformat(p["updated_at"])
        for s in stations for p in s["prices"].values() if p["updated_at"]
    ]
    valid = [d for d in dates if d <= horizon]
    return max(valid).isoformat() if valid else None


def run_ingest(
    settings: Settings,
    fetch: Callable[[], bytes] | None = None,
    fetch_brands: Callable[[], bytes] | None = None,
) -> dict:
    """Importe le flux. Ne lève jamais : en cas d'échec, les données
    précédentes sont conservées et l'erreur est enregistrée dans `meta`."""
    fetch = fetch or (lambda: fetch_feed(settings.feed_url, settings.http_timeout_s))
    conn = db.connect(settings.db_path)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        db.init_db(conn)
        stations = parse_feed(extract_xml(fetch()))
        if len(stations) < settings.ingest_min_stations:
            raise FeedError(f"flux incomplet : {len(stations)} stations (minimum attendu {settings.ingest_min_stations})")
        brand_map = load_brand_map(settings, fetch_brands)
        for station in stations:
            station["brand"] = brand_map.get(station["id"])
        store_stations(conn, stations)
        db.set_meta(
            conn,
            last_attempt_at=now,
            last_success_at=now,
            last_error="",
            data_updated_at=_latest_price_date(stations) or "",
            station_count=str(len(stations)),
        )
        log.info("Import réussi : %d stations", len(stations))
        return {"ok": True, "stations": len(stations)}
    except Exception as exc:  # le planificateur ne doit jamais s'arrêter
        log.exception("Import du flux échoué, conservation des données précédentes")
        try:
            db.set_meta(conn, last_attempt_at=now, last_error=str(exc)[:500])
        except sqlite3.Error:
            log.exception("Impossible d'enregistrer l'erreur d'import")
        return {"ok": False, "error": str(exc)}
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Importe le flux des prix des carburants dans SQLite.")
    parser.add_argument("--file", type=Path, help="fichier ZIP/XML local au lieu du téléchargement")
    parser.add_argument("--min-stations", type=int, help="nombre minimal de stations attendu")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    settings = load_settings()
    if args.min_stations is not None:
        settings = replace(settings, ingest_min_stations=args.min_stations)
    fetch = args.file.read_bytes if args.file else None
    result = run_ingest(settings, fetch=fetch)
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
