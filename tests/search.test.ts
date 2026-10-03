import { describe, expect, it } from "vitest";
import { resolveArea } from "../src/lib/areas";
import { getStation, searchStations } from "../src/lib/search";
import { loadedDb, sqliteD1 } from "./helpers";

const RENNES = { lat: 48.1109, lon: -1.68365 };
const db = sqliteD1(loadedDb());

describe("recherche", () => {
  it("par rayon, triée par prix", async () => {
    const result = await searchStations(db, "Gazole", { radiusKm: 10, ...RENNES });
    expect(result.stations.map((s) => s.id)).toEqual([35000002, 35000001, 35510001]); // Fougères hors rayon
    expect(result.stations[0].distance_km).toBeLessThan(2);
    expect(result.stats).toEqual({ min: 1.859, max: 1.949, median: 1.899 });
  });

  it("ruptures en fin de liste, absents comptés", async () => {
    const e10 = await searchStations(db, "E10", { radiusKm: 10, ...RENNES });
    expect(e10.stations.map((s) => [s.id, s.status])).toEqual([[35510001, "ok"], [35000001, "ok"], [35000002, "rupture"]]);
    expect([e10.rupture_count, e10.absent_count]).toEqual([1, 0]);

    const gpl = await searchStations(db, "GPLc", { radiusKm: 10, ...RENNES });
    expect([gpl.count, gpl.absent_count, gpl.stats]).toEqual([0, 3, null]);
  });

  it("par zone", async () => {
    expect((await searchStations(db, "Gazole", { departements: ["35"] })).count).toBe(4);
    const corse = resolveArea("region:corse")!;
    expect((await searchStations(db, "SP98", { departements: corse.departements })).count).toBe(1);
  });

  it("fiche station", async () => {
    const station = await getStation(db, 35000001);
    expect(station!.fuels.map((f) => [f.code, f.status])).toEqual([["Gazole", "ok"], ["E10", "ok"], ["GPLc", "non_distribue"]]);
    expect(station!.automate_24_24).toBe(true);
    expect(station!.city).toBe("Rennes");
    expect(station!.services).toEqual(["Lavage automatique", "Boutique alimentaire"]);
    expect(await getStation(db, 1)).toBeNull();
  });
});
