/**
 * Interprétation des horaires déclarés.
 *
 * Les horaires du flux sont souvent approximatifs : beaucoup de stations déclarent
 * sept jours fermés, ou des créneaux « 01.00 – 01.00 » qui ne veulent rien dire.
 * On ne conclut donc que lorsque les créneaux sont exploitables, sinon on renvoie
 * null (« on ne sait pas ») plutôt que d'afficher une information fausse.
 */
import type { ParisNow } from "./paris";

export interface DayHours {
  day: number;
  closed: boolean;
  slots: [string, string][];
}

const toMinutes = (value: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function usableSlots(day: DayHours): [number, number][] {
  const slots: [number, number][] = [];
  for (const [opening, closing] of day.slots ?? []) {
    const start = toMinutes(opening);
    const end = toMinutes(closing);
    if (start === null || end === null || start === end) continue;
    slots.push([start, end]);
  }
  return slots;
}

export const isInformative = (hours: DayHours[] | null | undefined): boolean =>
  !!hours && hours.some((day) => usableSlots(day).length > 0);

/** true / false, ou null si les horaires ne permettent pas de conclure. */
export function openNow(hours: DayHours[] | null | undefined, now: ParisNow): boolean | null {
  if (!hours || !isInformative(hours)) return null;
  const byDay = new Map(hours.map((d) => [d.day, d]));
  const today = now.isoWeekday;
  const current = now.minutes;

  const day = byDay.get(today);
  for (const [start, end] of day ? usableSlots(day) : []) {
    if (start <= end) {
      if (start <= current && current < end) return true;
    } else if (current >= start || current < end) {
      return true; // créneau à cheval sur minuit
    }
  }

  const yesterday = byDay.get(today === 1 ? 7 : today - 1);
  for (const [start, end] of yesterday ? usableSlots(yesterday) : []) {
    if (start > end && current < end) return true; // créneau de la veille qui déborde
  }

  return day ? false : null;
}
