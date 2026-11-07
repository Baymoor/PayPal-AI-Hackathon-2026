"use client"; // Error boundaries must be Client Components.

// global-error replaces the root layout, so it brings its own document, fonts and styles.
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./globals.css";
import { CrashNotice } from "@/components/errors/CrashNotice";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";

/** Last-resort fallback when the root layout itself fails. Metadata exports aren't supported here, hence <title>. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <title>Something went wrong · Outings</title>
        <SiteHeader />
        <main id="main" className="mx-auto w-full max-w-[560px] flex-1 px-5 py-12">
          <CrashNotice error={error} onRetry={retry} />
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
