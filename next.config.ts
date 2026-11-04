import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./lib/security/headers";

// Cache Components are intentionally disabled: almost every screen shows live
// payment / deadline state, which must never be served from a cache.
const nextConfig: NextConfig = {
  // Lets parallel dev servers (e.g. agents, Playwright) use separate build dirs.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // No "X-Powered-By: Next.js" fingerprint.
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  // Non-CSP security headers on every route. The nonce-based CSP is set per request in proxy.ts.
  async headers() {
    const headers = staticSecurityHeaders({ nodeEnv: process.env.NODE_ENV, appBaseUrl: process.env.APP_BASE_URL });
    return [{ source: "/:path*", headers }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
