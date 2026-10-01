# Ton-Carburant

Trouver en quelques secondes la station-service la moins chère autour de soi, partout en France.
Application auto-hébergée, 100 % gratuite : données officielles open data, géocodage public,
carte OpenStreetMap, aucune clé d'API. Destinée à être servie sur **https://toncarburant.fr**
depuis un serveur maison via Cloudflare Tunnel.

## Fonctionnalités

- **Un seul champ de recherche** : ville, code postal, adresse, département (`35`, `Gironde`) ou région (`Bretagne`), avec suggestions au fil de la frappe et recherches récentes. Bouton « autour de moi » (géolocalisation).
- **Résultats triés par prix ou par distance** pour le carburant choisi (Gazole, SP95, SP98, E10, E85, GPL), rayon réglable (5 à 50 km).
- **Filtre « ouvert »** : masque les stations déclarées fermées à cette heure (les horaires inexploitables ne sont jamais présentés comme une certitude).
- **Encart « le moins cher »** avec l'économie estimée sur un plein de 50 L par rapport au prix médian de la zone, et écart au moins cher affiché sur chaque station.
- **Ruptures de stock** signalées (en fin de liste, grisées) ; prix anciens (> 3 jours) marqués ; badges « Ouvert », « 24/24 », « Autoroute ».
- **Carte Leaflet** : étiquettes de prix colorées du vert (moins cher) au rouge (plus cher), **sans chevauchement** — les étiquettes qui n'ont plus la place deviennent des points, les moins chères restant prioritaires. Carte plein écran sur mobile, survol synchronisé avec la liste sur ordinateur.
- **Fiche station** : tous les carburants avec date de mise à jour, horaires du jour mis en avant, services, liens d'itinéraire Google Maps / Waze. Se ferme en glissant vers le bas sur mobile.
- **Indicateur de fraîcheur** des données, recherche partageable par URL (`?q=…&fuel=…&r=…`, plus `&station=<id>` pour pointer une station précise), carburant, rayon et tri mémorisés.
- Mobile-first, installable sur l'écran d'accueil (manifeste web), thème sombre automatique, squelettes de chargement, navigation au clavier, aucune étape de build côté frontend.

## Architecture

```
app/
  main.py      FastAPI : API REST, planificateur d'import, fichiers statiques
  ingest.py    téléchargement + parsing du flux, import SQLite (aussi utilisable en CLI)
  search.py    recherche par rayon (index R*Tree) ou par département/région
  geocode.py   proxy vers l'API Adresse avec cache et serveur de secours
  areas.py     départements, régions, plages de codes postaux
  config.py    configuration par variables d'environnement
  static/      index.html, app.css, app.js + Leaflet embarqué (vendor/)
tests/         pytest (parsing, import, recherche, API)
cloudflared/   exemple de config.yml pour un tunnel géré localement
```

- **Un seul conteneur** Python (FastAPI + uvicorn) sert l'API et le frontend.
- **SQLite en mode WAL** dans un volume Docker. Chaque import remplace les données en une transaction : les visiteurs voient l'ancienne version jusqu'au commit.
- **Recherche géospatiale** : table virtuelle R*Tree (intégrée à SQLite, pas besoin de SpatiaLite) pour filtrer la boîte englobante, puis distance exacte (haversine) sur les seuls candidats. Environ 1 ms pour un rayon de 15 km, environ 7 ms pour toute l'Île-de-France.
- **Import planifié** dans le processus (toutes les 10 min par défaut). Au redémarrage, l'import attend si les données sont encore fraîches.

### Sources de données

