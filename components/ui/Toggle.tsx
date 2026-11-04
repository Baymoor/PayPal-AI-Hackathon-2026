"use client";
import { Check } from "lucide-react";
import { useId } from "react";
import { cn } from "./cn";

export function Toggle({
  checked,
  onChange,
  label,
  stateText,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: React.ReactNode;
  /** Text under the label describing the state ("On. Maya pays $0."). */
  stateText?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <div className="min-w-0">
        <p id={`${id}-l`} className="font-semibold">
          {label}
        </p>
        {stateText && (
          <p id={`${id}-s`} className="text-small text-ink-muted" aria-live="polite">
            {stateText}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={stateText ? `${id}-s` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-9 w-[60px] shrink-0 items-center rounded-pill transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          "before:absolute before:-inset-1 before:content-['']", // 44px+ hit area
          checked ? "bg-coral-600" : "bg-[#C9BDB0]",
        )}
      >
        <span
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[28px]" : "translate-x-1",
          )}
        >
          {checked && <Check className="size-4 text-coral-700" strokeWidth={3} aria-hidden />}
        </span>
      </button>
    </div>
  );
}
