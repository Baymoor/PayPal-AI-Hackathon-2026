/**
 * Judge sign-in: the gate in front of everything on the hosted demo that spends real resources
 * (creating outings with PayPal sandbox, real Claude calls).
 *
 * The gate is ON only when JUDGE_PASSWORD is set. When it is off (local development, tests) every caller
 * counts as a judge, so the app behaves exactly as it does without this module.
 *
 * The session is a signed, httpOnly cookie (same HMAC mechanism as lib/auth/session.ts). It carries a
 * fingerprint of the configured credentials, so changing JUDGE_USERNAME or JUDGE_PASSWORD signs everyone out.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../env";
import { ServiceError } from "../http";
import { decodeSigned, encodeSigned, parseCookieHeader } from "./session";
import { safeEqual } from "./tokens";

export const JUDGE_COOKIE = "outings_judge";
/** Judging and the winners announcement run until 21 Dec 2026; every judge session ends the day after. */
export const JUDGE_SESSION_EXPIRES_AT = new Date("2026-12-22T00:00:00Z");
export const JUDGE_LOGIN_PATH = "/judge/login";
/** Where a judge lands after signing in when no (valid) `next` was given. */
export const JUDGE_DEFAULT_NEXT = "/new";

interface JudgeSession {
  v: 1;
  /** Expiry, seconds since the epoch. Enforced here, not only by the cookie's Expires. */
  exp: number;
  /** Fingerprint of the credentials the session was opened with. */
  cred: string;
}

interface JudgeCredentials {
  username: string;
  password: string;
}

/** True when this deployment asks judges to sign in (JUDGE_PASSWORD is set). */
export function judgeGateEnabled(): boolean {
  return config().judge !== null;
}

function credentialFingerprint(credentials: JudgeCredentials): string {
  return createHmac("sha256", config().sessionSecret).update(`judge:${credentials.username}\n${credentials.password}`).digest("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time credential check: fixed-length digests are compared, and both fields are always
 * compared, so neither the length nor which field was wrong leaks through timing.
 */
export function judgeCredentialsMatch(given: JudgeCredentials): boolean {
  const expected = config().judge;
  if (!expected) return false;
  const usernameOk = timingSafeEqual(digest(given.username), digest(expected.username));
  const passwordOk = timingSafeEqual(digest(given.password), digest(expected.password));
  return usernameOk && passwordOk;
}

function validJudgeCookieValue(raw: string | undefined, nowMs: number): boolean {
  const expected = config().judge;
  if (!expected) return false;
  const session = decodeSigned<JudgeSession>(raw);
  if (!session || session.v !== 1) return false;
  if (typeof session.exp !== "number" || !Number.isFinite(session.exp) || session.exp * 1000 <= nowMs) return false;
  return typeof session.cred === "string" && safeEqual(session.cred, credentialFingerprint(expected));
}

/** True when the request carries a valid judge session cookie (always false while the gate is off). */
export function hasJudgeSession(req: Request, nowMs: number = Date.now()): boolean {
  return validJudgeCookieValue(parseCookieHeader(req.headers.get("cookie"))[JUDGE_COOKIE], nowMs);
}

/** May this request use the judge-only features? Gate off: everyone. Gate on: a valid judge session. */
export function isJudgeRequest(req: Request, nowMs: number = Date.now()): boolean {
  return !judgeGateEnabled() || hasJudgeSession(req, nowMs);
}

/** Server-component twin of `isJudgeRequest`: reads the cookie through next/headers. */
export async function isJudgeSession(): Promise<boolean> {
  if (!judgeGateEnabled()) return true;
  // Imported here so route handlers and tests that only need the Request-based helpers never load next/headers.
  const { cookies } = await import("next/headers");
  return validJudgeCookieValue((await cookies()).get(JUDGE_COOKIE)?.value, Date.now());
}

/** Throws 401 JUDGE_LOGIN_REQUIRED when the gate is on and the request has no valid judge session. */
export function requireJudge(req: Request): void {
  if (!isJudgeRequest(req)) throw new ServiceError("JUDGE_LOGIN_REQUIRED", 401, "Sign in as a judge to use this.");
}

function cookieAttributes(): string {
  return `Path=/; HttpOnly; SameSite=Lax${config().isProduction ? "; Secure" : ""}`;
}

/** Set-Cookie value for a fresh judge session. Only call after `judgeCredentialsMatch` succeeded. */
export function judgeCookie(expiresAt: Date = JUDGE_SESSION_EXPIRES_AT): string {
  const credentials = config().judge;
  if (!credentials) throw new Error("Judge sign-in is not configured");
  const session: JudgeSession = { v: 1, exp: Math.floor(expiresAt.getTime() / 1000), cred: credentialFingerprint(credentials) };
  return `${JUDGE_COOKIE}=${encodeURIComponent(encodeSigned(session))}; ${cookieAttributes()}; Expires=${expiresAt.toUTCString()}`;
}

export function clearJudgeCookie(): string {
  return `${JUDGE_COOKIE}=; ${cookieAttributes()}; Max-Age=0`;
}

const NEXT_PARSE_BASE = "http://judge-next.invalid";

/**
 * The `?next=` of the sign-in page, reduced to a same-site relative path. Anything that could leave the
 * site (absolute or protocol-relative URLs, backslashes, control characters) falls back to the default.
 */
export function safeNextPath(raw: string | string[] | undefined | null, fallback: string = JUDGE_DEFAULT_NEXT): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Browsers treat "\" like "/" and strip tabs/newlines from URLs: "/\evil.example" would leave the site.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, NEXT_PARSE_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== NEXT_PARSE_BASE || url.pathname.startsWith("//")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page address that returns to `next` afterwards. */
export function judgeLoginHref(next: string): string {
  return `${JUDGE_LOGIN_PATH}?next=${encodeURIComponent(safeNextPath(next))}`;
}
