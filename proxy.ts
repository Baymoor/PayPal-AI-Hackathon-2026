/**
 * Sets a nonce-based Content-Security-Policy on every request (Next 16 `proxy`,
 * formerly middleware). Next reads the nonce from the request's CSP header and
 * applies it to its own scripts, so all pages render dynamically (root layout
 * calls `connection()`). Other security headers live in next.config.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { HSTS_VALUE, buildCsp, generateNonce, shouldSendHsts } from "@/lib/security/headers";

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // next.config.ts `headers()` is evaluated at BUILD time, so an image built without APP_BASE_URL
  // (e.g. the Dockerfile) would never send HSTS. Decide again here from the runtime environment.
  if (shouldSendHsts({ nodeEnv: process.env.NODE_ENV, appBaseUrl: process.env.APP_BASE_URL })) {
    response.headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
