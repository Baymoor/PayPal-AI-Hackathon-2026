/** Date helpers. Everything is shown in the outing's displayTimezone, never the viewer's. */

function parts(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts });
}

function hhmm(date: Date, timeZone: string): string {
  return parts(date, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** "Friday 19:00" */
export function formatWhen(iso: string | null, timeZone: string): string {
  if (!iso) return "To be confirmed";
  const d = new Date(iso);
  return `${parts(d, timeZone, { weekday: "long" }).format(d)} ${hhmm(d, timeZone)}`;
}

/** "Thursday, 18:00" (deadline pill). */
export function formatDeadline(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${parts(d, timeZone, { weekday: "long" }).format(d)}, ${hhmm(d, timeZone)}`;
}

/** "Fri 13 Nov, 19:00": compact enough for a money row's sub line. */
export function formatShortDate(iso: string | null, timeZone: string): string {
  if (!iso) return "To be confirmed";
  const d = new Date(iso);
  const p = parts(d, timeZone, { weekday: "short", day: "numeric", month: "short" }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${hhmm(d, timeZone)}`;
}

/** "Friday, 14 November 2026, 19:00 (America/New_York)" */
export function formatWhenFull(iso: string | null, timeZone: string): string {
  if (!iso) return "To be confirmed";
  const d = new Date(iso);
  const date = parts(d, timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
  return `${date}, ${hhmm(d, timeZone)} (${timeZone})`;
}

function tzOffsetMs(ms: number, timeZone: string): number {
  const p = parts(new Date(ms), timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-13T18:00" interpreted in `timeZone` -> UTC ISO string. */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  let ms = guess - tzOffsetMs(guess, timeZone);
  ms = guess - tzOffsetMs(ms, timeZone);
  return new Date(ms).toISOString();
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" wall time in `timeZone` (for datetime-local inputs). */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const p = parts(d, timeZone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
