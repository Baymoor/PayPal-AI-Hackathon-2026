"use client";
import { Activity, CalendarDays, Gift, Info, MapPin, Users, Wallet } from "lucide-react";
import type { OutingView } from "@/lib/contracts/views";
import { Button } from "@/components/ui/Button";
import { Card, IconTile } from "@/components/ui/Card";
import { AiSourceBadge } from "@/components/ui/Badge";
import { Underlined } from "@/components/ui/Swoosh";
import { EmptyState } from "@/components/ui/States";
import type { OutingActions } from "./api";
import { ActionErrorBanner, useAction } from "./useAction";
import { ScreenHeader } from "./Shell";

const ICONS = {
  activity: Activity,
  date: CalendarDays,
  people: Users,
  gift: Gift,
  budget: Wallet,
  place: MapPin,
  note: Info,
} as const;

export function BriefStage({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const { pending, error, run } = useAction();
  const ex = view.brief.extraction;
  const rows = ex?.summary ?? [];
  const hasBudgetRow = rows.some((r) => r.icon === "budget");
  const canStart = !!view.organizer?.can.startBudget;

  return (
    <div className="space-y-6">
      <ScreenHeader
        view={view}
        center={false}
        titleNode={
          <>
            What are we <Underlined>planning?</Underlined>
          </>
        }
      />
      <Card tone="blush" className="text-body">
        <p className="text-small font-semibold text-ink-muted">Your brief</p>
        <p className="mt-1 whitespace-pre-wrap">{view.outing.brief}</p>
      </Card>

      <Card as="section" aria-labelledby="understood">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="understood" className="text-h3">
            Here&apos;s what I understood
          </h2>
          <AiSourceBadge source={view.brief.source} />
        </div>
        {rows.length === 0 ? (
          <p className="mt-3 text-ink-muted">We couldn&apos;t read details from the brief yet. You can still start budget poker.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {rows.map((r, i) => {
              const Icon = ICONS[r.icon] ?? Info;
              return (
                <li key={i} className="flex items-center gap-3 py-3 first:pt-0">
                  <IconTile>
                    <Icon className="size-5" />
                  </IconTile>
                  <span className="text-body">{r.text}</span>
                </li>
              );
            })}
            {!hasBudgetRow && (
              <li className="flex items-center gap-3 py-3 last:pb-0">
                <IconTile>
                  <Wallet className="size-5" />
                </IconTile>
                <span className="text-body">
                  Budget <span className="text-ink-muted">· Not set yet</span>
                </span>
              </li>
            )}
          </ul>
        )}
        {ex && ex.uncertainties.length > 0 && (
          <div className="mt-4 rounded-[18px] border border-amber-line bg-amber-bg p-4 text-amber-ink">
            <p className="font-bold">A few things to confirm</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {ex.uncertainties.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {canStart ? (
        <Card tone="amber" className="space-y-4">
          <p className="font-display text-h3 text-ink">What total budget feels comfortable?</p>
          <ActionErrorBanner error={error} />
          <Button
            block
            arrow
            loading={pending === "start"}
            loadingLabel="Starting…"
            onClick={() => run("start", () => actions.startBudget().then(actions.refresh))}
          >
            Start budget poker
          </Button>
        </Card>
      ) : (
        <EmptyState icon={<Info className="size-6" />} title="The organizer is setting things up">
          You&apos;ll be able to suggest a budget as soon as they start budget poker.
        </EmptyState>
      )}
      <p className="text-center text-small text-ink-muted">Suggestions are not bookings or payment approvals.</p>
    </div>
  );
}
