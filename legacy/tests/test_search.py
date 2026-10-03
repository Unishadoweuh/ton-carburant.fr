import httpx
import pytest
from fastapi.testclient import TestClient

from app import db, search
from app.areas import cp_ranges, find_areas, resolve_area
from app.geocode import Geocoder
from app.main import create_app

RENNES = {"lat": 48.1109, "lon": -1.68365}


@pytest.fixture
def conn(loaded_settings):
    connection = db.connect(loaded_settings.db_path)
    yield connection
    connection.close()


def test_radius_search_sorted_by_price(conn):
    result = search.search_stations(conn, "Gazole", radius_km=10, **RENNES)
    assert [s["id"] for s in result["stations"]] == [35000002, 35000001, 35510001]  # Fougères hors rayon
    assert result["stations"][0]["distance_km"] < 2
    assert result["stats"] == {"min": 1.859, "max": 1.949, "median": 1.899}


def test_rupture_listed_last_and_absent_counted(conn):
    e10 = search.search_stations(conn, "E10", radius_km=10, **RENNES)
    assert [(s["id"], s["status"]) for s in e10["stations"]] == [
        (35510001, "ok"), (35000001, "ok"), (35000002, "rupture"),
    ]
    assert e10["rupture_count"] == 1 and e10["absent_count"] == 0

    gpl = search.search_stations(conn, "GPLc", radius_km=10, **RENNES)
    assert gpl["count"] == 0 and gpl["absent_count"] == 3 and gpl["stats"] is None


def test_area_search(conn):
    assert search.search_stations(conn, "Gazole", departements=["35"])["count"] == 4
    corse = resolve_area("region:corse")
    assert search.search_stations(conn, "SP98", departements=corse["departements"])["count"] == 1


def test_station_detail(conn):
    station = search.get_station(conn, 35000001)
    assert [(f["code"], f["status"]) for f in station["fuels"]] == [
        ("Gazole", "ok"), ("E10", "ok"), ("GPLc", "non_distribue"),
    ]
    assert station["automate_24_24"] is True and station["city"] == "Rennes"
    assert search.get_station(conn, 1) is None


def test_areas():
    assert cp_ranges("35") == [("35", "36")]
    assert cp_ranges("2B") == [("202", "203"), ("206", "207")]
    assert cp_ranges("09") == [("09", "0:")]
    assert find_areas("35")[0]["area"] == "dept:35"
    assert find_areas("bretagne")[0] == {
        "label": "Bretagne", "context": "Région entière · 4 départements",
        "type": "region", "area": "region:bretagne", "exact": True,
    }
    assert find_areas("ille et vilaine")[0]["area"] == "dept:35"
    assert find_areas("Côtes d'Armor")[0]["area"] == "dept:22"
    assert find_areas("ile de france")[0]["area"] == "region:ile-de-france"
    assert resolve_area("region:inconnue") is None


def _geocoder_transport(request: httpx.Request) -> httpx.Response:
    if request.url.host == "down.test":
        return httpx.Response(502)
    return httpx.Response(200, json={"features": [{
        "geometry": {"type": "Point", "coordinates": [-1.68365, 48.110899]},
        "properties": {"label": "Rennes", "type": "municipality", "postcode": "35000", "context": "35, Ille-et-Vilaine, Bretagne"},
    }]})


def test_geocoder_fallback_and_cache():
    calls = []

    def transport(request):
        calls.append(request.url.host)
        return _geocoder_transport(request)

    geocoder = Geocoder(("https://down.test/search", "https://up.test/search"), transport=httpx.MockTransport(transport))
    result = geocoder.search("rennes")
    assert result == [{"label": "Rennes", "context": "35000 · 35, Ille-et-Vilaine, Bretagne", "type": "municipality", "lat": 48.110899, "lon": -1.68365}]
    assert geocoder.search("Rennes") == result
    assert calls == ["down.test", "up.test"]  # 2e appel servi par le cache
    assert geocoder.search("35") == []


def test_api(loaded_settings):
    with TestClient(create_app(loaded_settings)) as client:
        client.app.state.geocoder = Geocoder(("https://up.test/search",), transport=httpx.MockTransport(_geocoder_transport))

        stations = client.get("/api/stations", params={"fuel": "gazole", "radius_km": 10, **RENNES}).json()
        assert stations["count"] == 3 and stations["radius_km"] == 10 and stations["fuel"] == "Gazole"

        capped = client.get("/api/stations", params={"radius_km": 500, **RENNES}).json()
        assert capped["radius_km"] == loaded_settings.max_radius_km

        area = client.get("/api/stations", params={"area": "dept:35"}).json()
        assert area["count"] == 4 and area["area"]["label"] == "Ille-et-Vilaine (35)"

        assert client.get("/api/stations", params={"fuel": "kerosene", **RENNES}).status_code == 400
        assert client.get("/api/stations").status_code == 400
        assert client.get("/api/stations", params={"area": "dept:99"}).status_code == 404
        assert client.get("/api/stations/35000001").json()["address"] == "1 Rue de Châtillon"
        assert client.get("/api/stations/42").status_code == 404

        status = client.get("/api/status").json()
        assert status["stations"] == 5 and status["stale"] is False and status["last_error"] is None

        geocode = client.get("/api/geocode", params={"q": "Bretagne"}).json()["results"]
        assert geocode[0]["area"] == "region:bretagne"
        rennes = client.get("/api/geocode", params={"q": "Rennes"}).json()["results"]
        assert rennes[0]["type"] == "municipality"

        config = client.get("/api/config").json()
        assert config["default_radius_km"] in config["radius_options_km"]
        home = client.get("/")
        assert home.status_code == 200 and "Ton-Carburant" in home.text
