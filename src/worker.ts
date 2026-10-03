/** Worker Cloudflare : API REST de Ton-Carburant (le frontend est servi par les Static Assets). */
import { loadSettings, publicConfig, type Env } from "./config";
import { findAreas, normalize, resolveArea } from "./lib/areas";
import { normalizeFuel } from "./lib/fuels";
import { geocode } from "./lib/geocode";
import { getStation, searchStations } from "./lib/search";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  Vary: "Accept-Encoding",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=60" : "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function numberParam(params: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new HttpError(422, `Paramètre ${name} invalide`);
  return value;
}

const ageSeconds = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : (Date.now() - ms) / 1000;
};

async function handle(request: Request, env: Env): Promise<Response> {
  const settings = loadSettings(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const params = url.searchParams;

  if (path === "/api/config") return json(publicConfig(settings));

  if (path === "/api/status") {
    const [count, metaRows] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM stations").bind().first<{ n: number }>(),
      env.DB.prepare("SELECT key, value FROM meta").bind().all<{ key: string; value: string }>(),
    ]);
    const meta = Object.fromEntries(metaRows.results.map((r) => [r.key, r.value]));
    const age = ageSeconds(meta.last_success_at);
    return json({
      stations: count?.n ?? 0,
      data_updated_at: meta.data_updated_at || null,
      last_success_at: meta.last_success_at || null,
      last_attempt_at: meta.last_attempt_at || null,
      last_error: meta.last_error || null,
      stale: age === null || age > Math.max(3 * settings.intervalMinutes * 60, 45 * 60),
      interval_minutes: settings.intervalMinutes,
    });
  }

  if (path === "/api/geocode") {
    const q = params.get("q") ?? "";
    if (q.length < 1 || q.length > 200) throw new HttpError(422, "Paramètre q invalide");
    const areas = findAreas(q);
    const places = await geocode(q, settings.geocoderUrls);
    if (places === null && !areas.length) throw new HttpError(503, "Service de géocodage momentanément indisponible");
    const found = places ?? [];
    // "Paris" : la commune passe avant le département homonyme.
    const sameCity = found.length > 0 && found[0].type === "municipality" && normalize(found[0].label) === normalize(q);
    const results = areas.length && areas[0].exact && !sameCity ? [...areas, ...found] : [...found, ...areas];
    return json({ results: results.slice(0, 8) });
  }

  if (path === "/api/stations") {
    const fuel = normalizeFuel(params.get("fuel") ?? "Gazole");
    if (!fuel) throw new HttpError(400, `Carburant inconnu : ${params.get("fuel")}`);
    const area = params.get("area");
    if (area) {
      if (area.length > 64) throw new HttpError(422, "Paramètre area invalide");
      const resolved = resolveArea(area);
      if (!resolved) throw new HttpError(404, `Zone inconnue : ${area}`);
      const result = await searchStations(env.DB, fuel, { departements: resolved.departements });
      return json({ ...result, area: { key: resolved.key, label: resolved.label } });
    }
    const lat = numberParam(params, "lat", -90, 90);
    const lon = numberParam(params, "lon", -180, 180);
    const requested = numberParam(params, "radius_km", Number.MIN_VALUE, Infinity);
    if (lat === undefined || lon === undefined) throw new HttpError(400, "Paramètres lat et lon, ou area, requis");
    const radius = Math.min(requested || settings.defaultRadius, settings.maxRadius);
    const result = await searchStations(env.DB, fuel, { lat, lon, radiusKm: radius });
    return json({ ...result, radius_km: radius, center: { lat, lon } });
  }

  const match = /^\/api\/stations\/(\d+)$/.exec(path);
  if (match) {
    const found = await getStation(env.DB, Number(match[1]));
    if (!found) throw new HttpError(404, "Station introuvable");
    return json(found);
  }

  throw new HttpError(404, "Not Found");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ detail: "Method Not Allowed" }, 405);
    }
    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // Cache edge : soulage D1 (5 M de lectures/jour sur l'offre gratuite) et le CPU du Worker.
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(request.url, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const response = await handle(request, env);
      if (response.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      if (error instanceof HttpError) return json({ detail: error.message }, error.status);
      console.error(error);
      return json({ detail: "Erreur interne" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
