import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { loadedDb, sqliteD1 } from "./helpers";

const RENNES = "lat=48.1109&lon=-1.68365";
const env: any = {
  DB: sqliteD1(loadedDb()),
  ASSETS: { fetch: async () => new Response("<title>Ton-Carburant</title>") },
};
const ctx: any = { waitUntil: () => {} };
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://carburant.test${path}`, init), env, ctx);

beforeAll(() => {
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  vi.stubGlobal("fetch", async (url: URL) => {
    if (url.host === "down.test") return new Response("", { status: 502 });
    return Response.json({
      features: [{
        geometry: { type: "Point", coordinates: [-1.68365, 48.110899] },
        properties: { label: "Rennes", type: "municipality", postcode: "35000", context: "35, Ille-et-Vilaine, Bretagne" },
      }],
    });
  });
});

describe("API", () => {
  it("stations par rayon, plafonné au rayon max", async () => {
    const res = await call(`/api/stations?fuel=gazole&radius_km=10&${RENNES}`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body: any = await res.json();
    expect([body.count, body.radius_km, body.fuel]).toEqual([3, 10, "Gazole"]);
    const capped: any = await (await call(`/api/stations?radius_km=500&${RENNES}`)).json();
    expect(capped.radius_km).toBe(50);
  });

  it("stations par zone", async () => {
    const body: any = await (await call("/api/stations?area=dept:35")).json();
    expect([body.count, body.area.label]).toEqual([4, "Ille-et-Vilaine (35)"]);
  });

  it("erreurs", async () => {
    expect((await call(`/api/stations?fuel=kerosene&${RENNES}`)).status).toBe(400);
    expect((await call("/api/stations")).status).toBe(400);
    expect((await call("/api/stations?area=dept:99")).status).toBe(404);
    expect((await call("/api/stations/42")).status).toBe(404);
    expect((await call("/api/stations?lat=abc&lon=1")).status).toBe(422);
    const err: any = await (await call("/api/stations/42")).json();
    expect(err.detail).toBe("Station introuvable");
    expect((await call("/api/stations", { method: "POST" })).status).toBe(405);
  });

  it("fiche station, statut, config", async () => {
    const station: any = await (await call("/api/stations/35000001")).json();
    expect(station.address).toBe("1 Rue de Châtillon");
    const status: any = await (await call("/api/status")).json();
    expect([status.stations, status.stale, status.last_error]).toEqual([5, false, null]);
    const config: any = await (await call("/api/config")).json();
    expect(config.radius_options_km).toContain(config.default_radius_km);
    expect(config.fuels).toHaveLength(6);
  });

  it("géocodage : zones et communes", async () => {
    const area: any = await (await call("/api/geocode?q=Bretagne")).json();
    expect(area.results[0].area).toBe("region:bretagne");
    const city: any = await (await call("/api/geocode?q=Rennes")).json();
    expect(city.results[0].type).toBe("municipality");
    expect((await call("/api/geocode")).status).toBe(422);
  });

  it("le frontend passe par les assets", async () => {
    expect(await (await call("/")).text()).toContain("Ton-Carburant");
  });

  it("préflight CORS", async () => {
    const res = await call("/api/stations", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
