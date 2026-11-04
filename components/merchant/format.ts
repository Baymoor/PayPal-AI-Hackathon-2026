/** Display helpers for the merchant dashboard (pure, usable on client and server). */

/**
 * The Sound Room's local time zone. The merchant DTOs carry UTC instants and no
 * merchant time zone, so the dashboard formats in this documented constant
 * (override with NEXT_PUBLIC_MERCHANT_TIMEZONE).
 */
export const MERCHANT_TIMEZONE = process.env.NEXT_PUBLIC_MERCHANT_TIMEZONE || "Europe/Copenhagen";

export function formatMoney(minor: number | null | undefined, currency = "USD"): string {
  if (minor === null || minor === undefined) return "n/a";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

const tzAbbrev = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value ?? "";

/** "Thu 6:00 PM PDT" in the merchant time zone. */
export function formatInstant(iso: string | null | undefined, tz = MERCHANT_TIMEZONE): string {
  if (!iso) return "No deadline";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Invalid date";
  const base = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return `${base} ${tzAbbrev(d, tz)}`;
}

/** "in 3h 05m" / "42m ago" style countdown from minutes. */
export function formatCountdown(minutes: number | null): string {
  if (minutes === null) return "No deadline";
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const body = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  return minutes < 0 ? `${body} ago` : `in ${body}`;
}

/** Defensive redaction for provider references: keep only the last 4 characters. */
export function redactRef(ref: string | null | undefined): string {
  if (!ref) return "–";
  if (ref.startsWith("…") || ref.startsWith("...")) return ref;
  return `…${ref.slice(-4).toUpperCase()}`;
}

export function dayKey(d: Date, tz = MERCHANT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
