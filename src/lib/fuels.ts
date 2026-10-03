/** Carburants publiés dans le flux officiel. "GPLc" est le nom du flux, affiché "GPL". */
export const FUEL_CODES = ["Gazole", "SP95", "SP98", "E10", "E85", "GPLc"] as const;
export type FuelCode = (typeof FUEL_CODES)[number];

export const FUEL_LABELS: Record<FuelCode, string> = {
  Gazole: "Gazole",
  SP95: "SP95",
  SP98: "SP98",
  E10: "E10",
  E85: "E85",
  GPLc: "GPL",
};

const ALIASES: Record<string, FuelCode> = {
  gazole: "Gazole",
  sp95: "SP95",
  sp98: "SP98",
  e10: "E10",
  "sp95-e10": "E10",
  e85: "E85",
  gplc: "GPLc",
  gpl: "GPLc",
};

export function normalizeFuel(name: string | null | undefined): FuelCode | null {
  return ALIASES[(name ?? "").trim().toLowerCase()] ?? null;
}
