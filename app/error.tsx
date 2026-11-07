"use client"; // Error boundaries must be Client Components.

import { CrashNotice } from "@/components/errors/CrashNotice";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";

/** Catches rendering errors in every route below the root layout. Next 16 passes `retry` (re-fetch + re-render). */
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <>
      <title>Something went wrong · Outings</title>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[560px] flex-1 px-5 py-12">
        <CrashNotice error={error} onRetry={retry} />
      </main>
      <SiteFooter />
    </>
  );
}
