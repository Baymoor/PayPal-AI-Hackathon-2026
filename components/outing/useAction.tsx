"use client";
import { useCallback, useRef, useState } from "react";
import { describeError, type FriendlyError } from "@/components/errors/friendlyError";
import { StatusBanner } from "@/components/ui/StatusBanner";

export type ActionError = FriendlyError;

/** Tracks which async action is running and the last error. One action at a time per hook. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const busy = useRef(false);

  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      // The key decides the money reassurance: only the action tells us what is true about money.
      setError(describeError(e, key));
      return undefined;
    } finally {
      busy.current = false;
      setPending(null);
    }
  }, []);

  return { pending, error, run, clear: () => setError(null) };
}

/** What happened, what to do next, and what it means for money: in that order, in plain words. */
export function ActionErrorBanner({ error, className }: { error: ActionError | null; className?: string }) {
  // Keep the live region mounted so announcements fire when content appears. The banner inside is not a
  // second live region, so screen readers announce the error once.
  return (
    <div aria-live="assertive" className={className}>
      {error && (
        <StatusBanner tone={error.tone} title={error.title} live={false}>
          <p>{error.explanation}</p>
          {error.nextStep && <p className="mt-1">{error.nextStep}</p>}
          {error.moneyNote && <p className="mt-1 font-semibold">{error.moneyNote}</p>}
        </StatusBanner>
      )}
    </div>
  );
}
