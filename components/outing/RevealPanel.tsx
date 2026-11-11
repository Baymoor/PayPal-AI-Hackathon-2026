"use client";
import { useState } from "react";
import type { OutingView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import { AiSourceBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Eyebrow } from "@/components/ui/Card";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { VoteGrid } from "@/components/ui/VoteTile";
import { cn } from "@/components/ui/cn";
import type { OutingActions } from "./api";
import { budgetCopy } from "./budgetCopy";
import { ActionErrorBanner, useAction } from "./useAction";

/** Aggregate-only distribution as an accessible bar chart (role=img with a full text alternative). */
export function DistributionChart({ view }: { view: OutingView }) {
  const agg = view.budget.aggregate;
  if (!agg) return null;
  const copy = budgetCopy(agg.unit);
  const amounts = Array.from(new Set([...view.budget.options, ...agg.buckets.map((b) => b.amountMinor)])).sort((a, b) => a - b);
  const countFor = (m: number) => agg.buckets.find((b) => b.amountMinor === m)?.count ?? 0;
  const max = Math.max(1, ...amounts.map(countFor));
  const modal = Math.max(...amounts.map(countFor));
  const alt =
    copy.chartAltLead +
    amounts.map((m) => `${formatMoney(m)}: ${countFor(m)} ${countFor(m) === 1 ? "vote" : "votes"}`).join(", ") +
    ".";
  return (
    <figure className="space-y-3">
      <figcaption className="font-semibold">{copy.chartTitle}</figcaption>
      <div role="img" aria-label={alt} className="flex h-[200px] items-end justify-between gap-2 sm:gap-4">
        {amounts.map((m) => {
          const c = countFor(m);
          const isModal = c === modal && c > 0;
          return (
            <div key={m} className="flex h-full min-w-0 flex-1 flex-col justify-end text-center">
              <span className="mb-1 text-small font-bold tabular-nums">
                {c} {c === 1 ? "vote" : "votes"}
              </span>
              <div
                className={cn("w-full rounded-t-chip", isModal ? "bg-coral-600" : "bg-[#EBCFC6]")}
                style={{ height: `${c === 0 ? 3 : (c / max) * 150}px` }}
              />
              <span className="mt-2 font-money text-[18px]">{formatMoney(m)}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

export function RevealPanel({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const { budget } = view;
  const agg = budget.aggregate;
  const org = view.organizer?.can;
  const { pending, error, run } = useAction();
  const suggested = budget.aiSummary?.suggestedAmountMinor ?? agg?.medianMinor ?? null;
  const [override, setOverride] = useState<number | null>(null);
  const [pick, setPick] = useState(false);
  const target = override ?? suggested;
  const copy = budgetCopy(budget.unit);

  if (!agg) return <StatusBanner tone="info">The reveal isn&apos;t available yet.</StatusBanner>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
      <div className="space-y-6">
        <Card className="space-y-6">
          <DistributionChart view={view} />
          <dl className="grid grid-cols-3 gap-3 border-t border-line pt-4 text-center">
            <div>
              <dt className="text-caption font-semibold uppercase tracking-[0.14em] text-ink-muted">Range</dt>
              <dd className="font-money text-[22px]">
                {formatMoney(agg.minMinor)}–{formatMoney(agg.maxMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-caption font-semibold uppercase tracking-[0.14em] text-ink-muted">Median</dt>
              <dd className="font-money text-[22px]">{formatMoney(agg.medianMinor)}</dd>
            </div>
            <div>
              <dt className="text-caption font-semibold uppercase tracking-[0.14em] text-ink-muted">Voted</dt>
              <dd className="font-money text-[22px]">
                {agg.voteCount} of {agg.invitedCount}
              </dd>
            </div>
          </dl>
        </Card>
        <p className="text-small text-ink-muted">{copy.revealFootnote}</p>
      </div>

      <div className="space-y-6">
        {budget.aiSummary && (
          <Card className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Eyebrow>Summary</Eyebrow>
              <AiSourceBadge source={budget.aiSummary.source} />
            </div>
            <h2 className="text-h3">{budget.aiSummary.headline}</h2>
            <p>{budget.aiSummary.summary}</p>
          </Card>
        )}

        <Card tone="navy" className="space-y-1">
          <Eyebrow className="!text-cream/80">{copy.proposedLabel}</Eyebrow>
          <p className="font-money text-[56px] leading-[56px]">
            {formatMoney(budget.proposedBudgetMinor ?? target ?? 0)}
          </p>
          <p className="text-cream/90">A starting point, not a merchant quote.</p>
        </Card>

        {org && (
          <div className="space-y-3">
            <ActionErrorBanner error={error} />
            {org.agreeBudget && target !== null && (
              <Button
                block
                arrow
                loading={pending === "agree"}
                loadingLabel="Saving…"
                onClick={() => run("agree", async () => { await actions.agreeBudget(target); await actions.refresh(); })}
              >
                {copy.agreeButton(target)}
              </Button>
            )}
            {org.agreeBudget && (
              <div>
                <Button variant="link" aria-expanded={pick} onClick={() => setPick((p) => !p)}>
                  {pick ? "Hide other amounts" : "Choose a different amount"}
                </Button>
                {pick && (
                  <div className="mt-2">
                    <VoteGrid
                      legend={copy.agreeLegend}
                      customLabel={copy.customLabel}
                      customExample={copy.customExample}
                      options={budget.options}
                      value={override}
                      onChange={setOverride}
                    />
                  </div>
                )}
              </div>
            )}
            {org.newRound && (
              <Button
                variant="link"
                loading={pending === "round"}
                loadingLabel="Starting…"
                onClick={() => run("round", async () => { await actions.newRound(); await actions.refresh(); })}
              >
                Vote again
              </Button>
            )}
          </div>
        )}
        {!org && <StatusBanner tone="info">The organizer agrees the budget next.</StatusBanner>}
      </div>
    </div>
  );
}
