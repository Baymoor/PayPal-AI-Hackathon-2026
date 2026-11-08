"use client";
import { useId } from "react";
import { OUTING_STARTERS, type OutingStarter } from "@/lib/demo/starters";
import { cn } from "@/components/ui/cn";

/**
 * One-click example briefs. Picking one only fills the plan field (the organizer can still edit it);
 * nothing is submitted. The chip whose brief is in the field shows as pressed.
 */
export function BriefStarters({ onPick, currentBrief }: { onPick: (starter: OutingStarter) => void; currentBrief?: string }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <p id={labelId} className="text-small font-semibold">
        Start from an example
      </p>
      <ul className="flex flex-wrap gap-2">
        {OUTING_STARTERS.map((starter) => {
          const picked = currentBrief === starter.brief;
          return (
            <li key={starter.id}>
              <button
                type="button"
                aria-pressed={picked}
                onClick={() => onPick(starter)}
                className={cn(
                  "min-h-[44px] rounded-pill px-4 text-[15px] font-medium text-ink",
                  picked ? "border-2 border-coral-600 bg-blush-50 px-[15px]" : "border border-line-strong bg-white hover:bg-blush-50",
                )}
              >
                {starter.label}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
