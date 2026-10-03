/** Recherche de stations : rayon autour d'un point ou zone administrative. */
import { cpRanges } from "./areas";
import { FUEL_CODES, FUEL_LABELS } from "./fuels";
import { openNow, type DayHours } from "./hours";
import { parisNow, type ParisNow } from "./paris";
import type { PriceInfo, RuptureInfo } from "./feed";

/** Sous-ensemble de D1Database réellement utilisé (permet de tester avec node:sqlite). */
export interface Db {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

export interface StationRow {
  id: number;
  lat: number;
  lon: number;
  cp: string;
  city: string;
  address: string;
  pop: string | null;
  brand: string | null;
  automate_24_24: number;
  hours_json: string | null;
  services_json?: string;
  prices_json: string;
  ruptures_json: string;
}

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEGREE = 111.195;
const LIST_COLUMNS = "id, lat, lon, cp, city, address, pop, brand, automate_24_24, hours_json, prices_json, ruptures_json";

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

type Candidate = { row: StationRow; distance: number | null };

async function withinRadius(db: Db, lat: number, lon: number, radiusKm: number): Promise<Candidate[]> {
  // 1) boîte englobante via l'index (lat, lon), 2) distance exacte sur les seuls candidats
  const dlat = radiusKm / KM_PER_DEGREE;
  const dlon = radiusKm / (KM_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM stations WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`)
    .bind(lat - dlat, lat + dlat, lon - dlon, lon + dlon)
    .all<StationRow>();
  const out: Candidate[] = [];
  for (const row of results) {
    const distance = haversineKm(lat, lon, row.lat, row.lon);
    if (distance <= radiusKm) out.push({ row, distance });
  }
  return out;
}

async function inDepartements(db: Db, departements: string[]): Promise<Candidate[]> {
  const ranges = departements.flatMap(cpRanges);
  if (!ranges.length) return [];
  const where = ranges.map(() => "(cp >= ? AND cp < ?)").join(" OR ");
  const { results } = await db
    .prepare(`SELECT ${LIST_COLUMNS} FROM stations WHERE ${where}`)
    .bind(...ranges.flat())
    .all<StationRow>();
  return results.map((row) => ({ row, distance: null }));
}

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function stationBase(row: StationRow, now: ParisNow) {
  return {
    id: row.id,
    lat: row.lat,
    lon: row.lon,
    address: row.address,
    city: row.city,
    cp: row.cp,
    brand: row.brand,
    highway: row.pop === "A",
    automate_24_24: !!row.automate_24_24,
    open_now: openNow(parse<DayHours[] | null>(row.hours_json, null), now),
  };
}

const median = (sorted: number[]) => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface SearchOptions {
  lat?: number;
  lon?: number;
  radiusKm?: number;
  departements?: string[];
  now?: Date;
}

export async function searchStations(db: Db, fuel: string, opts: SearchOptions) {
  let candidates: Candidate[];
  if (opts.departements) candidates = await inDepartements(db, opts.departements);
  else if (opts.lat !== undefined && opts.lon !== undefined && opts.radiusKm) {
    candidates = await withinRadius(db, opts.lat, opts.lon, opts.radiusKm);
  } else throw new Error("indiquer une position et un rayon, ou des départements");

  const now = parisNow(opts.now);
  const available: any[] = [];
  const outOfStock: any[] = [];
  let absent = 0;
  for (const { row, distance } of candidates) {
    const prices = parse<Record<string, PriceInfo>>(row.prices_json, {});
    const ruptures = parse<Record<string, RuptureInfo>>(row.ruptures_json, {});
    const item: any = {
      ...stationBase(row, now),
      distance_km: distance === null ? null : Math.round(distance * 100) / 100,
      prices: Object.fromEntries(Object.entries(prices).map(([code, p]) => [code, p.price])),
      status: "ok",
      price: null,
      price_updated_at: null,
    };
    const rupture = ruptures[fuel];
    if (rupture && rupture.kind === "temporaire") {
      item.status = "rupture";
      item.rupture_since = rupture.since;
      outOfStock.push(item);
    } else if (fuel in prices) {
      item.price = prices[fuel].price;
      item.price_updated_at = prices[fuel].updated_at;
      available.push(item);
    } else absent++; // carburant non distribué ou non déclaré
  }

  available.sort((a, b) => a.price - b.price || (a.distance_km ?? 0) - (b.distance_km ?? 0));
  outOfStock.sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
  const values = available.map((s) => s.price).sort((a, b) => a - b);
  return {
    fuel,
    count: available.length,
    rupture_count: outOfStock.length,
    absent_count: absent,
    stats: values.length
      ? { min: values[0], max: values[values.length - 1], median: Math.round(median(values) * 1000) / 1000 }
      : null,
    stations: [...available, ...outOfStock],
  };
}

export async function getStation(db: Db, stationId: number, date = new Date()) {
  const row = await db.prepare("SELECT * FROM stations WHERE id = ?").bind(stationId).first<StationRow>();
  if (!row) return null;
  const prices = parse<Record<string, PriceInfo>>(row.prices_json, {});
  const ruptures = parse<Record<string, RuptureInfo>>(row.ruptures_json, {});

  const fuels = [];
  for (const code of FUEL_CODES) {
    const price = prices[code];
    const rupture = ruptures[code];
    let status: string;
    if (rupture && rupture.kind === "temporaire") status = "rupture";
    else if (price) status = "ok";
    else if (rupture) status = "non_distribue";
    else continue;
    fuels.push({
      code,
      label: FUEL_LABELS[code],
      status,
      price: price ? price.price : null,
      updated_at: price ? price.updated_at : null,
      rupture_since: rupture ? rupture.since : null,
    });
  }

  return {
    ...stationBase(row, parisNow(date)),
    hours: parse<DayHours[] | null>(row.hours_json, null),
    services: parse<string[]>(row.services_json, []),
    fuels,
  };
}
