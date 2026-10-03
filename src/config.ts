/** Configuration pilotée par les variables du Worker (`[vars]` de wrangler.toml). */
import { FUEL_CODES, FUEL_LABELS } from "./lib/fuels";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DEFAULT_RADIUS_KM?: string;
  MAX_RADIUS_KM?: string;
  RADIUS_OPTIONS_KM?: string;
  INGEST_INTERVAL_MINUTES?: string;
  GEOCODER_URLS?: string;
  TILE_URL?: string;
  TILE_ATTRIBUTION?: string;
  TILE_MAX_ZOOM?: string;
}

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value && value.trim() && Number.isFinite(n) ? n : fallback;
};

const list = (value: string | undefined, fallback: string) =>
  (value && value.trim() ? value : fallback).split(",").map((s) => s.trim()).filter(Boolean);

export function loadSettings(env: Partial<Env>) {
  const maxRadius = num(env.MAX_RADIUS_KM, 50);
  const defaultRadius = Math.min(num(env.DEFAULT_RADIUS_KM, 10), maxRadius);
  const options = [
    ...new Set([...list(env.RADIUS_OPTIONS_KM, "5,10,15,20,30,50").map(Number).filter((x) => x > 0 && x <= maxRadius), defaultRadius]),
  ].sort((a, b) => a - b);
  return {
    defaultRadius,
    maxRadius,
    options,
    intervalMinutes: Math.max(5, num(env.INGEST_INTERVAL_MINUTES, 10)),
    geocoderUrls: list(env.GEOCODER_URLS, "https://data.geopf.fr/geocodage/search,https://api-adresse.data.gouv.fr/search/"),
    tileUrl: env.TILE_URL?.trim() || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution:
      env.TILE_ATTRIBUTION?.trim() || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    tileMaxZoom: num(env.TILE_MAX_ZOOM, 19),
  };
}

export const publicConfig = (s: ReturnType<typeof loadSettings>) => ({
  default_radius_km: s.defaultRadius,
  max_radius_km: s.maxRadius,
  radius_options_km: s.options,
  fuels: FUEL_CODES.map((code) => ({ code, label: FUEL_LABELS[code] })),
  tile_url: s.tileUrl,
  tile_attribution: s.tileAttribution,
  tile_max_zoom: s.tileMaxZoom,
});
