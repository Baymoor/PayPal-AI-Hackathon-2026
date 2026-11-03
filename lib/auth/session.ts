/**
 * Signed, httpOnly cookie sessions (HMAC-SHA256, no server state).
 *
 * - Participant session: maps outingId -> participantId for every invitation
 *   this browser has opened (one browser can hold several outings).
 * - Merchant session: the merchant id the dashboard is scoped to.
 *
 * Route handlers read cookies from the Request (not next/headers) so they are
 * unit-testable by constructing a Request with a Cookie header.
 */
import { createHmac } from "node:crypto";
import { config } from "../env";
import { safeEqual } from "./tokens";

export const PARTICIPANT_COOKIE = "outings_p";
export const MERCHANT_COOKIE = "outings_m";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_OUTINGS_PER_SESSION = 20;

export interface ParticipantSession {
  v: 1;
  /** outingId -> participantId */
  outings: Record<string, string>;
}

export interface MerchantSession {
  v: 1;
  merchantId: string;
  iat: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeSigned(value: unknown, secret = config().sessionSecret): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeSigned<T>(raw: string | undefined | null, secret = config().sessionSecret): T | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, sign(payload, secret))) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function readParticipantSession(req: Request): ParticipantSession {
  const raw = parseCookieHeader(req.headers.get("cookie"))[PARTICIPANT_COOKIE];
  const s = decodeSigned<ParticipantSession>(raw);
  return s && s.v === 1 && s.outings && typeof s.outings === "object" ? s : { v: 1, outings: {} };
}

export function readMerchantSession(req: Request): MerchantSession | null {
  const raw = parseCookieHeader(req.headers.get("cookie"))[MERCHANT_COOKIE];
  const s = decodeSigned<MerchantSession>(raw);
  return s && s.v === 1 && typeof s.merchantId === "string" ? s : null;
}

/** Same as above but from a cookie value (for server components via next/headers). */
export function participantSessionFromCookieValue(raw: string | undefined): ParticipantSession {
  const s = decodeSigned<ParticipantSession>(raw);
  return s && s.v === 1 && s.outings && typeof s.outings === "object" ? s : { v: 1, outings: {} };
}
export function merchantSessionFromCookieValue(raw: string | undefined): MerchantSession | null {
  const s = decodeSigned<MerchantSession>(raw);
  return s && s.v === 1 && typeof s.merchantId === "string" ? s : null;
}

export function withOuting(session: ParticipantSession, outingId: string, participantId: string): ParticipantSession {
  const entries = Object.entries({ ...session.outings, [outingId]: participantId });
  return { v: 1, outings: Object.fromEntries(entries.slice(-MAX_OUTINGS_PER_SESSION)) };
}

export function cookieHeader(name: string, value: string, opts: { maxAge?: number } = {}): string {
  const secure = config().isProduction ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opts.maxAge ?? MAX_AGE_SECONDS}${secure}`;
}

export function participantCookie(session: ParticipantSession): string {
  return cookieHeader(PARTICIPANT_COOKIE, encodeSigned(session));
}

export function merchantCookie(merchantId: string): string {
  return cookieHeader(MERCHANT_COOKIE, encodeSigned({ v: 1, merchantId, iat: Math.floor(Date.now() / 1000) } satisfies MerchantSession), {
    maxAge: 60 * 60 * 12,
  });
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
