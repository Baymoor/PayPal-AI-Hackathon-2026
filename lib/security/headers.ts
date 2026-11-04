/**
 * HTTP security headers. Pure builders (no Next imports) so they can be unit
 * tested. Wiring: `next.config.ts` sets the static headers on every route,
 * `proxy.ts` sets the per-request nonce-based Content-Security-Policy.
 */

export interface CspOptions {
  /** Per-request nonce (base64). */
  nonce: string;
  /** `next dev` only: React refresh / debugging needs eval. */
  isDev: boolean;
}

const PAYPAL_FORM_ACTIONS = ["https://www.sandbox.paypal.com", "https://www.paypal.com"];

export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildCsp({ nonce, isDev }: CspOptions): string {
  const directives: string[] = [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonced Next bootstrap load its chunks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Inline styles: React `style` attributes, AG Grid / AG Studio / AG Charts runtime styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    // Dev server uses a websocket for HMR.
    isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    "frame-ancestors 'none'",
    `form-action 'self' ${PAYPAL_FORM_ACTIONS.join(" ")}`,
    "base-uri 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

export interface StaticHeaderOptions {
  nodeEnv: string | undefined;
  appBaseUrl: string | undefined;
}

export function shouldSendHsts({ nodeEnv, appBaseUrl }: StaticHeaderOptions): boolean {
  if (nodeEnv !== "production" || !appBaseUrl) return false;
  try {
    return new URL(appBaseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** 2 years, subdomains included. Sent by next.config.ts (build-time env) and proxy.ts (runtime env). */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

/** Headers that do not vary per request. */
export function staticSecurityHeaders(opts: StaticHeaderOptions): { key: string; value: string }[] {
  const headers = [
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ];
  if (shouldSendHsts(opts)) {
    headers.push({ key: "Strict-Transport-Security", value: HSTS_VALUE });
  }
  return headers;
}
