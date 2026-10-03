/** Géocodage via l'API Adresse (Géoplateforme IGN, puis ancien domaine BAN en secours). */

const USER_AGENT = "Ton-Carburant/1.0 (+https://toncarburant.fr)";

export interface Place {
  label: string;
  context: string;
  type: string;
  lat: number;
  lon: number;
}

function parseFeature(feature: any): Place | null {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lon, lat] = coords.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const props = feature.properties ?? {};
  const type = props.type || "address";
  let context = props.context || "";
  if (type === "municipality" && props.postcode) context = `${props.postcode} · ${context}`;
  return { label: props.label || props.name || "", context, type, lat, lon };
}

/** Résultats géocodés, [] si la requête est trop courte, null si aucun service n'a répondu. */
export async function geocode(
  query: string,
  urls: string[],
  fetcher: typeof fetch = fetch,
  limit = 6,
): Promise<Place[] | null> {
  const q = query.split(/\s+/).filter(Boolean).join(" ").slice(0, 200);
  // L'API refuse les requêtes de moins de 3 caractères ou ne commençant pas par un alphanumérique.
  if (q.length < 3 || !/^[\p{L}\p{N}]/u.test(q)) return [];
  for (const base of urls) {
    try {
      const url = new URL(base);
      url.search = new URLSearchParams({ q, limit: String(limit), autocomplete: "1" }).toString();
      const response = await fetcher(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        // Cache edge de Cloudflare (ignoré ailleurs) : un même libellé n'est géocodé qu'une fois par jour.
        cf: { cacheTtl: 86400, cacheEverything: true },
      } as RequestInit);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { features?: unknown[] };
      return (body.features ?? []).map(parseFeature).filter((p): p is Place => p !== null);
    } catch (error) {
      console.warn(`Géocodeur ${base} indisponible : ${error}`);
    }
  }
  return null;
}