| Donnée | Source | Notes |
|---|---|---|
| Prix, ruptures, horaires, services | `https://donnees.roulez-eco.fr/opendata/instantane_ruptures` (flux instantané v2) | Licence ouverte, sans clé |
| Géocodage | `https://data.geopf.fr/geocodage/search` puis `https://api-adresse.data.gouv.fr/search/` en secours | API Adresse (BAN), migrée sur la Géoplateforme IGN |
| Fond de carte | tuiles OpenStreetMap | voir [Tuiles de carte](#tuiles-de-carte) |

Format du flux constaté en septembre 2026, géré par `app/ingest.py` :

- archive ZIP contenant un XML en ISO-8859-1 (le XML brut est aussi accepté) ;
- coordonnées en degrés × 100 000, parfois décimales ;
- prix en euros (l'ancien format en millièmes est aussi accepté) ;
- dates en heure de Paris.

Un carburant apparaît soit dans `<prix>`, soit dans `<rupture>`. Une rupture `temporaire` sans date de fin est affichée « Rupture ». Une rupture `definitive` signifie que le carburant n'est pas distribué. Les petites stations dispensées de déclaration n'apparaissent pas pour certains carburants : elles sont comptées à part (« N sans Gazole déclaré »), jamais présentées comme en rupture.

> **Remarque** : le flux ne contient ni le nom ni l'enseigne des stations. L'app affiche donc l'adresse et la ville.

## Démarrage rapide

Prérequis : Docker avec Compose v2.

```bash
git clone <ce dépôt> toncarburant && cd toncarburant
cp .env.example .env        # puis renseigner TUNNEL_TOKEN (voir ci-dessous)
docker compose up -d --build
```

L'app est accessible sur http://127.0.0.1:8000. Le premier import prend quelques secondes ; la barre de statut en bas de liste l'indique.

Pour un essai sans tunnel, laisser `COMPOSE_PROFILES` vide dans `.env` (ou ne pas créer de `.env`).

Suivre les logs : `docker compose logs -f app`.

## Exposition publique avec Cloudflare Tunnel

Aucun port à ouvrir sur la box : `cloudflared` établit une connexion sortante vers Cloudflare.
Prérequis : le domaine `toncarburant.fr` doit être géré par Cloudflare (serveurs DNS pointant vers Cloudflare).

### Option A — tunnel géré depuis le dashboard (recommandé)

1. Dans le dashboard Cloudflare, ouvrir **Zero Trust → Networks → Tunnels**, puis **Create a tunnel**.
2. Choisir **Cloudflared**, nommer le tunnel (ex. `toncarburant`).
3. À l'étape d'installation, copier **uniquement le jeton** (la longue chaîne après `--token`) dans `.env` :
   ```env
   COMPOSE_PROFILES=tunnel
   TUNNEL_TOKEN=eyJhIjoi...
   ```
4. Dans l'onglet **Public Hostname**, ajouter :
   - Subdomain : *(vide)*, Domain : `toncarburant.fr`
   - Service : type `HTTP`, URL `app:8000`

   Recommencer avec le subdomain `www` si besoin. L'enregistrement DNS (CNAME vers `<id>.cfargotunnel.com`) est créé automatiquement.
5. Lancer `docker compose up -d`. Le tunnel doit apparaître **Healthy** dans le dashboard.

`app:8000` fonctionne parce que `cloudflared` tourne dans le même réseau Docker que l'app.

### Option B — tunnel géré localement avec `config.yml`

```bash
cloudflared tunnel login
cloudflared tunnel create toncarburant                 # génère ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns toncarburant toncarburant.fr
cp ~/.cloudflared/<UUID>.json cloudflared/
cp cloudflared/config.yml.example cloudflared/config.yml   # remplacer l'UUID
```

Puis dans `.env` : `COMPOSE_PROFILES=tunnel-config`, et `docker compose up -d`.

### Réglages Cloudflare conseillés

- SSL/TLS : **Full** ; « Always Use HTTPS » activé. HTTPS est requis pour la géolocalisation du navigateur.
- Les réponses `/api/*` portent un `Cache-Control: public, max-age=60`. Une règle de cache Cloudflare peut les mettre en cache pour soulager le serveur si le trafic augmente.

## Configuration

Toutes les variables sont optionnelles (voir `.env.example`). Après modification : `docker compose up -d` (le conteneur est recréé).

| Variable | Défaut | Rôle |
|---|---|---|
| `DEFAULT_RADIUS_KM` | `10` | Rayon proposé par défaut |
| `MAX_RADIUS_KM` | `50` | Rayon maximal accepté par l'API |
| `RADIUS_OPTIONS_KM` | `5,10,15,20,30,50` | Choix du menu déroulant (le rayon par défaut y est ajouté s'il manque) |
| `INGEST_INTERVAL_MINUTES` | `10` | Fréquence d'import (minimum 5) |
| `INGEST_MIN_STATIONS` | `1000` | Un flux avec moins de stations est jugé incomplet et ignoré |
| `INGEST_ENABLED` | `true` | Désactiver le planificateur (tests, instance secondaire) |
| `FEED_URL` | flux instantané v2 | URL du flux officiel |
| `HTTP_TIMEOUT_S` | `60` | Délai de téléchargement du flux |
| `GEOCODER_URLS` | Géoplateforme, puis BAN | Géocodeurs essayés dans l'ordre |
| `TILE_URL` / `TILE_ATTRIBUTION` / `TILE_MAX_ZOOM` | OpenStreetMap | Fond de carte |
| `DB_PATH` | `/data/carburants.db` | Emplacement de la base (dans le volume) |
| `APP_BIND` / `APP_PORT` | `127.0.0.1` / `8000` | Publication locale du port (`0.0.0.0` pour le LAN) |
| `COMPOSE_PROFILES` | — | `tunnel`, `tunnel-config` ou vide |
| `TUNNEL_TOKEN` | — | Jeton du tunnel (option A) |
| `LOG_LEVEL` | `INFO` | Verbosité des logs |

**Exemple : passer le rayon par défaut à 15 km**

```env
DEFAULT_RADIUS_KM=15
```

Puis `docker compose up -d`. Le rayon choisi par un visiteur reste mémorisé dans son navigateur.

## Tuiles de carte

Par défaut, l'app utilise les tuiles standard d'OpenStreetMap, soumises à la [politique d'usage](https://operations.osmfoundation.org/policies/tiles/) : attribution visible (en place), usage raisonnable, pas de trafic intensif. C'est adapté à un usage personnel ou modéré. Si le trafic grossit :

- passer à un fournisseur au palier gratuit via `TILE_URL`, par exemple CARTO : `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png` (vérifier leurs conditions) ;
- ou auto-héberger les tuiles (fichier PMTiles/MBTiles de la France servi par un conteneur `tileserver-gl`, puis `TILE_URL=https://tiles.toncarburant.fr/...`).

## Import manuel et maintenance

```bash
# Forcer un import immédiat
docker compose exec app python -m app.ingest

# Importer un fichier téléchargé à la main (ZIP ou XML)
docker compose cp flux.zip app:/tmp/flux.zip
docker compose exec app python -m app.ingest --file /tmp/flux.zip

# État des données
curl -s http://127.0.0.1:8000/api/status

# Sauvegarde de la base (cohérente même pendant un import)
docker compose exec app python -c "import sqlite3; s=sqlite3.connect('/data/carburants.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)"

# Mise à jour du code
git pull && docker compose up -d --build
```

La base peut être supprimée sans risque (`docker compose down -v`) : elle est reconstruite au prochain import.

Si le flux officiel est indisponible ou invalide :

- les dernières données restent servies ;
- l'erreur est visible dans `/api/status` (`last_error`) et dans les logs ;
- le point de statut passe à l'orange dans l'interface au-delà de 45 minutes sans import réussi.

Si le format du flux change, tout le parsing est concentré dans `app/ingest.py` (`parse_station`). Ajouter un cas au XML d'exemple de `tests/conftest.py`.

> **Un seul worker uvicorn** : le planificateur d'import tourne dans le processus. Ne pas ajouter `--workers N`, sinon chaque worker importerait le flux. Un worker suffit largement : les requêtes SQLite prennent quelques millisecondes.

## API

Documentation interactive : `/api/docs`.

| Endpoint | Description |
|---|---|
| `GET /api/stations?lat=48.11&lon=-1.68&radius_km=10&fuel=Gazole` | Stations dans le rayon, triées par prix |
| `GET /api/stations?area=dept:35&fuel=E10` | Département (`dept:2A`, `dept:971`…) ou région (`region:bretagne`) |
| `GET /api/stations/{id}` | Fiche complète |
| `GET /api/geocode?q=rennes` | Lieux (API Adresse) + départements/régions correspondants |
| `GET /api/status` | Fraîcheur des données, dernière erreur d'import |
| `GET /api/config` | Rayons, carburants, fond de carte |
| `GET /healthz` | Sonde de santé (utilisée par Docker) |

## Développement

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest
INGEST_MIN_STATIONS=1000 uvicorn app.main:app --reload    # base dans ./data/
```

## Licences et crédits

- Prix des carburants : Ministère de l'Économie, [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/rubrique/opendata/), licence ouverte.
- Géocodage : [API Adresse](https://adresse.data.gouv.fr) (Base Adresse Nationale).
- Carte : © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright), [Leaflet](https://leafletjs.com) (BSD-2).
# ton-carburant.fr
