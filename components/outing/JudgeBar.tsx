"use client";
import { ArrowRight } from "lucide-react";
import type { OutingView } from "@/lib/contracts/views";
import { describeTodo, judgeBoard, type JudgePerson } from "@/lib/demo/judge";
import { Button } from "@/components/ui/Button";
import { outingApi } from "./api";
import { ActionErrorBanner, useAction } from "./useAction";

function personState(person: JudgePerson): string | null {
  if (person.todo) return describeTodo(person.todo);
  return person.note;
}

/**
 * Demo-only "acting as" bar: who this browser is, what everyone else still has to do, and a one-click
 * switch to any of them (POST /api/demo/persona, then the view is reloaded with the new session). Rendered
 * only when the server reports demo mode; the server refuses the switch otherwise, hidden UI is never access
 * control.
 *
 * Styled as a navy control panel rather than a dashed "fixture" box: it is demo scaffolding, not an honesty
 * label, and judges should tell the two apart at a glance. It never shows vote amounts.
 */
export function JudgeBar({ view, onSwitched }: { view: OutingView; onSwitched: () => Promise<void> }) {
  const board = judgeBoard(view);
  const { pending, error, run } = useAction();

  async function switchTo(person: JudgePerson) {
    await run(`persona:${person.participantId}`, async () => {
      await outingApi.switchPersona(person.participantId);
      await onSwitched();
    });
  }

  return (
    <section aria-labelledby="judge-bar-h" className="rounded-card bg-ink p-4 text-cream sm:p-5">
      <p className="text-small text-cream/75">Demo controls</p>
      <h2 id="judge-bar-h" className="text-[17px] font-semibold leading-6">
        Acting as {board.acting.displayName}
        {board.acting.isOrganizer ? " (organizer)" : ""}
      </h2>
      {board.others.length > 0 && (
        <ul className="mt-3 divide-y divide-cream/15 border-y border-cream/15" aria-label="Other people in this outing">
          {board.others.map((person) => {
            const state = personState(person);
            return (
              <li key={person.participantId} className="flex items-center justify-between gap-3 py-2">
                <p className="min-w-0 text-small leading-5">
                  <span className="font-semibold">{person.displayName}</span>
                  {person.isOrganizer && <span className="text-cream/75"> (organizer)</span>}
                  {/* An open to-do is the thing to act on, so it gets the warm highlight; notes stay muted. */}
                  {state && <span className={person.todo ? "block font-semibold text-[#FFD58A]" : "block text-cream/75"}>{state}</span>}
                </p>
                <Button
                  variant="secondary"
                  className="!min-h-[40px] !border-cream/60 !px-4 !text-[14px] !text-cream hover:!bg-cream/10"
                  aria-label={`Switch to ${person.displayName}`}
                  loading={pending === `persona:${person.participantId}`}
                  loadingLabel="Switching…"
                  disabled={pending !== null}
                  onClick={() => void switchTo(person)}
                >
                  Switch
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 flex items-start gap-2 text-[15px] font-semibold leading-6" aria-live="polite">
        <ArrowRight className="mt-1 size-4 shrink-0 text-coral" aria-hidden />
        {board.nextStep}
      </p>
      <ActionErrorBanner error={error} className="mt-2" />
    </section>
  );
}
