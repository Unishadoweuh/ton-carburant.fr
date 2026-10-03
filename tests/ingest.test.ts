import { describe, expect, it } from "vitest";
import { planSync, sqlValue, type ExistingRow } from "../ingest/core";
import { parseFeed } from "../src/lib/feed";
import { freshDb, SAMPLE_RECORDS } from "./helpers";

const hashes = (sqlite: ReturnType<typeof freshDb>): ExistingRow[] =>
  sqlite.prepare("SELECT id, h, brand FROM stations").all() as unknown as ExistingRow[];

describe("import différentiel", () => {
  it("premier import : tout est inséré", () => {
    const sqlite = freshDb();
    const plan = planSync(parseFeed(SAMPLE_RECORDS), []);
    expect([plan.inserted, plan.updated, plan.unchanged, plan.deleted]).toEqual([5, 0, 0, 0]);
    sqlite.exec(plan.statements.join("\n"));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM stations").get()).toEqual({ n: 5 });
  });

  it("flux identique : aucune écriture", () => {
    const sqlite = freshDb();
    sqlite.exec(planSync(parseFeed(SAMPLE_RECORDS), []).statements.join("\n"));
    const again = planSync(parseFeed(SAMPLE_RECORDS), hashes(sqlite));
    expect(again.statements).toEqual([]);
    expect(again.unchanged).toBe(5);
  });

  it("un prix modifié ne réécrit qu'une station ; les disparues sont supprimées", () => {
    const sqlite = freshDb();
    sqlite.exec(planSync(parseFeed(SAMPLE_RECORDS), []).statements.join("\n"));

    const changed = SAMPLE_RECORDS.map((r) =>
      r.id === "35510001"
        ? { ...r, prix: JSON.stringify([{ "@nom": "Gazole", "@id": "1", "@maj": "2026-09-16 07:00:00", "@valeur": "1.999" }]) }
        : r,
    ).filter((r) => r.id !== "35300001");
    const plan = planSync(parseFeed(changed), hashes(sqlite));
    expect([plan.inserted, plan.updated, plan.unchanged, plan.deleted]).toEqual([0, 1, 3, 1]);
    sqlite.exec(plan.statements.join("\n"));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM stations").get()).toEqual({ n: 4 });
    const row = sqlite.prepare("SELECT prices_json FROM stations WHERE id = 35510001").get() as any;
    expect(JSON.parse(row.prices_json).Gazole.price).toBe(1.999);
  });

  it("l'enseigne fait partie de l'empreinte", () => {
    const sqlite = freshDb();
    const stations = parseFeed(SAMPLE_RECORDS);
    sqlite.exec(planSync(stations, []).statements.join("\n"));
    stations[0].brand = "Carrefour Market";
    expect(planSync(stations, hashes(sqlite)).updated).toBe(1);
  });

  it("échappe les apostrophes et refuse les nombres invalides", () => {
    expect(sqlValue("Côte d'Or")).toBe("'Côte d''Or'");
    expect(sqlValue(null)).toBe("NULL");
    expect(() => sqlValue(NaN)).toThrow();
  });
});
