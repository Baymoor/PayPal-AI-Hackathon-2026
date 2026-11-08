"use client";
import { useId } from "react";
import { OUTING_STARTERS, type OutingStarter } from "@/lib/demo/starters";

/**
 * One-click example briefs. Picking one only fills the plan field (the
 * organizer can still edit it); nothing is submitted.
 */
export function BriefStarters({ onPick }: { onPick: (starter: OutingStarter) => void }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <p id={labelId} className="text-small font-semibold">
        Start from an example
      </p>
      <ul className="flex flex-wrap gap-2">
        {OUTING_STARTERS.map((starter) => (
          <li key={starter.id}>
            <button
              type="button"
              onClick={() => onPick(starter)}
              className="min-h-[40px] rounded-pill border border-line-strong bg-white px-4 text-small font-semibold text-ink hover:bg-blush-50"
            >
              {starter.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
