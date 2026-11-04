import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Outings — make plans, make them happen", template: "%s · Outings" },
  description:
    "Agree on a budget. Commit your share. Go together. Independent hackathon project using PayPal sandbox payments — no real money.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FBF6F1",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP nonce is generated per request in proxy.ts, so every page must render per request.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <head>
        {/* zod (client bundle) probes `new Function("")`, which a CSP without 'unsafe-eval' reports as a
            violation even though zod falls back. Tell it up front to run without code generation. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: "globalThis.__zod_globalConfig={jitless:true}" }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-pill focus:bg-ink focus:px-5 focus:py-3 focus:font-semibold focus:text-cream"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
