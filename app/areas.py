"""Départements et régions : recherche par nom/code et plages de codes postaux."""

import re
import unicodedata

DEPARTEMENTS = {
    "01": "Ain", "02": "Aisne", "03": "Allier", "04": "Alpes-de-Haute-Provence", "05": "Hautes-Alpes",
    "06": "Alpes-Maritimes", "07": "Ardèche", "08": "Ardennes", "09": "Ariège", "10": "Aube",
    "11": "Aude", "12": "Aveyron", "13": "Bouches-du-Rhône", "14": "Calvados", "15": "Cantal",
    "16": "Charente", "17": "Charente-Maritime", "18": "Cher", "19": "Corrèze", "2A": "Corse-du-Sud",
    "2B": "Haute-Corse", "21": "Côte-d'Or", "22": "Côtes-d'Armor", "23": "Creuse", "24": "Dordogne",
    "25": "Doubs", "26": "Drôme", "27": "Eure", "28": "Eure-et-Loir", "29": "Finistère",
    "30": "Gard", "31": "Haute-Garonne", "32": "Gers", "33": "Gironde", "34": "Hérault",
    "35": "Ille-et-Vilaine", "36": "Indre", "37": "Indre-et-Loire", "38": "Isère", "39": "Jura",
    "40": "Landes", "41": "Loir-et-Cher", "42": "Loire", "43": "Haute-Loire", "44": "Loire-Atlantique",
    "45": "Loiret", "46": "Lot", "47": "Lot-et-Garonne", "48": "Lozère", "49": "Maine-et-Loire",
    "50": "Manche", "51": "Marne", "52": "Haute-Marne", "53": "Mayenne", "54": "Meurthe-et-Moselle",
    "55": "Meuse", "56": "Morbihan", "57": "Moselle", "58": "Nièvre", "59": "Nord",
    "60": "Oise", "61": "Orne", "62": "Pas-de-Calais", "63": "Puy-de-Dôme", "64": "Pyrénées-Atlantiques",
    "65": "Hautes-Pyrénées", "66": "Pyrénées-Orientales", "67": "Bas-Rhin", "68": "Haut-Rhin", "69": "Rhône",
    "70": "Haute-Saône", "71": "Saône-et-Loire", "72": "Sarthe", "73": "Savoie", "74": "Haute-Savoie",
    "75": "Paris", "76": "Seine-Maritime", "77": "Seine-et-Marne", "78": "Yvelines", "79": "Deux-Sèvres",
    "80": "Somme", "81": "Tarn", "82": "Tarn-et-Garonne", "83": "Var", "84": "Vaucluse",
    "85": "Vendée", "86": "Vienne", "87": "Haute-Vienne", "88": "Vosges", "89": "Yonne",
    "90": "Territoire de Belfort", "91": "Essonne", "92": "Hauts-de-Seine", "93": "Seine-Saint-Denis",
    "94": "Val-de-Marne", "95": "Val-d'Oise", "971": "Guadeloupe", "972": "Martinique", "973": "Guyane",
    "974": "La Réunion", "976": "Mayotte",
}

REGIONS = {
    "Auvergne-Rhône-Alpes": ("01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74"),
    "Bourgogne-Franche-Comté": ("21", "25", "39", "58", "70", "71", "89", "90"),
    "Bretagne": ("22", "29", "35", "56"),
    "Centre-Val de Loire": ("18", "28", "36", "37", "41", "45"),
    "Corse": ("2A", "2B"),
    "Grand Est": ("08", "10", "51", "52", "54", "55", "57", "67", "68", "88"),
    "Hauts-de-France": ("02", "59", "60", "62", "80"),
    "Île-de-France": ("75", "77", "78", "91", "92", "93", "94", "95"),
    "Normandie": ("14", "27", "50", "61", "76"),
    "Nouvelle-Aquitaine": ("16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"),
    "Occitanie": ("09", "11", "12", "30", "31", "32", "34", "46", "48", "65", "66", "81", "82"),
    "Pays de la Loire": ("44", "49", "53", "72", "85"),
    "Provence-Alpes-Côte d'Azur": ("04", "05", "06", "13", "83", "84"),
}

# Codes postaux corses : 200xx/201xx (Corse-du-Sud), 202xx/206xx (Haute-Corse).
_CP_PREFIXES = {"2A": ("200", "201"), "2B": ("202", "206")}


def normalize(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.lower()).strip()


def _slug(name: str) -> str:
    return normalize(name).replace(" ", "-")


_REGION_BY_SLUG = {_slug(name): name for name in REGIONS}


def cp_ranges(dept_code: str) -> list[tuple[str, str]]:
    """Plages [début, fin) de codes postaux, exploitables par l'index sur `cp`."""
    prefixes = _CP_PREFIXES.get(dept_code, (dept_code,))
    return [(p, p[:-1] + chr(ord(p[-1]) + 1)) for p in prefixes]


def _dept_result(code: str, exact: bool) -> dict:
    return {
        "label": f"{DEPARTEMENTS[code]} ({code})",
        "context": "Département entier",
        "type": "departement",
        "area": f"dept:{code}",
        "exact": exact,
    }


def _region_result(name: str, exact: bool) -> dict:
    return {
        "label": name,
        "context": f"Région entière · {len(REGIONS[name])} départements",
        "type": "region",
        "area": f"region:{_slug(name)}",
        "exact": exact,
    }


def _matches(query: str, name: str) -> bool:
    return name.startswith(query) or (len(query) >= 4 and f" {query}" in f" {name}")


def find_areas(query: str, limit: int = 4) -> list[dict]:
    q = normalize(query)
    if not q:
        return []
    results = []
    code = query.strip().upper()
    if code in DEPARTEMENTS:
        results.append(_dept_result(code, exact=True))
    if len(q) >= 3:
        for name in REGIONS:
            if _matches(q, normalize(name)):
                results.append(_region_result(name, exact=normalize(name) == q))
        for dept, name in DEPARTEMENTS.items():
            if dept != code and _matches(q, normalize(name)):
                results.append(_dept_result(dept, exact=normalize(name) == q))
    results.sort(key=lambda r: not r["exact"])
    return results[:limit]


def resolve_area(key: str) -> dict | None:
    """"dept:35" ou "region:bretagne" -> {"label", "departements"}."""
    kind, _, value = key.partition(":")
    if kind == "dept" and value.upper() in DEPARTEMENTS:
        code = value.upper()
        return {"key": f"dept:{code}", "label": f"{DEPARTEMENTS[code]} ({code})", "departements": [code]}
    if kind == "region" and value.lower() in _REGION_BY_SLUG:
        name = _REGION_BY_SLUG[value.lower()]
        return {"key": f"region:{value.lower()}", "label": name, "departements": list(REGIONS[name])}
    return None
