import { Check } from "lucide-react";
import { cn } from "./cn";

export const STEPS = ["Brief", "Budget", "Invite", "Commit"] as const;

/** `current` is 0-based; pass 4 (or more) when every step is done (result), with `doneLabel` naming the outcome. */
export function Stepper({ current, context, doneLabel = "Result" }: { current: number; context?: string; doneLabel?: string }) {
  const mobileLabel =
    current >= STEPS.length ? doneLabel : `Step ${current + 1} of ${STEPS.length}`;
  return (
    <nav aria-label="Progress">
      <p className="text-center text-caption font-semibold uppercase tracking-[0.14em] text-ink-muted sm:hidden">
        <span aria-hidden className="mx-2 inline-block h-px w-6 bg-coral align-middle" />
        {mobileLabel}
        {context ? ` · ${context}` : ""}
        <span aria-hidden className="mx-2 inline-block h-px w-6 bg-coral align-middle" />
      </p>
      <ol className="hidden items-center justify-center gap-3 sm:flex">
        {STEPS.map((label, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={label} className="flex items-center gap-3" aria-current={active ? "step" : undefined}>
              <span
                className={cn(
                  "inline-flex size-[30px] items-center justify-center rounded-full text-[14px] font-bold",
                  active && "bg-coral-600 text-white",
                  done && "bg-ink text-cream",
                  !active && !done && "border-[1.5px] border-line-strong text-ink-muted",
                )}
              >
                {done ? <Check className="size-4" strokeWidth={3} aria-hidden /> : i + 1}
              </span>
              <span className={cn("text-[15px]", active ? "font-bold" : done ? "font-semibold" : "text-ink-muted")}>
                {label}
                {active && <span className="sr-only"> (current)</span>}
                {done && <span className="sr-only"> (done)</span>}
              </span>
              {i < STEPS.length - 1 && <span aria-hidden className="h-px w-8 bg-line-strong" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
