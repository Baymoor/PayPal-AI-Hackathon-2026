"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJudgeSession, judgeLogout, type JudgeSessionState } from "./api";

const linkClass = "inline-flex min-h-[44px] items-center font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800";

/**
 * Footer entry for judges: "Judge sign-in", or "Signed in as judge · Sign out".
 * Renders nothing while the state is unknown and on deployments without a judge gate.
 */
export function JudgeSessionLink() {
  const [state, setState] = useState<JudgeSessionState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchJudgeSession()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => undefined); // only a convenience link: stay hidden when the state cannot be loaded
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    setBusy(true);
    try {
      await judgeLogout();
    } catch {
      /* the cookie may already be gone */
    }
    // A full reload: a judge-only page (e.g. /new) must not stay on screen, it sends the visitor to sign-in again.
    window.location.reload();
  }

  if (!state?.gateEnabled) return null;
  if (!state.signedIn) {
    return (
      <Link href="/judge/login" className={linkClass}>
        Judge sign-in
      </Link>
    );
  }
  return (
    <span className="inline-flex min-h-[44px] items-center gap-1.5 text-ink-muted">
      Signed in as judge ·
      <button type="button" className={linkClass} onClick={() => void signOut()} disabled={busy}>
        Sign out
      </button>
    </span>
  );
}
