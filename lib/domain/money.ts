/**
 * Integer minor-unit money. All authoritative financial arithmetic in Outings
 * happens here, on safe integers (cents). No binary floating point is ever
 * used to compute an amount that is charged, authorized, or displayed as owed.
 *
 * MVP supports a single currency: USD (2 minor digits).
 */

export const SUPPORTED_CURRENCIES = ["USD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Number of minor digits per supported currency. */
const MINOR_DIGITS: Record<Currency, number> = { USD: 2 };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function assertCurrency(value: unknown): Currency {
  if (!isCurrency(value)) throw new MoneyError(`Unsupported currency: ${String(value)}`);
  return value;
}

/** Throws unless `value` is a non-negative safe integer number of minor units. */
export function assertMinor(value: unknown, label = "amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of minor units, got ${String(value)}`);
  }
  if (value < 0) throw new MoneyError(`${label} must not be negative, got ${value}`);
  return value;
}

/** Throws unless `value` is a strictly positive safe integer number of minor units. */
export function assertPositiveMinor(value: unknown, label = "amount"): number {
  assertMinor(value, label);
  if ((value as number) === 0) throw new MoneyError(`${label} must be greater than zero`);
  return value as number;
}

/**
 * Parse a decimal string such as "20", "20.5" or "20.50" into minor units
 * without going through floating point. Rejects more decimals than the
 * currency supports, signs, exponents, and separators.
 */
export function parseMajorToMinor(input: string, currency: Currency = "USD"): number {
  const digits = MINOR_DIGITS[currency];
  const trimmed = input.trim();
  const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new MoneyError(`Not a valid ${currency} amount: "${input}"`);
  const whole = match[1];
  const frac = match[2] ?? "";
  if (frac.length > digits) {
    throw new MoneyError(`${currency} amounts support at most ${digits} decimal places`);
  }
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  return assertMinor(minor);
}

/**
 * Convert minor units to a canonical decimal string for provider APIs
 * (PayPal expects e.g. "20.00"). Pure integer formatting, no floats.
 */
export function minorToDecimalString(minor: number, currency: Currency = "USD"): string {
  assertMinor(minor);
  const digits = MINOR_DIGITS[currency];
  const base = 10 ** digits;
  const whole = Math.floor(minor / base);
  const frac = minor % base;
  return digits === 0 ? String(whole) : `${whole}.${String(frac).padStart(digits, "0")}`;
}

/** Parse a provider decimal string ("20.00") back to minor units, strictly. */
export function decimalStringToMinor(value: string, currency: Currency = "USD"): number {
  return parseMajorToMinor(value, currency);
}

/**
 * Human formatting: "$20" for whole amounts, "$33.34" otherwise.
 * Display only — never parse the result back.
 */
export function formatMoney(
  minor: number,
  currency: Currency = "USD",
  opts: { alwaysShowCents?: boolean } = {},
): string {
  assertMinor(minor);
  const digits = MINOR_DIGITS[currency];
  const base = 10 ** digits;
  const whole = Math.floor(minor / base);
  const frac = minor % base;
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const wholeStr = whole.toLocaleString("en-US");
  if (frac === 0 && !opts.alwaysShowCents) return `${symbol}${wholeStr}`;
  return `${symbol}${wholeStr}.${String(frac).padStart(digits, "0")}`;
}

/** Ceiling integer division for non-negative integers. */
export function ceilDiv(numerator: number, denominator: number): number {
  assertMinor(numerator, "numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new MoneyError(`denominator must be a positive integer, got ${denominator}`);
  }
  return Math.floor((numerator + denominator - 1) / denominator);
}

export interface Allocation<K extends string = string> {
  key: K;
  amountMinor: number;
}

/**
 * Deterministic equal split with stable penny distribution.
 *
 *   base = floor(total / N); remainder = total % N
 *   the first `remainder` payers (in the given, immutable order) get base + 1.
 *
 * The caller is responsible for passing payers in their immutable stable order
 * (see `stablePayerOrder`). The result always sums exactly to `totalMinor`.
 */
export function equalSplit<K extends string>(totalMinor: number, orderedKeys: readonly K[]): Allocation<K>[] {
  assertPositiveMinor(totalMinor, "totalMinor");
  const n = orderedKeys.length;
  if (n === 0) throw new MoneyError("Cannot split between zero payers");
  if (new Set(orderedKeys).size !== n) throw new MoneyError("Payer keys must be unique");
  const base = Math.floor(totalMinor / n);
  const remainder = totalMinor % n;
  const result = orderedKeys.map((key, index) => ({
    key,
    amountMinor: base + (index < remainder ? 1 : 0),
  }));
  // Defensive invariant check: exact sum.
  const sum = result.reduce((acc, a) => acc + a.amountMinor, 0);
  if (sum !== totalMinor) throw new MoneyError(`Split invariant violated: ${sum} !== ${totalMinor}`);
  return result;
}

/**
 * Per-payer authorization cap for a FIXED_TOTAL quote: the largest share any
 * payer could owe once at least `minPayers` payers are on the frozen roster.
 * With N >= minPayers, base + 1 <= ceil(total / N) <= ceil(total / minPayers).
 */
export function perPayerCap(totalMinor: number, minPayers: number): number {
  assertPositiveMinor(totalMinor, "totalMinor");
  if (!Number.isSafeInteger(minPayers) || minPayers < 1) {
    throw new MoneyError(`minPayers must be a positive integer, got ${minPayers}`);
  }
  return ceilDiv(totalMinor, minPayers);
}

/**
 * Estimated share shown before the roster is frozen. With fewer than
 * `minPayers` committed payers the estimate is the cap (it cannot be lower
 * until enough people join). Display only; the frozen snapshot is authoritative.
 */
export function estimatedShare(totalMinor: number, minPayers: number, projectedPayers: number): number {
  const n = Math.max(minPayers, projectedPayers, 1);
  return ceilDiv(totalMinor, n);
}

export function sumMinor(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + assertMinor(v), 0);
}
