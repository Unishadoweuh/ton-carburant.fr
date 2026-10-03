"""Géocodage via l'API Adresse (Géoplateforme IGN, puis ancien domaine BAN en secours)."""

import logging
import threading
import time
from collections import OrderedDict

import httpx

log = logging.getLogger(__name__)


class Geocoder:
    def __init__(
        self,
        urls: tuple[str, ...],
        timeout: float = 5.0,
        cache_size: int = 1024,
        cache_ttl_s: float = 24 * 3600,
        transport: httpx.BaseTransport | None = None,
    ):
        self._urls = urls
        self._client = httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": "Ton-Carburant/1.0 (+https://toncarburant.fr)"},
            transport=transport,
        )
        self._cache: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()
        self._cache_size = cache_size
        self._cache_ttl_s = cache_ttl_s
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def search(self, query: str, limit: int = 6) -> list[dict] | None:
        """Résultats géocodés, liste vide si la requête est trop courte,
        None si aucun service n'a répondu."""
        query = " ".join(query.split())[:200]
        # L'API refuse les requêtes de moins de 3 caractères ou ne commençant pas par un alphanumérique.
        if len(query) < 3 or not query[0].isalnum():
            return []
        key = f"{query.lower()}|{limit}"
        with self._lock:
            hit = self._cache.get(key)
            if hit and time.monotonic() - hit[0] < self._cache_ttl_s:
                self._cache.move_to_end(key)
                return hit[1]

        results = self._fetch(query, limit)
        if results is not None:
            with self._lock:
                self._cache[key] = (time.monotonic(), results)
                self._cache.move_to_end(key)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
        return results

    def _fetch(self, query: str, limit: int) -> list[dict] | None:
        for url in self._urls:
            try:
                response = self._client.get(url, params={"q": query, "limit": limit, "autocomplete": 1})
                response.raise_for_status()
                features = response.json().get("features", [])
                return [r for r in (self._parse(f) for f in features) if r]
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("Géocodeur %s indisponible : %s", url, exc)
        return None

    @staticmethod
    def _parse(feature: dict) -> dict | None:
        try:
            lon, lat = feature["geometry"]["coordinates"][:2]
        except (KeyError, TypeError, ValueError):
            return None
        props = feature.get("properties") or {}
        kind = props.get("type") or "address"
        context = props.get("context") or ""
        if kind == "municipality" and props.get("postcode"):
            context = f"{props['postcode']} · {context}"
        return {
            "label": props.get("label") or props.get("name") or "",
            "context": context,
            "type": kind,
            "lat": float(lat),
            "lon": float(lon),
        }
