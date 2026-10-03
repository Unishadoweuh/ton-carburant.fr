import { describe, expect, it } from "vitest";
import { cpRanges, findAreas, resolveArea } from "../src/lib/areas";

describe("zones", () => {
  it("plages de codes postaux", () => {
    expect(cpRanges("35")).toEqual([["35", "36"]]);
    expect(cpRanges("2B")).toEqual([["202", "203"], ["206", "207"]]);
    expect(cpRanges("09")).toEqual([["09", "0:"]]);
  });

  it("recherche par code, région et département", () => {
    expect(findAreas("35")[0].area).toBe("dept:35");
    expect(findAreas("bretagne")[0]).toEqual({
      label: "Bretagne", context: "Région entière · 4 départements",
      type: "region", area: "region:bretagne", exact: true,
    });
    expect(findAreas("ille et vilaine")[0].area).toBe("dept:35");
    expect(findAreas("Côtes d'Armor")[0].area).toBe("dept:22");
    expect(findAreas("ile de france")[0].area).toBe("region:ile-de-france");
    expect(resolveArea("region:inconnue")).toBeNull();
    expect(resolveArea("dept:35")?.departements).toEqual(["35"]);
    expect(resolveArea("region:bretagne")?.departements).toEqual(["22", "29", "35", "56"]);
  });
});
