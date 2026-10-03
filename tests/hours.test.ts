import { describe, expect, it } from "vitest";
import { isInformative, openNow, type DayHours } from "../src/lib/hours";

const day = (d: number, slots: [string, string][] = [], closed = false): DayHours => ({ day: d, closed, slots });
const at = (isoWeekday: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return { isoWeekday, minutes: h * 60 + m };
};
const WEEK = [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, [["07:00", "21:00"]]));

describe("openNow", () => {
  it.each([["06:59", false], ["07:00", true], ["20:59", true], ["21:00", false]])("créneau simple %s", (t, expected) => {
    expect(openNow(WEEK, at(3, t))).toBe(expected);
  });

  it("renvoie null quand les horaires ne sont pas exploitables", () => {
    const useless = [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, [["01:00", "01:00"]], true));
    expect(openNow(useless, at(3, "10:00"))).toBeNull();
    expect(openNow(null, at(3, "10:00"))).toBeNull();
    expect(openNow([], at(3, "10:00"))).toBeNull();
    expect(isInformative(useless)).toBe(false);
    expect(isInformative(WEEK)).toBe(true);
  });

  it("gère les créneaux à cheval sur minuit", () => {
    const hours = [1, 2, 3, 4, 5, 6, 7].map((d) => day(d, [["22:00", "06:00"]]));
    expect(openNow(hours, at(3, "23:30"))).toBe(true);
    expect(openNow(hours, at(3, "02:00"))).toBe(true);
    expect(openNow(hours, at(3, "12:00"))).toBe(false);
    expect(openNow([day(1, [["22:00", "06:00"]])], at(2, "02:00"))).toBe(true);
  });

  it("jour fermé ou absent", () => {
    const hours = [day(1, [["07:00", "21:00"]]), day(2, [], true)];
    expect(openNow(hours, at(2, "10:00"))).toBe(false);
    expect(openNow(hours, at(4, "10:00"))).toBeNull();
  });
});
