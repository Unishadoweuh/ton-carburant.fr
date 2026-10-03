# Ton-Carburant

Trouver en quelques secondes la station-service la moins chère autour de soi, partout en France.
Application 100 % gratuite : données officielles open data, géocodage public, carte OpenStreetMap,
aucune clé d'API. Elle tourne sur l'edge de **Cloudflare** (Workers + D1), sans serveur à gérer.
Adresse actuelle : **https://carburant.unishadow.ovh** (à terme : toncarburant.fr).

> L'ancienne version FastAPI + SQLite + Docker est conservée dans [`legacy/`](legacy/).

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
public/        frontend statique (index.html, app.css, app.js, Leaflet embarqué), sans build
src/
  worker.ts    Worker : API REST /api/* (les autres chemins sont servis par les Static Assets)
  config.ts    configuration par variables du Worker ([vars] de wrangler.toml)
  lib/         logique métier partagée : search, areas, hours, fuels, geocode, feed, brands
ingest/        import du flux dans D1 (exécuté par GitHub Actions)
migrations/    schéma D1
tests/         Vitest (parsing, import différentiel, recherche, API)
legacy/        ancienne version Python/Docker
.github/workflows/  deploy.yml (déploiement) et ingest.yml (import toutes les 10 min)
```

```
 GitHub Actions (*/10)                      Cloudflare
