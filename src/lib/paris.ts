/** Heure de Paris sans dépendance : tout passe par Intl. */
const TZ = "Europe/Paris";

function offsetMinutes(utcMs: number): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** "2026-09-14 12:06:54" (heure de Paris) -> "2026-09-14T12:06:54+02:00". */
export function parisIso(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec((value ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = offsetMinutes(asUtc - 2 * 3600_000);
  offset = offsetMinutes(asUtc - offset * 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export interface ParisNow {
  isoWeekday: number; // 1 = lundi … 7 = dimanche
  minutes: number; // minutes depuis minuit
}

export function parisNow(date = new Date()): ParisNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { isoWeekday: weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
