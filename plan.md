# Prompt pour Claude Code — Application web "Carburant le moins cher"

## Contexte du projet

Créer une application web self-hosted qui permet de trouver rapidement la station-service la moins chère en France, par recherche de code postal, ville ou région. L'app doit être 100% gratuite (aucun coût d'API, d'hébergement carte, ou de service tiers payant), hébergée sur un serveur personnel à la maison et exposée publiquement via Cloudflare Tunnel.

L'objectif est de faire mieux, en termes d'ergonomie et de rapidité de recherche, que les sites existants (ex. dispocarburant.fr, prix-carburants.gouv.fr) qui sont fonctionnels mais peu intuitifs.

## Sources de données (gratuites, officielles, sans clé API)

**Ne pas scraper de site.** La France publie un flux open data officiel qui couvre exactement ce besoin — c'est la source à utiliser :

1. **Prix des carburants — Flux instantané v2** (Ministère de l'Économie)
   Mis à jour toutes les 10 minutes. Contient pour chaque station : adresse, coordonnées GPS, horaires, services, prix par carburant (Gazole, SP95, SP98, E10, E85, GPL) et ruptures de stock.
   - Endpoint source : `https://donnees.roulez-eco.fr/opendata/instantane_ruptures`
   - Disponible en JSON, GeoJSON, CSV, ZIP via data.gouv.fr / transport.data.gouv.fr (chercher "Prix des carburants en France - Flux instantané v2")
   - Licence Ouverte / Open Licence — usage commercial et public autorisé, pas de clé requise

2. **API Adresse (BAN — Base Adresse Nationale)** pour géocoder les recherches utilisateur (code postal, ville, adresse) en coordonnées GPS.
   - Endpoint : `https://api-adresse.data.gouv.fr/search/?q=...`
   - Gratuite, sans clé, illimitée en usage raisonnable

3. **Fonds de carte : OpenStreetMap** via tuiles Leaflet (ex. tuiles OSM standard, ou un fournisseur gratuit type CARTO/Stadia en tier gratuit si besoin d'un style plus léger). Respecter la politique d'usage des tuiles OSM (pas d'usage intensif en production sans self-hosting du serveur de tuiles si le trafic grossit — à prévoir en note, pas bloquant pour un MVP).

Claude Code doit vérifier au moment de l'implémentation que ces URLs et formats sont toujours d'actualité (elles évoluent parfois), et adapter le parsing en conséquence.

## Fonctionnalités attendues (MVP)

1. **Recherche principale** : un champ unique où l'utilisateur tape un code postal, une ville ou une adresse. Geocodage via l'API Adresse, puis recherche des stations dans un rayon configurable (par défaut 10-15 km, ajustable par l'utilisateur).
2. **Résultats triés par prix**, avec filtre par type de carburant (Gazole, SP95, SP98, E10, E85, GPL).
3. **Indication de disponibilité** : signaler visuellement les ruptures de stock (donnée présente dans le flux).
4. **Carte interactive** (Leaflet + OSM) affichant les stations du rayon de recherche, avec code couleur selon le prix (vert = moins cher, rouge = plus cher).
5. **Fiche détaillée par station** au clic : tous les carburants disponibles, prix, horaires, services, date de dernière mise à jour du prix.
6. **Design simple et rapide** : mobile-first, recherche en un minimum de clics, pas de fioritures inutiles. C'est le point différenciant par rapport aux sites existants.

## Architecture technique recommandée

- **Backend** : Python (FastAPI) ou Node.js (Express/Fastify) — au choix de Claude Code selon ce qui simplifie le plus l'ingestion de données. Doit inclure :
  - Un job planifié (cron interne ou scheduler type APScheduler/node-cron) qui télécharge et parse le flux instantané toutes les 10-15 minutes et met à jour une base locale.
  - Une base de données légère et auto-hébergeable : **SQLite avec extension spatiale (SpatiaLite)** ou **PostgreSQL + PostGIS** si Docker Compose est utilisé de toute façon. Privilégier SQLite pour un MVP simple à maintenir sur un homelab, sauf si le volume de requêtes justifie PostGIS.
  - Une API REST interne : recherche par coordonnées + rayon, filtrage par carburant, tri par prix.
- **Frontend** : SPA légère (Vue.js ou vanilla JS + HTMX, au choix de Claude Code selon simplicité de maintenance) avec Leaflet.js pour la carte.
- **Déploiement** : Docker Compose (un service backend, un service frontend ou un seul service si servi statique par le backend, + volume persistant pour la base de données).
- **Exposition publique** : Cloudflare Tunnel (`cloudflared`) — inclure un exemple de configuration `config.yml` et un service Docker `cloudflared` dans le `docker-compose.yml`, avec une note sur la création du tunnel côté dashboard Cloudflare (Zero Trust) et le nom de domaine à pointer.

## Points d'attention à traiter dans l'implémentation

- Gérer le fait que toutes les stations ne remontent pas tous les carburants (stations à faible volume dispensées de déclaration).
- Gérer proprement les erreurs si le flux officiel est temporairement indisponible (garder les dernières données en cache plutôt que planter).
- Prévoir un indicateur "dernière mise à jour des données" visible pour l'utilisateur, pour la transparence.
- Optimiser la recherche géospatiale (index spatial, pas de calcul de distance sur toute la table à chaque requête).
- Responsive design correct, la majorité des usages seront probablement mobiles (recherche avant un trajet).

## Livrable attendu

Un dépôt de code complet et fonctionnel avec :
- Structure du projet claire (backend/frontend séparés ou monorepo, au choix)
- `docker-compose.yml` prêt à lancer en un `docker compose up`, incluant le service Cloudflare Tunnel
- Script/job d'ingestion des données testé
- README expliquant : installation, configuration du tunnel Cloudflare, variables d'environnement, et comment mettre à jour le rayon de recherche par défaut ou d'autres paramètres
- Une interface simple mais soignée, pas un prototype non stylé

Tu es libre sur le choix précis des librairies et frameworks tant que les contraintes ci-dessus (gratuit, self-hosted, simple à maintenir sur un homelab) sont respectées. Si un point du flux de données officiel a changé de format depuis la rédaction de ce prompt, adapte le parsing en conséquence plutôt que de bloquer.