┌──────────────────────┐   écritures    ┌──────────────┐   lectures   ┌────────────────────┐
│ ingest/run.ts        │ ─────────────▶ │      D1      │ ◀─────────── │ Worker (/api/*)    │ ◀── navigateur
│ flux JSON ~29 Mo     │  (différentiel)│  SQLite edge │              │ + Static Assets    │
└──────────────────────┘                └──────────────┘              └────────────────────┘
```

- **Un seul Worker** sert l'API et le frontend (Static Assets) : même origine, pas de CORS à gérer, un seul déploiement. Les requêtes statiques ne consomment pas de temps CPU.
- **Pourquoi l'import n'est pas un Cron Trigger Worker** : le plan gratuit des Workers limite le CPU à 10 ms par invocation, très insuffisant pour parser les ~29 Mo du flux. L'import tourne donc dans GitHub Actions (gratuit). GitHub plafonne les crons à 5 min et peut les retarder : les données ont typiquement 10 à 15 min de retard, sans incidence pratique. Le module de parsing (`src/lib/feed.ts`) est pur : avec un plan Workers payant, il pourrait être appelé tel quel depuis un `scheduled()`.
- **Schéma D1 dénormalisé** : une ligne par station, avec prix et ruptures en JSON. L'import calcule une empreinte par station et **n'écrit que les stations modifiées** (quelques milliers par jour sur ~9 800), pour rester sous la limite gratuite de 100 000 lignes écrites par jour.
- **Recherche géospatiale** : D1 n'a pas de R*Tree. La boîte englobante est filtrée via l'index B-tree `(lat, lon)`, puis la distance haversine exacte est calculée en TypeScript sur les seuls candidats. Les départements et régions utilisent des plages de codes postaux sur l'index `cp`.
- **Cache** : les réponses `/api/*` portent `Cache-Control: public, max-age=60` et sont mises en cache à l'edge (Cache API), ce qui protège le quota de lectures D1 (5 M lignes/jour) et le budget CPU.

### Sources de données

| Donnée | Source | Notes |
|---|---|---|
| Prix, ruptures, horaires, services | [data.economie.gouv.fr](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/) : « Prix des carburants en France - Flux instantané - v2 » (export JSON) | Licence ouverte, sans clé |
| Enseignes | Référentiel communautaire data.gouv.fr (CSV enrichi par OpenStreetMap) | Facultatif ; en cas d'échec, les enseignes déjà en base sont conservées |
| Géocodage | `https://data.geopf.fr/geocodage/search` puis `https://api-adresse.data.gouv.fr/search/` en secours | API Adresse (BAN), Géoplateforme IGN |
| Fond de carte | tuiles OpenStreetMap | voir [Tuiles de carte](#tuiles-de-carte) |

Format du flux (export JSON de l'XML officiel), géré par `src/lib/feed.ts` :

- attributs préfixés par `@`, éléments uniques sous forme d'objet (et non de tableau), sous-arbres `horaires`, `services`, `prix` et `rupture` sérialisés en chaînes JSON ;
- coordonnées en degrés × 100 000, parfois décimales ; prix en euros (l'ancien format en millièmes est aussi accepté) ; dates en heure de Paris.

Un carburant apparaît soit dans `prix`, soit dans `rupture`. Une rupture `temporaire` sans date de fin est affichée « Rupture ». Une rupture `definitive` signifie que le carburant n'est pas distribué. Les petites stations dispensées de déclaration n'apparaissent pas pour certains carburants : elles sont comptées à part (« N sans Gazole déclaré »), jamais présentées comme en rupture.

## Mise en route

Prérequis : Node.js 24+ et un compte Cloudflare (gratuit). Le domaine `unishadow.ovh` doit être une zone Cloudflare de ce compte.

### 1. Installer et créer la base D1

```bash
npm install
npx wrangler login
npx wrangler d1 create ton-carburant-db
```

Copier le `database_id` affiché dans [`wrangler.toml`](wrangler.toml) (bloc `[[d1_databases]]`, il n'est pas secret).

### 2. Lancer en local

```bash
npm run db:migrate:local      # crée le schéma dans la D1 locale
npm run ingest:local          # importe le vrai flux dans la D1 locale (~1 min la première fois)
npx wrangler dev              # http://localhost:8787
```

`npm test` lance les tests, `npm run typecheck` vérifie les types.

### 3. Déploiement automatique (GitHub Actions)

1. Créer un jeton API Cloudflare (**My Profile → API Tokens → Create Token**) avec les permissions **Account → Workers Scripts : Edit**, **Account → D1 : Edit** et **Zone → Workers Routes : Edit** (zone `unishadow.ovh`). L'attachement du domaine personnalisé peut demander en plus **Zone → DNS : Edit**.
2. Dans le dépôt GitHub, **Settings → Secrets and variables → Actions**, ajouter :
   - `CLOUDFLARE_API_TOKEN` : le jeton ci-dessus ;
   - `CLOUDFLARE_ACCOUNT_ID` : l'identifiant du compte (barre latérale du dashboard Cloudflare).
3. Chaque `git push` sur `main` déclenche [`deploy.yml`](.github/workflows/deploy.yml) : types, tests, migrations D1 puis `wrangler deploy`. Le domaine `carburant.unishadow.ovh` est créé automatiquement (route `custom_domain`).
4. [`ingest.yml`](.github/workflows/ingest.yml) importe les prix toutes les 10 minutes. Pour remplir la base immédiatement après le premier déploiement : onglet **Actions → Import des prix → Run workflow**.

> GitHub désactive les workflows planifiés d'un dépôt public sans activité pendant 60 jours : relancer le workflow manuellement (ou pousser un commit) pour le réactiver.

### Passer sur toncarburant.fr

Quand le domaine sera géré par Cloudflare, ajouter dans `wrangler.toml` :

```toml
routes = [
  { pattern = "carburant.unishadow.ovh", custom_domain = true },
  { pattern = "toncarburant.fr", custom_domain = true },
  { pattern = "www.toncarburant.fr", custom_domain = true },
]
```

Mettre à jour aussi l'URL canonique dans `public/index.html`. HTTPS est requis pour la géolocalisation du navigateur (fourni par Cloudflare).

## Configuration

Variables du Worker, dans `[vars]` de `wrangler.toml` (toutes optionnelles) :

| Variable | Défaut | Rôle |
|---|---|---|
| `DEFAULT_RADIUS_KM` | `10` | Rayon proposé par défaut |
| `MAX_RADIUS_KM` | `50` | Rayon maximal accepté par l'API |
| `RADIUS_OPTIONS_KM` | `5,10,15,20,30,50` | Choix du menu déroulant (le rayon par défaut y est ajouté s'il manque) |
| `INGEST_INTERVAL_MINUTES` | `10` | Intervalle attendu entre deux imports, pour l'indicateur de fraîcheur (minimum 5) |
| `GEOCODER_URLS` | Géoplateforme, puis BAN | Géocodeurs essayés dans l'ordre |
| `TILE_URL` / `TILE_ATTRIBUTION` / `TILE_MAX_ZOOM` | OpenStreetMap | Fond de carte |

Variables d'environnement du script d'import (à définir dans `ingest.yml` si besoin) : `FEED_URL`, `BRANDS_URL` (vide = pas d'enseignes), `INGEST_MIN_STATIONS` (défaut `1000` : un flux plus petit est jugé incomplet et ignoré).

## Tuiles de carte

Par défaut, l'app utilise les tuiles standard d'OpenStreetMap, soumises à la [politique d'usage](https://operations.osmfoundation.org/policies/tiles/) : attribution visible (en place), usage raisonnable, pas de trafic intensif. C'est adapté à un usage personnel ou modéré. Si le trafic grossit :

- passer à un fournisseur au palier gratuit via `TILE_URL`, par exemple CARTO : `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png` (vérifier leurs conditions) ;
- ou auto-héberger les tuiles (fichier PMTiles/MBTiles de la France servi par un conteneur `tileserver-gl`, puis `TILE_URL=https://tiles.toncarburant.fr/...`).

## Import manuel et maintenance

```bash
npm run ingest                                    # import vers la D1 distante (CLOUDFLARE_API_TOKEN requis)
npx tsx ingest/run.ts --file flux.json --dry-run  # lit un export local, affiche le différentiel sans écrire
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) FROM stations"
curl -s https://carburant.unishadow.ovh/api/status
```

Si le flux officiel est indisponible ou invalide :

- les dernières données restent servies ;
- le workflow d'import échoue (visible dans l'onglet Actions) et l'erreur est enregistrée dans `/api/status` (`last_error`) ;
- le point de statut passe à l'orange dans l'interface au-delà de 45 minutes sans import réussi.

Si le format du flux change, le parsing est concentré dans `src/lib/feed.ts` (`parseStation`) : ajouter un cas dans `tests/helpers.ts`.

La base peut être vidée sans risque : l'import suivant la reconstruit entièrement.

### Limites du plan gratuit à surveiller

| Ressource | Limite gratuite | Usage attendu |
|---|---|---|
| Workers : requêtes | 100 000 / jour (hors fichiers statiques) | ≈ requêtes d'API non servies par le cache edge |
| Workers : CPU | 10 ms / requête | Recherches par rayon : très en deçà. Les grandes régions (≈ 1 000 stations) sont les plus coûteuses : à surveiller dans le dashboard (Workers → Metrics) |
| D1 : lignes écrites | 100 000 / jour | environ 4 500 stations modifiées par jour, soit bien en dessous |
| D1 : lignes lues | 5 M / jour | un import lit ~9 800 lignes (empreintes) × 144 par jour ≈ 1,4 M ; le reste dépend du trafic non mis en cache |

## API

| Endpoint | Description |
|---|---|
| `GET /api/stations?lat=48.11&lon=-1.68&radius_km=10&fuel=Gazole` | Stations dans le rayon, triées par prix |
| `GET /api/stations?area=dept:35&fuel=E10` | Département (`dept:2A`, `dept:971`…) ou région (`region:bretagne`) |
| `GET /api/stations/{id}` | Fiche complète |
| `GET /api/geocode?q=rennes` | Lieux (API Adresse) + départements/régions correspondants |
| `GET /api/status` | Fraîcheur des données, dernière erreur d'import |
| `GET /api/config` | Rayons, carburants, fond de carte |

Réponses en JSON, `Cache-Control: public, max-age=60` et CORS ouvert (`Access-Control-Allow-Origin: *`). Les erreurs ont la forme `{"detail": "..."}`.

## Licences et crédits

- Prix des carburants : Ministère de l'Économie, [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/rubrique/opendata/), licence ouverte.
- Géocodage : [API Adresse](https://adresse.data.gouv.fr) (Base Adresse Nationale).
- Carte : © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright), [Leaflet](https://leafletjs.com) (BSD-2).
