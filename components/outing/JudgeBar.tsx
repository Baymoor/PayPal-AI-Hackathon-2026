"use client";
import { FlaskConical } from "lucide-react";
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
    <section aria-labelledby="judge-bar-h" className="rounded-card border border-dashed border-fixture bg-fixture-bg p-4 text-ink">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="judge-bar-h" className="flex items-center gap-2 text-small font-bold uppercase tracking-[0.08em] text-fixture">
          <FlaskConical className="size-4" aria-hidden />
          Demo: acting as {board.acting.displayName}
          {board.acting.isOrganizer ? " (organizer)" : ""}
        </h2>
        <p className="text-small font-semibold" aria-live="polite">
          {board.nextStep}
        </p>
      </div>
      {board.others.length > 0 && (
        <ul className="mt-3 divide-y divide-line" aria-label="Other people in this outing">
          {board.others.map((person) => {
            const state = personState(person);
            return (
              <li key={person.participantId} className="flex items-center justify-between gap-3 py-2">
                <p className="min-w-0 text-small">
                  <span className="font-semibold">{person.displayName}</span>
                  {person.isOrganizer && <span className="text-ink-muted"> (organizer)</span>}
                  {state && <span className="text-ink-muted"> · {state}</span>}
                </p>
                <Button
                  variant="secondary"
                  className="!min-h-[36px] !px-3 !text-[14px]"
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
      <ActionErrorBanner error={error} className="mt-2" />
    </section>
  );
}
