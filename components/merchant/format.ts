/** Display helpers for the merchant dashboard (pure, usable on client and server). */

/**
 * Fallback merchant time zone (The Sound Room's), used only when a DTO carries
 * no usable `merchantTimezone`: NEXT_PUBLIC_MERCHANT_TIMEZONE, else
 * Europe/Copenhagen. Prefer `merchantTz(row)`.
 */
export const MERCHANT_TIMEZONE = process.env.NEXT_PUBLIC_MERCHANT_TIMEZONE || "Europe/Copenhagen";

const tzValidity = new Map<string, boolean>();
function isValidTimeZone(tz: string): boolean {
  let ok = tzValidity.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    tzValidity.set(tz, ok);
  }
  return ok;
}

/**
 * Time zone to display a merchant booking in: the row's own `merchantTimezone`
 * (merchants.timezone, sent by the server) when it is a valid IANA zone,
 * otherwise MERCHANT_TIMEZONE.
 */
export function merchantTz(row?: { merchantTimezone?: string | null } | null): string {
  const tz = row?.merchantTimezone?.trim();
  return tz && isValidTimeZone(tz) ? tz : MERCHANT_TIMEZONE;
}

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

/** "Thu 6:00 PM PDT" in the merchant time zone (pass `merchantTz(row)`). */
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
