"use client";
import { Minus, Plus, Scale } from "lucide-react";
import { useId, useState } from "react";
import { Card } from "@/components/ui/Card";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { cn } from "@/components/ui/cn";
import { equalSplit, estimatedShare, formatMoney, parseMajorToMinor, perPayerCap, sumMinor } from "@/lib/domain/money";

type Mode = "FIXED_TOTAL" | "PER_ATTENDEE";

const MAX_ATTENDEES = 20;

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function Stepper({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const btn =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink text-ink hover:bg-blush-50 disabled:border-line-strong disabled:text-ink-muted disabled:hover:bg-transparent";
  return (
    <div>
      <label htmlFor={id} className="block font-semibold">
        {label}
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={btn} aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          <Minus className="size-5" aria-hidden />
        </button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(clampInt(e.target.value, min, max, value))}
          className="min-h-[48px] w-20 rounded-chip border border-line-strong bg-white px-3 text-center font-money text-[22px] focus-visible:border-ink"
        />
        <button type="button" className={btn} aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          <Plus className="size-5" aria-hidden />
        </button>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-small text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Interactive, honest split calculator. Uses the same pure money functions the server settles with (the page says so in plain words). */
export function SplitCalculator() {
  const uid = useId();
  const [mode, setMode] = useState<Mode>("FIXED_TOTAL");
  const [amountText, setAmountText] = useState("100");
  const [attendees, setAttendees] = useState(5);
  const [sponsored, setSponsored] = useState(0);
  const [minPayersRaw, setMinPayersRaw] = useState(5);

  const payerCount = Math.max(1, attendees - sponsored);
  const minPayers = Math.min(Math.max(1, minPayersRaw), payerCount);

  let amountMinor: number | null = null;
  let amountError: string | null = null;
  try {
    amountMinor = parseMajorToMinor(amountText);
    if (amountMinor === 0) {
      amountMinor = null;
      amountError = "Enter an amount greater than $0.";
    } else if (amountMinor > 1_000_000_00) {
      amountMinor = null;
      amountError = "Keep it under $1,000,000 for this demo.";
    }
  } catch {
    amountError = "Use dollars and cents, like 100 or 33.34.";
  }

  function compute(n: number, sp: number) {
    if (amountMinor === null) return null;
    const payers = Math.max(1, n - sp);
    const total = mode === "FIXED_TOTAL" ? amountMinor : amountMinor * n;
    const min = Math.min(minPayers, payers);
    const shares = equalSplit(
      total,
      Array.from({ length: payers }, (_, i) => `Payer ${i + 1}`),
    );
    return { payers, total, cap: perPayerCap(total, min), estimate: estimatedShare(total, min, payers), shares };
  }

  const now = compute(attendees, sponsored);
  const plusOne = attendees < MAX_ATTENDEES ? compute(attendees + 1, sponsored) : null;
  const amounts = now ? now.shares.map((s) => s.amountMinor) : [];
  const sum = amounts.length ? sumMinor(amounts) : 0;
  const unequal = amounts.length > 0 && new Set(amounts).size > 1;
  const nextShare = (r: ReturnType<typeof compute>) => (r ? r.shares[0].amountMinor : 0);
  const sameTotalLine = now && formatMoney(now.total);

  const seg = (m: Mode) =>
    cn(
      "flex min-h-[48px] flex-1 cursor-pointer items-center justify-center rounded-pill px-4 text-center text-[15px] font-semibold transition-colors has-[:focus-visible]:shadow-[var(--focus-ring)]",
      mode === m ? "bg-ink text-cream" : "text-ink hover:bg-blush-50",
    );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <Card className="space-y-6">
        <fieldset>
          <legend className="font-semibold">How is the price set?</legend>
          <div className="mt-2 flex gap-1 rounded-pill border border-line-strong bg-surface p-1">
            <label className={seg("FIXED_TOTAL")}>
              <input type="radio" name={`${uid}-mode`} className="sr-only" checked={mode === "FIXED_TOTAL"} onChange={() => setMode("FIXED_TOTAL")} />
              Fixed total
            </label>
            <label className={seg("PER_ATTENDEE")}>
              <input type="radio" name={`${uid}-mode`} className="sr-only" checked={mode === "PER_ATTENDEE"} onChange={() => setMode("PER_ATTENDEE")} />
              Per person
            </label>
          </div>
          <p className="mt-2 text-small text-ink-muted" aria-live="polite">
            {mode === "FIXED_TOTAL"
              ? "One price for the whole booking, like a private room. More people share the same total."
              : "A price for each person, like a ticket. Every extra guest adds their own cost."}
          </p>
        </fieldset>

        <div>
          <label htmlFor={`${uid}-amt`} className="block font-semibold">
            {mode === "FIXED_TOTAL" ? "Fixed room total ($)" : "Price per person ($)"}
          </label>
          <input
            id={`${uid}-amt`}
            inputMode="decimal"
            autoComplete="off"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? `${uid}-amt-e` : undefined}
            className={cn(
              "mt-2 min-h-[52px] w-full rounded-chip border border-line-strong bg-white px-4 font-money text-[24px] focus-visible:border-ink",
              amountError && "border-danger",
            )}
          />
          {amountError && (
            <p id={`${uid}-amt-e`} role="alert" className="mt-1.5 text-small font-semibold text-danger">
              {amountError}
            </p>
          )}
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Stepper id={`${uid}-att`} label="People coming" value={attendees} min={1} max={MAX_ATTENDEES} onChange={(n) => { setAttendees(n); if (sponsored >= n) setSponsored(0); }} />
          <Stepper
            id={`${uid}-min`}
            label="Minimum payers"
            hint="The fewest people who must pay for the booking to go ahead. It sets each person's maximum."
            value={minPayers}
            min={1}
            max={payerCount}
            onChange={setMinPayersRaw}
          />
        </div>

        <fieldset>
          <legend className="font-semibold">Treating someone?</legend>
          <div className="mt-2 flex gap-1 rounded-pill border border-line-strong bg-surface p-1">
            {[0, 1].map((n) => (
              <label
                key={n}
                className={cn(
                  "flex min-h-[48px] flex-1 cursor-pointer items-center justify-center rounded-pill px-4 text-[15px] font-semibold has-[:focus-visible]:shadow-[var(--focus-ring)]",
                  sponsored === n ? "bg-ink text-cream" : "text-ink hover:bg-blush-50",
                  n === 1 && attendees < 2 && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="radio"
                  name={`${uid}-sp`}
                  className="sr-only"
                  checked={sponsored === n}
                  disabled={n === 1 && attendees < 2}
                  onChange={() => setSponsored(n)}
                />
                {n === 0 ? "No" : "Yes, cover 1 guest"}
              </label>
            ))}
          </div>
          <p className="mt-2 text-small text-ink-muted">A covered guest still says yes, but pays $0. Everyone else shares the total.</p>
        </fieldset>
      </Card>

      <div className="space-y-4">
        <p className="sr-only" role="status">
          {now
            ? `Total ${formatMoney(now.total)}, ${now.payers} paying. Maximum ${formatMoney(now.cap)} each. Shares: ${amounts.map((a) => formatMoney(a, "USD", { alwaysShowCents: true })).join(", ")}.`
            : "Enter a valid amount."}
        </p>
        <Card tone="navy" className="space-y-5">
          <div>
            <p className="text-caption font-semibold uppercase tracking-[0.14em] text-[#C9D1E3]">Booking total</p>
            <p className="font-money text-[44px] leading-[48px]">{now ? formatMoney(now.total) : "—"}</p>
            <p className="text-small text-[#C9D1E3]">
              {now ? `${now.payers} paying ${now.payers === 1 ? "person" : "people"}${sponsored ? `, ${sponsored} covered` : ""}` : "Fix the amount to see the split."}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-4 border-t border-white/20 pt-4">
            <div>
              <dt className="text-small text-[#C9D1E3]">Each person&apos;s maximum</dt>
              <dd className="font-money text-[28px] leading-8">{now ? formatMoney(now.cap) : "—"}</dd>
              <dd className="mt-1 text-small text-[#C9D1E3]">
                The hold each person approves: the total divided by the minimum number of payers ({minPayers}), rounded up to the cent.
              </dd>
            </div>
            <div>
              <dt className="text-small text-[#C9D1E3]">Share with this group</dt>
              <dd className="font-money text-[28px] leading-8">{now ? formatMoney(now.estimate) : "—"}</dd>
              <dd className="mt-1 text-small text-[#C9D1E3]">What each person would pay today. Never above the maximum.</dd>
            </div>
          </dl>
        </Card>

        <Card className="space-y-4">
          <h3 className="flex items-center gap-2 text-h3">
            <Scale className="size-5 text-coral-700" aria-hidden />
            Each share, to the cent
          </h3>
          {now ? (
            <>
              <ol className="grid grid-cols-2 gap-x-6 gap-y-0 sm:grid-cols-3" aria-label="Final share per paying person">
                {now.shares.map((s) => {
                  const base = Math.floor(now.total / now.payers);
                  return (
                    <li key={s.key} className="flex items-baseline justify-between gap-2 border-t border-line py-2.5">
                      <span className="text-small text-ink-muted">{s.key}</span>
                      <span className="font-money text-[18px]">
                        {formatMoney(s.amountMinor, "USD", { alwaysShowCents: unequal })}
                        {s.amountMinor > base && <span className="sr-only"> (includes the extra cent)</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p className="text-small font-semibold tabular-nums">
                {now.shares.map((s) => formatMoney(s.amountMinor, "USD", { alwaysShowCents: unequal })).join(", ")}
                {" = "}
                {formatMoney(sum, "USD", { alwaysShowCents: true })}
                {sum === now.total ? " (adds up exactly)" : ""}
              </p>
              <p className="text-small text-ink-muted">
                {unequal
                  ? `Equal shares can differ by one cent. The first ${now.total % now.payers} ${now.total % now.payers === 1 ? "person" : "people"} on the list pay the extra cent, and that order never changes.`
                  : "This total divides evenly, so every share is the same. When it does not, some shares are one cent higher."}
              </p>
            </>
          ) : (
            <p className="text-ink-muted">Enter a valid amount to see each share.</p>
          )}
        </Card>

        {now && plusOne && (
          <Card tone="blush" className="space-y-2">
            <h3 className="text-h3">What if one more person joins?</h3>
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(nextShare(now), "USD", { alwaysShowCents: true })} → {formatMoney(nextShare(plusOne), "USD", { alwaysShowCents: true })}
              <span className="font-normal text-ink-muted"> for the first payer</span>
            </p>
            <p className="text-ink">
              {mode === "FIXED_TOTAL"
                ? `The total stays ${sameTotalLine}, so a bigger group only lowers each share (never raises it). The maximum you approved does not change.`
                : `Each extra guest brings their own ${formatMoney(amountMinor ?? 0)}, so the share per person stays the same. More guests do not make it cheaper.`}
            </p>
          </Card>
        )}

        <StatusBanner tone="info" live={false}>
          This is only an example. In a real outing the guest list is locked at the deadline and the split is saved exactly as shown. A hold is not a charge, and PayPal fees are never added to your share.
        </StatusBanner>
      </div>
    </div>
  );
}
