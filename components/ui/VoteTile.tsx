"use client";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import { formatMoney, parseMajorToMinor } from "@/lib/domain/money";
import { cn } from "./cn";

/** Radio group of budget tiles plus a custom amount. Native radios give arrow-key navigation for free. */
export function VoteGrid({
  options,
  value,
  onChange,
  legend,
  customLabel,
  customExample,
  disabled,
}: {
  options: number[];
  value: number | null;
  onChange: (minor: number | null) => void;
  legend: string;
  /** Label of the custom amount field; it says what the amount means (per person, or a group total). */
  customLabel: string;
  /** A plausible amount in whole dollars, e.g. "20": the placeholder and the error hint. */
  customExample: string;
  disabled?: boolean;
}) {
  const name = useId();
  const isPreset = value !== null && options.includes(value);
  const [customOpen, setCustomOpen] = useState(value !== null && !isPreset);
  const [customText, setCustomText] = useState(value !== null && !isPreset ? String(value / 100) : "");
  const [customError, setCustomError] = useState<string | null>(null);

  function onCustomChange(text: string) {
    setCustomText(text);
    if (!text.trim()) {
      setCustomError(null);
      onChange(null);
      return;
    }
    try {
      const minor = parseMajorToMinor(text);
      if (minor < 100) throw new Error("min");
      setCustomError(null);
      onChange(minor);
    } catch {
      setCustomError(`Enter a whole-dollar or cents amount like ${customExample} or ${customExample}.50`);
      onChange(null);
    }
  }

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div role="radiogroup" aria-label={legend} className="grid grid-cols-3 gap-3">
        {options.map((minor) => {
          const selected = value === minor;
          return (
            <label key={minor} className="relative block">
              <input
                type="radio"
                name={name}
                className="peer sr-only"
                checked={selected && !customOpen}
                onChange={() => {
                  setCustomOpen(false);
                  setCustomError(null);
                  onChange(minor);
                }}
              />
              <span
                className={cn(
                  "flex h-[84px] items-center justify-center rounded-tile border-[1.5px] font-money text-[28px] transition-colors",
                  "border-[#E2D4C4] bg-surface text-ink hover:border-coral peer-focus-visible:shadow-[var(--focus-ring)]",
                  "peer-checked:border-coral-600 peer-checked:bg-coral-600 peer-checked:text-white",
                  "peer-disabled:opacity-60",
                )}
              >
                {formatMoney(minor)}
              </span>
              <span
                aria-hidden
                className="absolute right-2 top-2 hidden size-6 items-center justify-center rounded-full bg-white text-coral-700 peer-checked:flex"
              >
                <Check className="size-4" strokeWidth={3} />
              </span>
            </label>
          );
        })}
        <label className="relative block">
          <input
            type="radio"
            name={name}
            className="peer sr-only"
            checked={customOpen}
            onChange={() => {
              setCustomOpen(true);
              onCustomChange(customText);
            }}
          />
          <span
            className={cn(
              "flex h-[84px] items-center justify-center rounded-tile border-[1.5px] font-money text-[22px] transition-colors",
              "border-[#E2D4C4] bg-surface text-ink hover:border-coral peer-focus-visible:shadow-[var(--focus-ring)]",
              "peer-checked:border-coral-600 peer-checked:bg-coral-600 peer-checked:text-white",
            )}
          >
            Custom
          </span>
          <span
            aria-hidden
            className="absolute right-2 top-2 hidden size-6 items-center justify-center rounded-full bg-white text-coral-700 peer-checked:flex"
          >
            <Check className="size-4" strokeWidth={3} />
          </span>
        </label>
      </div>
      {customOpen && (
        <div className="mt-3">
          <label htmlFor={`${name}-custom`} className="mb-1.5 block text-small font-semibold">
            {customLabel}
          </label>
          <div className="flex items-center gap-2">
            <span aria-hidden className="font-money text-[24px]">
              $
            </span>
            <input
              id={`${name}-custom`}
              inputMode="decimal"
              autoComplete="off"
              value={customText}
              onChange={(e) => onCustomChange(e.target.value)}
              aria-invalid={customError ? true : undefined}
              aria-describedby={customError ? `${name}-err` : undefined}
              className="min-h-[48px] w-full rounded-chip border border-line-strong bg-white px-4 text-body"
              placeholder={customExample}
            />
          </div>
          {customError && (
            <p id={`${name}-err`} role="alert" className="mt-1.5 text-small font-semibold text-danger">
              {customError}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
