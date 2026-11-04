"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OutingView } from "@/lib/contracts/views";
import { ErrorState, PageSkeleton } from "@/components/ui/States";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { LinkButton } from "@/components/ui/Button";
import { ApiError, outingApi, type OutingActions } from "./api";
import { OutingScreen } from "./OutingScreen";
import { PageFrame } from "./Shell";

const POLL_MS = 10_000;

function shouldPoll(view: OutingView): boolean {
  const s = view.outing.status;
  if (s === "CONFIRMED") return view.outing.cleanup !== "COMPLETE" && view.outing.cleanup !== "NONE";
  if (s === "CANCELLED") return view.outing.cleanup === "VOID_PENDING" || view.outing.cleanup === "REFUND_PENDING";
  return true;
}

export function OutingClient({ id, paymentFlag }: { id: string; paymentFlag?: string }) {
  const [view, setView] = useState<OutingView | null>(null);
  const [offset, setOffset] = useState(0);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [stale, setStale] = useState(false);
  const viewRef = useRef<OutingView | null>(null);

  const load = useCallback(async () => {
    try {
      const t0 = Date.now();
      const v = await outingApi.get(id);
      const t1 = Date.now();
      // Server clock offset, corrected for half the round trip.
      setOffset(Date.parse(v.outing.serverNow) - (t0 + (t1 - t0) / 2));
      viewRef.current = v;
      setView(v);
      setFatal(null);
      setStale(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNKNOWN", 0, "Something went wrong.");
      if (viewRef.current && err.status !== 401 && err.status !== 404) setStale(true);
      else {
        viewRef.current = null;
        setView(null);
        setFatal(err);
      }
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!view || !shouldPoll(view)) return;
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [view, load]);

  const actions: OutingActions = useMemo(
    () => ({
      startBudget: async () => void (await outingApi.startBudget(id)),
      addInvitees: async (names) => (await outingApi.addInvitees(id, names)).invites,
      vote: async (m) => void (await outingApi.vote(id, m)),
      reveal: async () => void (await outingApi.reveal(id)),
      newRound: async () => void (await outingApi.newRound(id)),
      agreeBudget: async (m) => void (await outingApi.agreeBudget(id, m)),
      select: async (o) => void (await outingApi.select(id, o)),
      patchParticipant: async (pid, patch) => void (await outingApi.patchParticipant(id, pid, patch)),
      open: async (b) => void (await outingApi.open(id, b)),
      respond: async (r) => void (await outingApi.respond(id, r)),
      consent: async (h) => void (await outingApi.consent(id, h)),
      pay: async () => (await outingApi.pay(id)).approveUrl,
      withdraw: async () => void (await outingApi.withdraw(id)),
      cancel: async () => void (await outingApi.cancel(id)),
      refresh: load,
    }),
    [id, load],
  );

  if (fatal) {
    const unauth = fatal.status === 401 || fatal.status === 403;
    const missing = fatal.status === 404;
    return (
      <PageFrame back={{ href: "/", label: "Back to home" }}>
        <ErrorState
          title={unauth ? "Open your invitation link" : missing ? "We can't find that outing" : "We couldn't load this outing"}
          message={
            unauth
              ? "This page is private to the people invited. Open the personal link the organizer sent you — it signs you in on this device."
              : missing
                ? "The link may be mistyped or the outing was removed."
                : fatal.message
          }
          safe="You have not been charged."
          onRetry={unauth || missing ? undefined : load}
        >
          {(unauth || missing) && (
            <div className="mt-4 flex flex-wrap gap-3">
              <LinkButton href="/" variant="secondary">
                Back to home
              </LinkButton>
              <LinkButton href="/demo" variant="link">
                Try the demo
              </LinkButton>
            </div>
          )}
        </ErrorState>
      </PageFrame>
    );
  }

  if (!view) {
    return (
      <PageFrame>
        <PageSkeleton />
      </PageFrame>
    );
  }

  return (
    <OutingScreen
      view={view}
      actions={actions}
      clockOffsetMs={offset}
      paymentFlag={paymentFlag}
      notice={
        stale ? (
          <StatusBanner tone="warning" title="Reconnecting…">
            We couldn&apos;t refresh just now. What you see may be a little out of date.
          </StatusBanner>
        ) : undefined
      }
    />
  );
}
