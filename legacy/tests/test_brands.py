from app.brands import parse_brands

SAMPLE_CSV = """id_station_officiel,nom_normalise,adresse,ville,code_postal,latitude_osm,longitude_osm,source_enrichissement
35000001,Carrefour Market,1 Rue de Châtillon,Rennes,35000,48.11,-1.68,OpenStreetMap
35000002,TotalEnergies,Route de Lorient,Rennes,35000,48.12,-1.70,OpenStreetMap
35510001,,ZA de la Rigourdière,Cesson-Sévigné,35510,48.17,-1.60,OpenStreetMap
notanid,Avia,n'importe où,Ailleurs,00000,0,0,OpenStreetMap
20000001,DELETE TAG aechohve0Eire4ooyeyaey1gieme0xoo,Cours Napoléon,Ajaccio,20000,41.92,8.73,OpenStreetMap
""".encode("utf-8")


def test_parse_brands_maps_id_to_normalized_name():
    brands = parse_brands(SAMPLE_CSV)
    assert brands == {35000001: "Carrefour Market", 35000002: "TotalEnergies"}


def test_parse_brands_skips_blank_bad_id_and_noise():
    brands = parse_brands(SAMPLE_CSV)
    assert 35510001 not in brands  # nom vide
    assert "notanid" not in {str(k) for k in brands}  # id invalide
    assert 20000001 not in brands  # jeton de bruit (vandalisme OSM) trop long
