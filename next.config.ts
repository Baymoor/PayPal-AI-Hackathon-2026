import type { NextConfig } from "next";

// Cache Components are intentionally disabled: almost every screen shows live
// payment / deadline state, which must never be served from a cache.
const nextConfig: NextConfig = {
  // Lets parallel dev servers (e.g. agents, Playwright) use separate build dirs.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pg"],
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
