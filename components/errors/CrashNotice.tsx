"use client";
import { useEffect, useRef } from "react";
import { CloudAlert } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card, IconTile } from "@/components/ui/Card";

/** Server-rendering errors carry a `digest` that matches the server log line; client errors don't. */
export function errorDigest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("digest" in error)) return undefined;
  return typeof error.digest === "string" ? error.digest : undefined;
}

/**
 * Full-page fallback when a screen crashes while rendering (app/error.tsx, app/global-error.tsx).
 * Calm on purpose: it is our bug, not the person's, and rendering a page can never move money.
 */
export function CrashNotice({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const digest = errorDigest(error);

  useEffect(() => {
    // Minimal client-side trace; server-side errors are already logged under the same digest.
    console.error(error);
  }, [error]);

  // The page content was swapped for this notice; move focus so screen reader users hear what happened.
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <IconTile className="size-14">
        <CloudAlert className="size-6" />
      </IconTile>
      <h1 ref={headingRef} tabIndex={-1} className="text-h2 outline-none">
        This page hit a snag
      </h1>
      <p className="max-w-sm text-ink-muted">
        Something broke on our side while showing this page. It wasn&apos;t anything you did.
      </p>
      <p className="max-w-sm font-semibold">
        Showing a page can&apos;t authorize, charge or release money, so this error changed nothing about your payments.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <Button onClick={onRetry}>Try again</Button>
        <LinkButton href="/" variant="secondary">
          Back to home
        </LinkButton>
      </div>
      {digest && <p className="mt-2 text-small text-ink-muted">Reference for support: {digest}</p>}
    </Card>
  );
}
