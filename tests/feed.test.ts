import { describe, expect, it } from "vitest";
import { parseBrands } from "../src/lib/brands";
import { FeedError, parseFeed, prettyCity, latestPriceDate } from "../src/lib/feed";
import { parisIso } from "../src/lib/paris";
import { SAMPLE_RECORDS } from "./helpers";

describe("flux", () => {
  const stations = Object.fromEntries(parseFeed(SAMPLE_RECORDS).map((s) => [s.id, s]));

  it("coordonnées, prix et ruptures", () => {
    expect(Object.keys(stations).map(Number).sort()).toEqual([20000001, 35000001, 35000002, 35300001, 35510001]); // sans coordonnées ignorée
    const rennes = stations[35000001];
    expect([rennes.lat, rennes.lon]).toEqual([48.1109, -1.68365]);
    expect(rennes.address).toBe("1 Rue de Châtillon");
    expect(rennes.prices.Gazole).toEqual({ price: 1.899, updated_at: "2026-09-14T12:06:54+02:00" });
    expect(rennes.ruptures).toEqual({ GPLc: { kind: "definitive", since: "2021-06-22T09:19:16+02:00" } });
    expect(rennes.automate_24_24).toBe(true);
    expect(rennes.hours?.map((d) => d.day)).toEqual([1, 2]);
    expect(rennes.hours?.[0].slots).toEqual([["07:00", "21:00"]]);
    expect(rennes.services).toEqual(["Lavage automatique", "Boutique alimentaire"]);

    const lorient = stations[35000002];
    expect([lorient.lat, lorient.lon]).toEqual([48.12, -1.7]); // coordonnées déjà décimales
    expect(lorient.prices.Gazole.price).toBe(1.859); // ancien format en millièmes
    expect(Object.keys(lorient.ruptures)).toEqual(["E10"]); // la rupture SP98 terminée est ignorée
    expect(lorient.hours).toBeNull();
  });

  it("un service unique (chaîne) est accepté", () => {
    const [s] = parseFeed([{ ...SAMPLE_RECORDS[0], services: JSON.stringify({ service: "Automate CB 24/24" }) }]);
    expect(s.services).toEqual(["Automate CB 24/24"]);
  });

  it("refuse un flux qui n'est pas une liste", () => {
    expect(() => parseFeed({ error: "x" })).toThrow(FeedError);
  });

  it("casse des villes et adresses", () => {
    expect(prettyCity("CESSON-SÉVIGNÉ")).toBe("Cesson-Sévigné");
    expect(prettyCity("SAINT-JEAN-D'ILLAC")).toBe("Saint-Jean-d'Illac");
    expect(prettyCity("LE BARP")).toBe("Le Barp");
    expect(stations[35510001].address).toBe("ZA de la Rigourdière");
  });

  it("heure de Paris, été et hiver", () => {
    expect(parisIso("2026-09-14 12:06:54")).toBe("2026-09-14T12:06:54+02:00");
    expect(parisIso("2026-01-14 12:06:54")).toBe("2026-01-14T12:06:54+01:00");
    expect(parisIso("")).toBeNull();
  });

  it("date de données la plus récente", () => {
    expect(latestPriceDate(Object.values(stations))).toBe("2026-09-15T06:00:00.000Z");
  });
});

describe("enseignes", () => {
  it("parse le CSV et écarte le bruit", () => {
    const csv = [
      "id_station_officiel,nom_normalise,adresse,ville,code_postal,latitude_osm,longitude_osm,source_enrichissement",
      '35000001,Carrefour Market,"1 Rue, de Châtillon",Rennes,35000,48.11,-1.68,OpenStreetMap',
      "35000002,TotalEnergies,Route de Lorient,Rennes,35000,48.12,-1.70,OpenStreetMap",
      "35510001,,ZA de la Rigourdière,Cesson-Sévigné,35510,48.17,-1.60,OpenStreetMap",
      "notanid,Avia,x,x,00000,0,0,OpenStreetMap",
      "20000001,DELETE TAG aechohve0Eire4ooyeyaey1gieme0xoo,Cours Napoléon,Ajaccio,20000,41.92,8.73,OpenStreetMap",
    ].join("\n");
    expect(Object.fromEntries(parseBrands(csv))).toEqual({ 35000001: "Carrefour Market", 35000002: "TotalEnergies" });
  });
});
