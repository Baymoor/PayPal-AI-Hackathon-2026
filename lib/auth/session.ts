/**
 * Signed, httpOnly cookie sessions (HMAC-SHA256, no server state).
 *
 * - Participant session: maps outingId -> participantId for every invitation
 *   this browser has opened (one browser can hold several outings).
 * - Merchant session: the merchant id the dashboard is scoped to, and how the
 *   session was opened (dashboard password or one-click demo sign-in).
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
/** 30 uuid pairs keep the signed cookie near 3.2 KB, safely under the 4 KB browser limit. */
export const MAX_OUTINGS_PER_SESSION = 30;
/** Merchant sessions last 12 h: enforced here from `iat`, not only by the cookie's Max-Age. */
export const MERCHANT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
/** Tolerated clock skew for an `iat` slightly in the future. */
const IAT_SKEW_SECONDS = 60;

export interface ParticipantSession {
  v: 1;
  /** outingId -> participantId */
  outings: Record<string, string>;
}

/** How a merchant session was opened. */
export type MerchantSignIn = "password" | "demo";

export interface MerchantSession {
  v: 1;
  merchantId: string;
  iat: number;
  /**
   * Signed into the cookie at sign-in. The demo sign-in needs no credentials, so owner-only pages
   * (/setup) ask for "password". A cookie without this field (issued before it existed) counts as "demo".
   */
  via?: MerchantSignIn;
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

/** A signed merchant session is valid only while its issue time is within the 12 h window (server clock). */
function validMerchantSession(s: MerchantSession | null, nowSec: number): MerchantSession | null {
  if (!s || s.v !== 1 || typeof s.merchantId !== "string") return null;
  if (typeof s.iat !== "number" || !Number.isFinite(s.iat)) return null;
  if (s.iat > nowSec + IAT_SKEW_SECONDS) return null;
  if (nowSec - s.iat > MERCHANT_SESSION_MAX_AGE_SECONDS) return null;
  return s;
}

/** True only for a session opened with the dashboard password (never for the one-click demo sign-in). */
export function isPasswordSession(session: MerchantSession | null): boolean {
  return session?.via === "password";
}

export function readMerchantSession(req: Request, nowSec: number = Math.floor(Date.now() / 1000)): MerchantSession | null {
  const raw = parseCookieHeader(req.headers.get("cookie"))[MERCHANT_COOKIE];
  return validMerchantSession(decodeSigned<MerchantSession>(raw), nowSec);
}

/** Same as above but from a cookie value (for server components via next/headers). */
export function participantSessionFromCookieValue(raw: string | undefined): ParticipantSession {
  const s = decodeSigned<ParticipantSession>(raw);
  return s && s.v === 1 && s.outings && typeof s.outings === "object" ? s : { v: 1, outings: {} };
}
export function merchantSessionFromCookieValue(raw: string | undefined, nowSec: number = Math.floor(Date.now() / 1000)): MerchantSession | null {
  return validMerchantSession(decodeSigned<MerchantSession>(raw), nowSec);
}

export function withOuting(session: ParticipantSession, outingId: string, participantId: string): ParticipantSession {
  // Least recently used first out: re-setting a key would keep its original position, so drop it and
  // append it again. An outing is refreshed whenever its invite link is re-opened or a persona is switched
  // in it (merely viewing /o/<id> does not rewrite the cookie).
  const others = Object.entries(session.outings).filter(([id]) => id !== outingId);
  const entries = [...others, [outingId, participantId] as const];
  return { v: 1, outings: Object.fromEntries(entries.slice(-MAX_OUTINGS_PER_SESSION)) };
}

export function cookieHeader(name: string, value: string, opts: { maxAge?: number } = {}): string {
  const secure = config().isProduction ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opts.maxAge ?? MAX_AGE_SECONDS}${secure}`;
}

export function participantCookie(session: ParticipantSession): string {
  return cookieHeader(PARTICIPANT_COOKIE, encodeSigned(session));
}

/** `via` defaults to the least-privileged kind, so only the password route can open owner access. */
export function merchantCookie(merchantId: string, via: MerchantSignIn = "demo"): string {
  return cookieHeader(MERCHANT_COOKIE, encodeSigned({ v: 1, merchantId, iat: Math.floor(Date.now() / 1000), via } satisfies MerchantSession), {
    maxAge: MERCHANT_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
