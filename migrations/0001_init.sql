-- Schéma D1 de Ton-Carburant.
-- Une ligne par station : prix et ruptures sont dénormalisés en JSON pour que
-- chaque import ne réécrive que les stations modifiées (D1 gratuit : 100 000
-- lignes écrites par jour). `h` est l'empreinte du contenu, utilisée par
-- l'import pour calculer le différentiel. Pas de R*Tree (non disponible sur
-- D1) : la boîte englobante s'appuie sur l'index (lat, lon).
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    cp TEXT NOT NULL,
    city TEXT NOT NULL,
    address TEXT NOT NULL,
    pop TEXT,
    brand TEXT,
    automate_24_24 INTEGER NOT NULL DEFAULT 0,
    hours_json TEXT,
    services_json TEXT NOT NULL DEFAULT '[]',
    prices_json TEXT NOT NULL DEFAULT '{}',
    ruptures_json TEXT NOT NULL DEFAULT '{}',
    h TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_stations_cp ON stations(cp);
CREATE INDEX IF NOT EXISTS idx_stations_lat_lon ON stations(lat, lon);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
