import dataclasses
import io
import zipfile

import pytest

from app import db
from app.ingest import FeedError, _pretty_address, extract_xml, parse_feed, pretty_city, run_ingest

from .conftest import SAMPLE_XML

SAMPLE_BRANDS_CSV = (
    b"id_station_officiel,nom_normalise,adresse,ville,code_postal,latitude_osm,longitude_osm,source_enrichissement\n"
    b"35000001,Carrefour Market,1 Rue de Chatillon,Rennes,35000,48.11,-1.68,OpenStreetMap\n"
)


def _by_id(stations):
    return {s["id"]: s for s in stations}


def test_parse_coordinates_prices_and_ruptures():
    stations = _by_id(parse_feed(SAMPLE_XML))
    assert set(stations) == {35000001, 35000002, 35510001, 35300001, 20000001}  # sans coordonnées ignorée

    rennes = stations[35000001]
    assert (rennes["lat"], rennes["lon"]) == (48.1109, -1.68365)
    assert rennes["address"] == "1 Rue de Châtillon"
    assert rennes["prices"]["Gazole"] == {"price": 1.899, "updated_at": "2026-09-14T12:06:54+02:00"}
    assert rennes["ruptures"] == {"GPLc": {"kind": "definitive", "since": "2021-06-22T09:19:16+02:00"}}
    assert rennes["automate_24_24"] is True
    assert [d["day"] for d in rennes["hours"]] == [1, 2]
    assert rennes["hours"][0]["slots"] == [["07:00", "21:00"]]
    assert rennes["services"] == ["Lavage automatique", "Boutique alimentaire"]

    lorient = stations[35000002]
    assert (lorient["lat"], lorient["lon"]) == (48.12, -1.7)  # coordonnées déjà décimales
    assert lorient["prices"]["Gazole"]["price"] == 1.859  # ancien format en millièmes
    assert set(lorient["ruptures"]) == {"E10"}  # la rupture SP98 terminée est ignorée
    assert lorient["hours"] is None


def test_pretty_city():
    assert pretty_city("CESSON-SÉVIGNÉ") == "Cesson-Sévigné"
    assert pretty_city("SAINT-JEAN-D'ILLAC") == "Saint-Jean-d'Illac"
    assert pretty_city("LE BARP") == "Le Barp"
    assert _pretty_address("100-102 ROUTE DE SAINT-BRIEUC") == "100-102 Route de Saint-Brieuc"
    assert _pretty_address("ZA de la Rigourdière") == "ZA de la Rigourdière"


def test_extract_xml_from_zip():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("PrixCarburants_instantane_ruptures.xml", SAMPLE_XML)
    assert extract_xml(buffer.getvalue()) == SAMPLE_XML
    assert extract_xml(SAMPLE_XML) == SAMPLE_XML
    with pytest.raises(FeedError):
        extract_xml(b"not a feed")


def test_ingest_failure_keeps_previous_data(loaded_settings):
    def broken():
        raise OSError("flux indisponible")

    assert run_ingest(loaded_settings, fetch=broken)["ok"] is False
    assert run_ingest(loaded_settings, fetch=lambda: b"PK\x03\x04corrompu")["ok"] is False

    conn = db.connect(loaded_settings.db_path)
    assert conn.execute("SELECT COUNT(*) FROM stations").fetchone()[0] == 5
    meta = db.get_meta(conn)
    assert "ZIP" in meta["last_error"]
    assert meta["last_success_at"] and meta["data_updated_at"] == "2026-09-15T08:00:00+02:00"


def test_ingest_rejects_truncated_feed(loaded_settings):
    import dataclasses

    strict = dataclasses.replace(loaded_settings, ingest_min_stations=1000)
    result = run_ingest(strict, fetch=lambda: SAMPLE_XML)
    assert result["ok"] is False and "incomplet" in result["error"]
    conn = db.connect(strict.db_path)
    assert conn.execute("SELECT COUNT(*) FROM stations").fetchone()[0] == 5


def test_ingest_replaces_data(loaded_settings):
    smaller = SAMPLE_XML.split(b'<pdv id="35000002"')[0] + b"</pdv_liste>"
    assert run_ingest(loaded_settings, fetch=lambda: smaller) == {"ok": True, "stations": 1}
    conn = db.connect(loaded_settings.db_path)
    assert conn.execute("SELECT COUNT(*) FROM station_rtree").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM prices").fetchone()[0] == 2


def test_ingest_enriches_stations_with_brand(settings):
    with_brands = dataclasses.replace(settings, brands_url="https://brands.test/referentiel.csv")
    result = run_ingest(with_brands, fetch=lambda: SAMPLE_XML, fetch_brands=lambda: SAMPLE_BRANDS_CSV)
    assert result == {"ok": True, "stations": 5}

    conn = db.connect(with_brands.db_path)
    rows = {row["id"]: row["brand"] for row in conn.execute("SELECT id, brand FROM stations")}
    assert rows[35000001] == "Carrefour Market"
    assert rows[35000002] is None  # pas d'enseigne connue pour cette station


def test_ingest_falls_back_to_brand_cache_on_failure(settings):
    with_brands = dataclasses.replace(settings, brands_url="https://brands.test/referentiel.csv")
    run_ingest(with_brands, fetch=lambda: SAMPLE_XML, fetch_brands=lambda: SAMPLE_BRANDS_CSV)

    def broken():
        raise OSError("référentiel indisponible")

    result = run_ingest(with_brands, fetch=lambda: SAMPLE_XML, fetch_brands=broken)
    assert result == {"ok": True, "stations": 5}
    conn = db.connect(with_brands.db_path)
    brand = conn.execute("SELECT brand FROM stations WHERE id = 35000001").fetchone()[0]
    assert brand == "Carrefour Market"
