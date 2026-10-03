import dataclasses

import pytest

from app.config import load_settings

# Extrait représentatif du flux (encodé en ISO-8859-1 comme l'original).
SAMPLE_XML = """<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>
<pdv_liste>
  <pdv id="35000001" latitude="4811090" longitude="-168365" cp="35000" pop="R">
    <adresse>1 Rue de Châtillon</adresse>
    <ville>RENNES</ville>
    <horaires automate-24-24="1">
      <jour id="2" nom="Mardi" ferme=""><horaire ouverture="07.00" fermeture="21.00" /></jour>
      <jour id="1" nom="Lundi" ferme=""><horaire ouverture="07.00" fermeture="21.00" /></jour>
    </horaires>
    <services><service>Lavage automatique</service><service>Boutique alimentaire</service></services>
    <prix nom="Gazole" id="1" maj="2026-09-14 12:06:54" valeur="1.899" />
    <prix nom="E10" id="5" maj="2026-09-14 12:06:54" valeur="1.799" />
    <rupture nom="GPLc" id="4" debut="2021-06-22 09:19:16" fin="" type="definitive" />
  </pdv>
  <pdv id="35000002" latitude="48.12" longitude="-1.70" cp="35000" pop="R">
    <adresse>Route de Lorient</adresse>
    <ville>RENNES</ville>
    <services />
    <prix nom="Gazole" id="1" maj="2026-09-15 08:00:00" valeur="1859" />
    <rupture nom="E10" id="5" debut="2026-09-15 08:00:00" fin="" type="temporaire" />
    <rupture nom="SP98" id="6" debut="2026-09-01 08:00:00" fin="2026-09-02 08:00:00" type="temporaire" />
  </pdv>
  <pdv id="35510001" latitude="4817000" longitude="-160000" cp="35510" pop="R">
    <adresse>ZA de la Rigourdière</adresse>
    <ville>CESSON-SÉVIGNÉ</ville>
    <services />
    <prix nom="Gazole" id="1" maj="2026-09-15 07:00:00" valeur="1.949" />
    <prix nom="E10" id="5" maj="2026-09-15 07:00:00" valeur="1.749" />
  </pdv>
  <pdv id="35300001" latitude="4839000" longitude="-116000" cp="35300" pop="A">
    <adresse>Aire de Fougères</adresse>
    <ville>FOUGERES</ville>
    <services />
    <prix nom="Gazole" id="1" maj="2026-09-15 07:00:00" valeur="1.799" />
  </pdv>
  <pdv id="20000001" latitude="4192000" longitude="873000" cp="20000" pop="R">
    <adresse>Cours Napoléon</adresse>
    <ville>AJACCIO</ville>
    <services />
    <prix nom="SP98" id="6" maj="2026-09-15 07:00:00" valeur="2.099" />
  </pdv>
  <pdv id="75000099" latitude="" longitude="" cp="75001">
    <adresse>Sans coordonnées</adresse>
    <ville>PARIS</ville>
  </pdv>
</pdv_liste>
""".encode("iso-8859-1")


@pytest.fixture
def settings(tmp_path):
    return dataclasses.replace(
        load_settings(),
        db_path=str(tmp_path / "test.db"),
        ingest_enabled=False,
        ingest_min_stations=1,
        geocoder_urls=("https://geo.test/search",),
        brands_url="",  # pas d'appel réseau pendant les tests
    )


@pytest.fixture
def loaded_settings(settings):
    from app.ingest import run_ingest

    result = run_ingest(settings, fetch=lambda: SAMPLE_XML)
    assert result == {"ok": True, "stations": 5}
    return settings
