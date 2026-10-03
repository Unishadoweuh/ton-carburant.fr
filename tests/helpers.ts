import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseFeed } from "../src/lib/feed";
import type { Db } from "../src/lib/search";
import { metaStatement, planSync } from "../ingest/core";

/** Adaptateur D1 -> node:sqlite : même SQLite que D1, sans réseau. */
export function sqliteD1(sqlite: DatabaseSync): Db {
  return {
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({
          all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as any[])) as T[] }),
          first: async <T>() => (sqlite.prepare(sql).get(...(values as any[])) as T | undefined) ?? null,
        }),
      };
    },
  };
}

// Extrait représentatif du flux, dans le format JSON de data.economie.gouv.fr.
const j = JSON.stringify;
export const SAMPLE_RECORDS = [
  {
    id: "35000001", latitude: "4811090", longitude: "-168365", cp: "35000", pop: "R",
    adresse: "1 Rue de Châtillon", ville: "RENNES",
    horaires: j({
      "@automate-24-24": "1",
      jour: [
        { "@id": "2", "@nom": "Mardi", "@ferme": "", horaire: { "@ouverture": "07.00", "@fermeture": "21.00" } },
        { "@id": "1", "@nom": "Lundi", "@ferme": "", horaire: [{ "@ouverture": "07.00", "@fermeture": "21.00" }] },
      ],
    }),
    services: j({ service: ["Lavage automatique", "Boutique alimentaire"] }),
    prix: j([
      { "@nom": "Gazole", "@id": "1", "@maj": "2026-09-14 12:06:54", "@valeur": "1.899" },
      { "@nom": "E10", "@id": "5", "@maj": "2026-09-14 12:06:54", "@valeur": "1.799" },
    ]),
    rupture: j({ "@nom": "GPLc", "@id": "4", "@debut": "2021-06-22 09:19:16", "@fin": "", "@type": "definitive" }),
  },
  {
    id: "35000002", latitude: "48.12", longitude: "-1.70", cp: "35000", pop: "R",
    adresse: "Route de Lorient", ville: "RENNES", horaires: null, services: null,
    prix: j({ "@nom": "Gazole", "@id": "1", "@maj": "2026-09-15 08:00:00", "@valeur": "1859" }),
    rupture: j([
      { "@nom": "E10", "@id": "5", "@debut": "2026-09-15 08:00:00", "@fin": "", "@type": "temporaire" },
      { "@nom": "SP98", "@id": "6", "@debut": "2026-09-01 08:00:00", "@fin": "2026-09-02 08:00:00", "@type": "temporaire" },
    ]),
  },
  {
    id: "35510001", latitude: "4817000", longitude: "-160000", cp: "35510", pop: "R",
    adresse: "ZA de la Rigourdière", ville: "CESSON-SÉVIGNÉ", horaires: null, services: null,
    prix: j([
      { "@nom": "Gazole", "@id": "1", "@maj": "2026-09-15 07:00:00", "@valeur": "1.949" },
      { "@nom": "E10", "@id": "5", "@maj": "2026-09-15 07:00:00", "@valeur": "1.749" },
    ]),
    rupture: null,
  },
  {
    id: "35300001", latitude: "4839000", longitude: "-116000", cp: "35300", pop: "A",
    adresse: "Aire de Fougères", ville: "FOUGERES", horaires: null, services: null,
    prix: j({ "@nom": "Gazole", "@id": "1", "@maj": "2026-09-15 07:00:00", "@valeur": "1.799" }), rupture: null,
  },
  {
    id: "20000001", latitude: "4192000", longitude: "873000", cp: "20000", pop: "R",
    adresse: "Cours Napoléon", ville: "AJACCIO", horaires: null, services: null,
    prix: j({ "@nom": "SP98", "@id": "6", "@maj": "2026-09-15 07:00:00", "@valeur": "2.099" }), rupture: null,
  },
  { id: "75000099", latitude: "", longitude: "", cp: "75001", adresse: "Sans coordonnées", ville: "PARIS" },
];

export function freshDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(join(import.meta.dirname, "../migrations/0001_init.sql"), "utf8"));
  return sqlite;
}

export function loadedDb(records: unknown[] = SAMPLE_RECORDS): DatabaseSync {
  const sqlite = freshDb();
  const plan = planSync(parseFeed(records), []);
  sqlite.exec(plan.statements.join("\n"));
  sqlite.exec(metaStatement({ last_success_at: new Date().toISOString(), data_updated_at: "2026-09-15T08:00:00+02:00", station_count: "5" }));
  return sqlite;
}
