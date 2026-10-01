"""Référentiel des enseignes de stations-service.

Le flux officiel des prix (`ingest.py`) ne contient ni nom ni enseigne :
seule l'adresse est fournie. On complète via le référentiel communautaire
data.gouv.fr "Référentiel des noms et enseignes de stations-service"
(CSV enrichi par OpenStreetMap), qui associe l'identifiant officiel du
point de vente à une enseigne normalisée (ex: "Carrefour", "TotalEnergies").

Ce CSV est alimenté par OpenStreetMap : son contenu n'est pas fiable à 100 %
(coquilles, vandalisme occasionnel). On ne le traite donc que comme du texte
à afficher (jamais interprété) et on écarte les entrées qui ressemblent à du
bruit plutôt qu'à un nom d'enseigne.
"""

import csv
import io
import logging

import httpx

log = logging.getLogger(__name__)

USER_AGENT = "Ton-Carburant/1.0 (+https://toncarburant.fr)"
_MAX_NAME_LEN = 60
_MAX_TOKEN_LEN = 24  # un "mot" plus long que ça est plus probablement du bruit qu'une enseigne


def fetch_brands_payload(url: str, timeout: float) -> bytes:
    with httpx.Client(timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.content


def _clean_name(raw: str) -> str | None:
    name = " ".join((raw or "").split())[:_MAX_NAME_LEN]
    if not name or any(len(token) > _MAX_TOKEN_LEN for token in name.split()):
        return None
    return name


def parse_brands(payload: bytes) -> dict[int, str]:
    text = payload.decode("utf-8-sig", errors="replace")
    brands: dict[int, str] = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            station_id = int((row.get("id_station_officiel") or "").strip())
        except ValueError:
            continue
        name = _clean_name(row.get("nom_normalise") or "")
        if name:
            brands[station_id] = name
    return brands
