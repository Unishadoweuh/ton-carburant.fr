"""Carburants publiés dans le flux officiel."""

# Ordre d'affichage. "GPLc" est le nom utilisé par le flux, affiché "GPL".
FUEL_CODES = ("Gazole", "SP95", "SP98", "E10", "E85", "GPLc")

FUEL_LABELS = {
    "Gazole": "Gazole",
    "SP95": "SP95",
    "SP98": "SP98",
    "E10": "E10",
    "E85": "E85",
    "GPLc": "GPL",
}

_ALIASES = {
    "gazole": "Gazole",
    "sp95": "SP95",
    "sp98": "SP98",
    "e10": "E10",
    "sp95-e10": "E10",
    "e85": "E85",
    "gplc": "GPLc",
    "gpl": "GPLc",
}


def normalize_fuel(name: str | None) -> str | None:
    """Retourne le code canonique d'un carburant, ou None s'il est inconnu."""
    return _ALIASES.get((name or "").strip().lower())
