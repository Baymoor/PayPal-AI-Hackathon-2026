"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FIXTURES, FIXTURE_FLAGS, FIXTURE_KEYS } from "@/components/__fixtures__/outing-views";
import { OutingScreen } from "@/components/outing/OutingScreen";
import type { OutingActions } from "@/components/outing/api";
import { ApiError } from "@/components/outing/api";

const wait = (ms = 600) => new Promise<void>((r) => setTimeout(r, ms));

/** Stub actions for the dev preview: they resolve after a short delay and change nothing. */
function stubActions(): OutingActions {
  return {
    startBudget: () => wait(),
    addInvitees: async (names) => {
      await wait();
      return names.map((n, i) => ({ participantId: `new${i}`, displayName: n, link: `/i/demo-token-${n.toLowerCase()}-${i}` }));
    },
    vote: () => wait(),
    reveal: () => wait(),
    newRound: () => wait(),
    agreeBudget: () => wait(),
    select: () => wait(300),
    patchParticipant: () => wait(300),
    open: () => wait(),
    respond: () => wait(),
    consent: () => wait(),
    pay: async () => {
      await wait();
      throw new ApiError("TERMS_CHANGED", 409, "terms changed");
    },
    withdraw: () => wait(),
    cancel: () => wait(),
    refresh: async () => {},
  };
}

export function PreviewClient({ selected }: { selected: string | null }) {
  const [offset, setOffset] = useState(0);
  const actions = useMemo(stubActions, []);
  const entry = selected ? FIXTURES[selected] : null;

  useEffect(() => {
    if (entry) setOffset(Date.parse(entry.view.outing.serverNow) - Date.now());
  }, [entry]);

  if (!entry) {
    return (
      <main className="mx-auto w-full max-w-[720px] flex-1 px-5 py-10">
        <h1 className="text-h2">Dev preview</h1>
        <p className="mt-2 text-ink-muted">Every screen state, rendered from typed fixtures. Actions are stubbed. Not available in production.</p>
        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {FIXTURE_KEYS.map((k) => (
            <li key={k}>
              <Link href={`/dev/preview?s=${k}`} className="flex min-h-[44px] items-center rounded-chip border border-line bg-surface px-4 font-semibold hover:border-coral">
                {FIXTURES[k]!.label}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return (
    <>
      <div className="bg-ink px-4 py-1.5 text-center text-small text-cream">
        Dev preview · {entry.label} · <Link href="/dev/preview" className="underline">all states</Link>
      </div>
      <OutingScreen view={entry.view} actions={actions} clockOffsetMs={offset} paymentFlag={selected ? FIXTURE_FLAGS[selected] : undefined} />
    </>
  );
}
