/**
 * Référentiel des enseignes (data.gouv.fr, CSV enrichi par OpenStreetMap) :
 * identifiant officiel du point de vente -> enseigne normalisée.
 * Contenu communautaire, donc non fiable à 100 % : traité comme du texte à
 * afficher, et les entrées qui ressemblent à du bruit sont écartées.
 */
const MAX_NAME_LEN = 60;
const MAX_TOKEN_LEN = 24; // un « mot » plus long est plus probablement du bruit qu'une enseigne

function cleanName(raw: string): string | null {
  const name = raw.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_NAME_LEN);
  if (!name || name.split(" ").some((token) => token.length > MAX_TOKEN_LEN)) return null;
  return name;
}

/** Découpe une ligne CSV (séparateur « , », guillemets doublés), champs multi-lignes inclus. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseBrands(csv: string): Map<number, string> {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ""));
  const brands = new Map<number, string>();
  if (!header) return brands;
  const idCol = header.indexOf("id_station_officiel");
  const nameCol = header.indexOf("nom_normalise");
  if (idCol < 0 || nameCol < 0) return brands;
  for (const row of rows) {
    const id = /^\d+$/.test((row[idCol] ?? "").trim()) ? Number((row[idCol] ?? "").trim()) : null;
    const name = cleanName(row[nameCol] ?? "");
    if (id !== null && name) brands.set(id, name);
  }
  return brands;
}
