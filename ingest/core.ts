/**
 * Cœur de l'import (pur, testable) : empreintes, différentiel et génération du
 * SQL. Seules les stations nouvelles ou modifiées sont réécrites, pour rester
 * sous la limite de 100 000 lignes écrites par jour de D1 (offre gratuite).
 */
import { createHash } from "node:crypto";
import type { Station } from "../src/lib/feed";

export interface ExistingRow {
  id: number;
  h: string;
  brand: string | null;
}

export const STATION_COLUMNS = [
  "id", "lat", "lon", "cp", "city", "address", "pop", "brand",
  "automate_24_24", "hours_json", "services_json", "prices_json", "ruptures_json", "h",
] as const;

export function stationRecord(s: Station) {
  const record = {
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    cp: s.cp,
    city: s.city,
    address: s.address,
    pop: s.pop,
    brand: s.brand,
    automate_24_24: s.automate_24_24 ? 1 : 0,
    hours_json: s.hours ? JSON.stringify(s.hours) : null,
    services_json: JSON.stringify(s.services),
    prices_json: JSON.stringify(s.prices),
    ruptures_json: JSON.stringify(s.ruptures),
  };
  const h = createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 16);
  return { ...record, h };
}

/** Littéral SQL sûr : texte entre apostrophes doublées, sans octet NUL. */
export function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`valeur numérique invalide : ${value}`);
    return String(value);
  }
  return `'${value.replace(/\0/g, "").replace(/'/g, "''")}'`;
}

export function upsertStatement(record: ReturnType<typeof stationRecord>): string {
  const values = STATION_COLUMNS.map((c) => sqlValue(record[c]));
  const updates = STATION_COLUMNS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
  return (
    `INSERT INTO stations (${STATION_COLUMNS.join(", ")}) VALUES (${values.join(", ")}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")};`
  );
}

export function metaStatement(values: Record<string, string>): string {
  return Object.entries(values)
    .map(
      ([key, value]) =>
        `INSERT INTO meta (key, value) VALUES (${sqlValue(key)}, ${sqlValue(value)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    )
    .join("\n");
}

export interface SyncPlan {
  statements: string[];
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

/** Compare le flux à l'état de la base et produit les instructions nécessaires. */
export function planSync(stations: Station[], existing: ExistingRow[]): SyncPlan {
  const known = new Map(existing.map((row) => [row.id, row.h]));
  const seen = new Set<number>();
  const statements: string[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const station of stations) {
    if (seen.has(station.id)) continue; // doublon dans le flux : le premier gagne
    seen.add(station.id);
    const record = stationRecord(station);
    const previous = known.get(station.id);
    if (previous === record.h) {
      unchanged++;
      continue;
    }
    previous === undefined ? inserted++ : updated++;
    statements.push(upsertStatement(record));
  }
  const gone = existing.map((r) => r.id).filter((id) => !seen.has(id));
  for (let i = 0; i < gone.length; i += 100) {
    statements.push(`DELETE FROM stations WHERE id IN (${gone.slice(i, i + 100).join(", ")});`);
  }
  return { statements, inserted, updated, unchanged, deleted: gone.length };
}
