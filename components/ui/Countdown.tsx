"use client";
import { useSyncExternalStore } from "react";
import { Clock } from "lucide-react";
import { cn } from "./cn";

/* A once-per-second client clock as an external store: no clock reads during render (hydration-safe). */
function subscribeSeconds(onTick: () => void): () => void {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}
/** Whole seconds, so repeated snapshots within the same second are identical. */
const clientSecond = () => Math.floor(Date.now() / 1000) * 1000;
const noClockOnServer = () => null;

/** Remaining time to `targetIso`, using a server-clock offset (serverNow - clientNow at fetch time). */
export function useRemainingMs(targetIso: string | null, offsetMs: number): number | null {
  const now = useSyncExternalStore(subscribeSeconds, clientSecond, noClockOnServer);
  if (!targetIso || now === null) return null;
  return Date.parse(targetIso) - (now + offsetMs);
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0m";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function Countdown({
  targetIso,
  offsetMs,
  className,
}: {
  targetIso: string | null;
  offsetMs: number;
  className?: string;
}) {
  const remaining = useRemainingMs(targetIso, offsetMs);
  if (!targetIso) return null;
  // Keep the same box size before hydration to avoid layout shift.
  const text = remaining === null ? "…" : remaining <= 0 ? "Deadline passed — settling" : `${formatRemaining(remaining)} left`;
  return (
    <span role="timer" aria-live="off" className={cn("inline-flex items-center gap-1.5 tabular-nums", className)}>
      <Clock className="size-4" aria-hidden />
      {text}
    </span>
  );
}
