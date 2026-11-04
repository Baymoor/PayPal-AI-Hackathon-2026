"use client";
import { useCallback, useRef, useState } from "react";
import { describeError } from "./api";
import { StatusBanner } from "@/components/ui/StatusBanner";

export interface ActionError {
  code: string;
  message: string;
}

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
      setError(describeError(e));
      return undefined;
    } finally {
      busy.current = false;
      setPending(null);
    }
  }, []);

  return { pending, error, run, clear: () => setError(null) };
}

export function ActionErrorBanner({ error, className }: { error: ActionError | null; className?: string }) {
  // Keep the live region mounted so announcements fire when content appears.
  return (
    <div aria-live="assertive" className={className}>
      {error && (
        <StatusBanner tone={error.code === "TERMS_CHANGED" ? "warning" : "danger"} title={error.code === "UNAUTHORIZED" ? "Open your invitation link" : undefined}>
          {error.message}
          {error.code !== "TERMS_CHANGED" && error.code !== "UNAUTHORIZED" && (
            <span className="block font-semibold">Nothing was charged by this request.</span>
          )}
        </StatusBanner>
      )}
    </div>
  );
}
