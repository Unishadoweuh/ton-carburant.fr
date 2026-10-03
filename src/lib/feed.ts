/**
 * Lecture du flux instantané v2 des prix des carburants, tel que publié par
 * data.economie.gouv.fr (export JSON du jeu « Prix des carburants en France -
 * Flux instantané - v2 »). C'est le XML officiel converti en JSON : attributs
 * préfixés par « @ », éléments uniques présentés comme objet (et non tableau),
 * et sous-arbres `horaires`, `services`, `prix`, `rupture` sérialisés en
 * chaînes JSON.
 *
 * Coordonnées en degrés × 100 000 (parfois décimales), prix en euros (l'ancien
 * format en millièmes est aussi accepté), dates en heure de Paris.
 * Un carburant est soit dans `prix`, soit dans `rupture` ; une rupture avec
 * date de fin est terminée. L'absence d'un carburant n'est pas une rupture.
 */
import { normalizeFuel } from "./fuels";
import type { DayHours } from "./hours";
import { parisIso } from "./paris";

export interface PriceInfo {
  price: number;
  updated_at: string | null;
}
export interface RuptureInfo {
  kind: "temporaire" | "definitive";
  since: string | null;
}
export interface Station {
  id: number;
  lat: number;
  lon: number;
  cp: string;
  city: string;
  address: string;
  pop: string | null;
  brand: string | null;
  automate_24_24: boolean;
  hours: DayHours[] | null;
  services: string[];
  prices: Record<string, PriceInfo>;
  ruptures: Record<string, RuptureInfo>;
}

export class FeedError extends Error {}

type Json = Record<string, any>;

/** Élément XML-en-JSON : absent, objet ou tableau -> tableau. */
const asList = (value: unknown): Json[] => (Array.isArray(value) ? value : value && typeof value === "object" ? [value as Json] : []);

/** Sous-arbre sérialisé en chaîne JSON (ou déjà décodé). */
function sub(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toPrice(value: unknown): number | null {
  let price = Number.parseFloat(String(value));
  if (!Number.isFinite(price)) return null;
  if (price > 100) price /= 1000; // ancien format en millièmes d'euro
  return price > 0 && price < 10 ? Math.round(price * 1000) / 1000 : null;
}

function hhmm(value: unknown): string | null {
  const m = /^(\d{1,2})[.:h](\d{2})$/.exec(String(value ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

const LOWERCASE_WORDS = new Set(["de", "du", "des", "la", "le", "les", "sur", "sous", "en", "et", "au", "aux", "l", "d", "lès", "lez"]);

/** "SAINT-JEAN-D'ILLAC" -> "Saint-Jean-d'Illac". */
export function prettyCity(raw: string): string {
  const parts = (raw ?? "").trim().toLowerCase().split(/([\s\-']+)/);
  let first = true;
  return parts
    .map((part) => {
      if (!part || /^[\s\-']+$/.test(part)) return part;
      const out = !first && LOWERCASE_WORDS.has(part) ? part : part.charAt(0).toUpperCase() + part.slice(1);
      first = false;
      return out;
    })
    .join("");
}

/** Adresses saisies tout en majuscules -> casse normale ; les autres sont gardées telles quelles. */
const prettyAddress = (raw: string) => (raw === raw.toUpperCase() && raw !== raw.toLowerCase() ? prettyCity(raw) : raw);

const clean = (value: unknown) => String(value ?? "").split(/\s+/).filter(Boolean).join(" ");

export function parseStation(record: Json): Station | null {
  const id = Number.parseInt(String(record.id ?? ""), 10);
  let lat = Number(record.latitude);
  let lon = Number(record.longitude);
  if (!Number.isInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lon) || record.latitude === "" || record.longitude === "") return null;
  if (Math.abs(lat) > 90) [lat, lon] = [lat / 100_000, lon / 100_000]; // degrés × 100 000
  if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const prices: Record<string, PriceInfo> = {};
  for (const node of asList(sub(record.prix))) {
    const fuel = normalizeFuel(node["@nom"]);
    const price = toPrice(node["@valeur"]);
    if (fuel && price !== null) prices[fuel] = { price, updated_at: parisIso(node["@maj"]) };
  }

  const ruptures: Record<string, RuptureInfo> = {};
  for (const node of asList(sub(record.rupture))) {
    const fuel = normalizeFuel(node["@nom"]);
    if (!fuel || node["@fin"]) continue; // une date de fin = rupture terminée
    const kind = node["@type"] === "temporaire" ? "temporaire" : "definitive";
    if (kind === "definitive" && fuel in prices) continue; // un prix déclaré prime
    ruptures[fuel] = { kind, since: parisIso(node["@debut"]) };
  }

  let hours: DayHours[] | null = null;
  let automate = false;
  const horaires = sub(record.horaires) as Json | null;
  if (horaires && typeof horaires === "object") {
    automate = horaires["@automate-24-24"] === "1";
    const days = asList(horaires.jour).map((jour) => {
      const slots = asList(jour.horaire)
        .map((h) => [hhmm(h["@ouverture"]), hhmm(h["@fermeture"])] as const)
        .filter((slot): slot is readonly [string, string] => !!slot[0] && !!slot[1])
        .map(([a, b]): [string, string] => [a, b]);
      return { day: Number(jour["@id"]) || 0, closed: jour["@ferme"] === "1", slots };
    });
    days.sort((a, b) => a.day - b.day);
    hours = days.length ? days : null;
  }

  return {
    id,
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    cp: clean(record.cp),
    city: prettyCity(clean(record.ville)),
    address: prettyAddress(clean(record.adresse)),
    pop: record.pop || null,
    brand: null,
    automate_24_24: automate,
    hours,
    services: parseServices(record.services),
    prices,
    ruptures,
  };
}

function parseServices(raw: unknown): string[] {
  const tree = sub(raw) as Json | null;
  const list = tree?.service;
  const items = Array.isArray(list) ? list : list !== undefined && list !== null ? [list] : [];
  return items.map(clean).filter(Boolean);
}

export function parseFeed(records: unknown): Station[] {
  if (!Array.isArray(records)) throw new FeedError("format de flux inattendu (JSON non tabulaire)");
  return records.map((r) => parseStation(r as Json)).filter((s): s is Station => s !== null);
}

/** Date de mise à jour la plus récente, en ignorant les dates aberrantes (futures). */
export function latestPriceDate(stations: Station[]): string | null {
  const horizon = Date.now() + 86_400_000;
  let best: { ms: number; iso: string } | null = null;
  for (const s of stations) {
    for (const p of Object.values(s.prices)) {
      if (!p.updated_at) continue;
      const ms = Date.parse(p.updated_at);
      if (ms <= horizon && (!best || ms > best.ms)) best = { ms, iso: new Date(ms).toISOString() };
    }
  }
  return best?.iso ?? null;
}
