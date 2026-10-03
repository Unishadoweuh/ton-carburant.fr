/** Départements et régions : recherche par nom/code et plages de codes postaux. */
import { DEPARTEMENTS, REGIONS } from "./areas-data";

export { DEPARTEMENTS, REGIONS };

// Codes postaux corses : 200xx/201xx (Corse-du-Sud), 202xx/206xx (Haute-Corse).
const CP_PREFIXES: Record<string, string[]> = { "2A": ["200", "201"], "2B": ["202", "206"] };

export interface AreaResult {
  label: string;
  context: string;
  type: "departement" | "region";
  area: string;
  exact: boolean;
}

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const slug = (name: string) => normalize(name).replace(/ /g, "-");

const REGION_BY_SLUG = new Map(Object.keys(REGIONS).map((name) => [slug(name), name]));

/** Plages [début, fin) de codes postaux, exploitables par l'index sur `cp`. */
export function cpRanges(deptCode: string): [string, string][] {
  const prefixes = CP_PREFIXES[deptCode] ?? [deptCode];
  return prefixes.map((p) => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)]);
}

const deptResult = (code: string, exact: boolean): AreaResult => ({
  label: `${DEPARTEMENTS[code]} (${code})`,
  context: "Département entier",
  type: "departement",
  area: `dept:${code}`,
  exact,
});

const regionResult = (name: string, exact: boolean): AreaResult => ({
  label: name,
  context: `Région entière · ${REGIONS[name].length} départements`,
  type: "region",
  area: `region:${slug(name)}`,
  exact,
});

const matches = (query: string, name: string) =>
  name.startsWith(query) || (query.length >= 4 && ` ${name}`.includes(` ${query}`));

export function findAreas(query: string, limit = 4): AreaResult[] {
  const q = normalize(query);
  if (!q) return [];
  const results: AreaResult[] = [];
  const code = query.trim().toUpperCase();
  if (code in DEPARTEMENTS) results.push(deptResult(code, true));
  if (q.length >= 3) {
    for (const name of Object.keys(REGIONS)) {
      if (matches(q, normalize(name))) results.push(regionResult(name, normalize(name) === q));
    }
    for (const [dept, name] of Object.entries(DEPARTEMENTS)) {
      if (dept !== code && matches(q, normalize(name))) results.push(deptResult(dept, normalize(name) === q));
    }
  }
  results.sort((a, b) => Number(!a.exact) - Number(!b.exact)); // tri stable : les exacts d'abord
  return results.slice(0, limit);
}

export interface ResolvedArea {
  key: string;
  label: string;
  departements: string[];
}

/** "dept:35" ou "region:bretagne" -> { label, departements }. */
export function resolveArea(key: string): ResolvedArea | null {
  const sep = key.indexOf(":");
  const kind = sep < 0 ? key : key.slice(0, sep);
  const value = sep < 0 ? "" : key.slice(sep + 1);
  if (kind === "dept" && value.toUpperCase() in DEPARTEMENTS) {
    const code = value.toUpperCase();
    return { key: `dept:${code}`, label: `${DEPARTEMENTS[code]} (${code})`, departements: [code] };
  }
  const region = kind === "region" ? REGION_BY_SLUG.get(value.toLowerCase()) : undefined;
  if (region) return { key: `region:${value.toLowerCase()}`, label: region, departements: [...REGIONS[region]] };
  return null;
}
