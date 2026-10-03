/**
 * Import du flux des prix des carburants dans D1 (exécuté par GitHub Actions
 * toutes les 10 minutes, voir .github/workflows/ingest.yml).
 *
 *   npm run ingest                    # base D1 distante
 *   npm run ingest:local              # base D1 locale (wrangler dev)
 *   tsx ingest/run.ts --file flux.json --dry-run   # sans accès à la base
 *
 * En cas d'échec, les données précédentes sont conservées et l'erreur est
 * enregistrée dans `meta` (affichée par /api/status).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { parseBrands } from "../src/lib/brands";
import { FeedError, latestPriceDate, parseFeed } from "../src/lib/feed";
import { metaStatement, planSync, type ExistingRow } from "./core";

const FEED_URL =
  process.env.FEED_URL ??
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json";
const BRANDS_URL =
  process.env.BRANDS_URL ?? "https://www.data.gouv.fr/api/1/datasets/r/0207ded0-2d19-47af-b1a6-62915ec1b721";
const MIN_STATIONS = Number(process.env.INGEST_MIN_STATIONS ?? 1000);
const D1_BINDING = "DB";
const CHUNK = 400; // instructions par fichier SQL envoyé à D1
const TMP = join(import.meta.dirname, ".tmp");
const USER_AGENT = "Ton-Carburant/1.0 (+https://toncarburant.fr)";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const target = flag("--local") ? "--local" : "--remote";
const dryRun = flag("--dry-run");

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  return body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
}

function wrangler(...extra: string[]): string {
  return execFileSync("npx", ["wrangler", "d1", "execute", D1_BINDING, target, ...extra], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function query(sql: string): any[] {
  const out = wrangler("--json", "--command", sql);
  return JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? [];
}

function execute(statements: string[]): void {
  mkdirSync(TMP, { recursive: true });
  for (let i = 0; i < statements.length; i += CHUNK) {
    const file = join(TMP, `chunk-${i / CHUNK}.sql`);
    writeFileSync(file, statements.slice(i, i + CHUNK).join("\n") + "\n");
    wrangler("--file", file, "--yes");
  }
  rmSync(TMP, { recursive: true, force: true });
}

async function loadBrands(): Promise<Map<number, string> | null> {
  if (!BRANDS_URL) return null;
  try {
    return parseBrands(new TextDecoder().decode(await download(BRANDS_URL)));
  } catch (error) {
    console.warn(`Référentiel des enseignes indisponible, enseignes actuelles conservées : ${error}`);
    return null;
  }
}

async function main(): Promise<void> {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  try {
    const file = option("--file");
    const payload = file ? readFileSync(file) : await download(FEED_URL);
    const stations = parseFeed(JSON.parse(new TextDecoder().decode(payload)));
    if (stations.length < MIN_STATIONS) {
      throw new FeedError(`flux incomplet : ${stations.length} stations (minimum attendu ${MIN_STATIONS})`);
    }

    const existing: ExistingRow[] = dryRun ? [] : query("SELECT id, h, brand FROM stations");
    const brands = await loadBrands();
    const previousBrand = new Map(existing.map((row) => [row.id, row.brand]));
    for (const station of stations) {
      // Référentiel injoignable : on garde l'enseigne déjà en base plutôt que de la perdre.
      station.brand = brands ? (brands.get(station.id) ?? null) : (previousBrand.get(station.id) ?? null);
    }

    const plan = planSync(stations, existing);
    console.log(
      `${stations.length} stations : ${plan.inserted} nouvelles, ${plan.updated} modifiées, ` +
        `${plan.unchanged} inchangées, ${plan.deleted} supprimées`,
    );
    if (dryRun) return;

    const meta = metaStatement({
      last_attempt_at: now,
      last_success_at: now,
      last_error: "",
      data_updated_at: latestPriceDate(stations) ?? "",
      station_count: String(stations.length),
    });
    execute([...plan.statements, meta]);
  } catch (error) {
    console.error(`Import du flux échoué, données précédentes conservées : ${error}`);
    if (!dryRun) {
      try {
        execute([metaStatement({ last_attempt_at: now, last_error: String(error).slice(0, 500) })]);
      } catch {
        console.error("Impossible d'enregistrer l'erreur d'import");
      }
    }
    process.exit(1);
  }
}

await main();
