"use client";
import { CalendarClock, Check, Cake, Info, TriangleAlert, Users } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { CatalogueCandidateView, OutingView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import { AiSourceBadge, Pill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Eyebrow } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { MoneyRow, MoneyRows } from "@/components/ui/MoneyRow";
import { EmptyState } from "@/components/ui/States";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { Toggle } from "@/components/ui/Toggle";
import { cn } from "@/components/ui/cn";
import type { OutingActions } from "./api";
import { formatDeadline, isoToZonedLocal, zonedLocalToIso } from "./format";
import { InvitePanel } from "./InvitePanel";
import { ScreenHeader } from "./Shell";
import { ActionErrorBanner, useAction } from "./useAction";

const FIT = {
  GREAT: { label: "Great fit", cls: "bg-captured-bg text-captured" },
  GOOD: { label: "Good fit", cls: "bg-authorized-bg text-authorized" },
  STRETCH: { label: "Stretch", cls: "bg-void-pending-bg text-void-pending" },
} as const;

function CandidateCard({
  c,
  selected,
  onSelect,
  disabled,
  name,
}: {
  c: CatalogueCandidateView;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  name: string;
}) {
  const fit = c.fit ? FIT[c.fit] : null;
  return (
    <label className="relative block">
      <input type="radio" name={name} className="peer sr-only" checked={selected} disabled={disabled} onChange={onSelect} />
      <span
        className={cn(
          "block rounded-card border-[1.5px] bg-surface p-5 transition-colors",
          "border-line hover:border-coral peer-checked:border-2 peer-checked:border-coral-600 peer-checked:bg-blush-50",
          "peer-focus-visible:shadow-[var(--focus-ring)] peer-disabled:opacity-70",
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="block min-w-0">
            <span className="block font-display text-h3">{c.name}</span>
            <span className="block text-small text-ink-muted">
              {c.merchantName} · {c.category} · {c.location}
            </span>
          </span>
          {fit && (
            <span className={cn("shrink-0 rounded-pill px-3 py-1 text-[13px] font-bold", fit.cls)}>{fit.label}</span>
          )}
        </span>
        <span className="mt-3 block text-body">{c.description}</span>
        <span className="mt-3 flex flex-wrap items-center gap-2">
          {c.pricingModel === "FIXED_TOTAL" ? (
            <Pill tone="neutral">
              {formatMoney(c.priceMinor)} fixed total · up to {c.capacity} people
            </Pill>
          ) : (
            <>
              <Pill tone="neutral">
                {formatMoney(c.priceMinor)} per attendee · up to {c.capacity} people
              </Pill>
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-void-pending-bg px-3 py-1 text-[13px] font-bold text-void-pending">
                <TriangleAlert className="size-3.5" aria-hidden />
                Price grows with attendees
              </span>
            </>
          )}
        </span>
        {(c.reasons.length > 0 || c.concerns.length > 0) && (
          <span className="mt-3 block space-y-1 text-small">
            {c.reasons.map((r, i) => (
              <span key={"r" + i} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-captured" aria-hidden />
                <span>{r}</span>
              </span>
            ))}
            {c.concerns.map((r, i) => (
              <span key={"c" + i} className="flex items-start gap-2 text-void-pending">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <span className="sr-only">Concern: </span>
                  {r}
                </span>
              </span>
            ))}
          </span>
        )}
        {selected && <span className="mt-3 block text-small font-bold text-coral-700">Selected</span>}
      </span>
    </label>
  );
}

function SponsorCard({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const guests = view.roster.people.filter((p) => p.role !== "ORGANIZER");
  const sponsored = view.roster.people.find((p) => p.payerType === "SPONSORED");
  const [chosen, setChosen] = useState<string>(sponsored?.participantId ?? guests[0]?.participantId ?? "");
  const { pending, error, run } = useAction();
  const selectId = useId();
  const canEdit = !!view.organizer?.can.editRoster;
  const guest = view.roster.people.find((p) => p.participantId === (sponsored?.participantId ?? chosen));
  const first = guest?.displayName.split(" ")[0] ?? "them";

  return (
    <Card as="section" aria-labelledby="sponsor-h" className="space-y-4">
      <div className="flex items-center gap-3">
        <Cake className="size-6 text-coral-700" aria-hidden />
        <h2 id="sponsor-h" className="text-h3">
          Treat someone special
        </h2>
      </div>
      {guests.length === 0 ? (
        <p className="text-ink-muted">Invite your guests first, then you can cover one person&apos;s share.</p>
      ) : (
        <>
          <div>
            <label htmlFor={selectId} className="mb-1.5 block text-small font-semibold">
              Guest of honour
            </label>
            <select
              id={selectId}
              value={sponsored?.participantId ?? chosen}
              disabled={!canEdit || pending !== null}
              onChange={(e) => {
                const next = e.target.value;
                setChosen(next);
                if (sponsored) {
                  run("move", async () => {
                    await actions.patchParticipant(sponsored.participantId, { payerType: "PAYER" });
                    await actions.patchParticipant(next, { payerType: "SPONSORED" });
                    await actions.refresh();
                  });
                }
              }}
              className="min-h-[48px] w-full rounded-chip border border-line-strong bg-white px-3"
            >
              {guests.map((g) => (
                <option key={g.participantId} value={g.participantId}>
                  {g.displayName}
                </option>
              ))}
            </select>
          </div>
          <Toggle
            label={`Cover ${first}'s share`}
            checked={!!sponsored}
            disabled={!canEdit || pending !== null || !chosen}
            stateText={sponsored ? `On. ${first} pays $0.` : "Off. Everyone attending pays an equal share."}
            onChange={(next) =>
              run("sponsor", async () => {
                const id = sponsored?.participantId ?? chosen;
                await actions.patchParticipant(id, { payerType: next ? "SPONSORED" : "PAYER" });
                await actions.refresh();
              })
            }
          />
          <ActionErrorBanner error={error} />
        </>
      )}
    </Card>
  );
}

function SplitPreview({ view, candidate }: { view: OutingView; candidate: CatalogueCandidateView | undefined }) {
  const { roster, estimates } = view;
  const sponsored = roster.people.filter((p) => p.payerType === "SPONSORED");
  const fixed = candidate?.pricingModel === "FIXED_TOTAL";
  return (
    <Card as="section" aria-labelledby="split-h" className="space-y-4">
      <h2 id="split-h" className="text-h3">
        Split preview
      </h2>
      {!candidate ? (
        <p className="text-ink-muted">Choose an option above to preview the split.</p>
      ) : (
        <>
          <MoneyRows>
            {fixed ? (
              <MoneyRow label="Fixed room total" value={formatMoney(candidate.priceMinor)} />
            ) : (
              <MoneyRow label="Price per attendee" value={formatMoney(candidate.priceMinor)} sub="Total grows with attendees" />
            )}
            <MoneyRow label="Attendees" value={roster.attendeeCount} />
            <MoneyRow label="Paying participants" value={estimates.projectedPayers} />
            {estimates.estimatedShareMinor !== null && (
              <MoneyRow label="Each paying participant" value={formatMoney(estimates.estimatedShareMinor)} emphasis />
            )}
            {estimates.capMinor !== null && <MoneyRow label="Maximum anyone is asked to authorize" value={formatMoney(estimates.capMinor)} />}
            {sponsored.map((s) => (
              <MoneyRow
                key={s.participantId}
                label={`${s.displayName.split(" ")[0]} pays`}
                value="$0"
                valueClassName="rounded-chip bg-blush px-2 text-coral-800"
              />
            ))}
          </MoneyRows>
          <p className="text-small text-ink-muted">Equal shares can differ by one cent.</p>
        </>
      )}
      <div className="flex items-start gap-3 rounded-[18px] border border-amber-line bg-amber-bg p-4 text-amber-ink">
        <Users className="mt-0.5 size-5 shrink-0" aria-hidden />
        <p>Everyone sees and approves this split before committing. Changing who pays requires renewed consent.</p>
      </div>
    </Card>
  );
}

function OpenForm({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const tz = view.outing.displayTimezone;
  const serverNow = Date.parse(view.outing.serverNow);
  const { pending, error, run } = useAction();
  const dflt = useMemo(() => {
    const dl = new Date(serverNow + 24 * 3600_000);
    dl.setUTCMinutes(0, 0, 0);
    const act = new Date(dl.getTime() + 24 * 3600_000);
    return { deadline: isoToZonedLocal(dl.toISOString(), tz), activity: isoToZonedLocal(act.toISOString(), tz) };
  }, [serverNow, tz]);
  const [deadline, setDeadline] = useState(view.outing.deadlineAt ? isoToZonedLocal(view.outing.deadlineAt, tz) : dflt.deadline);
  const [activity, setActivity] = useState(view.outing.activityAt ? isoToZonedLocal(view.outing.activityAt, tz) : dflt.activity);
  const [minPayers, setMinPayers] = useState(String(view.roster.minPayers ?? Math.max(2, view.estimates.projectedPayers)));

  const deadlineIso = zonedLocalToIso(deadline, tz);
  const activityIso = zonedLocalToIso(activity, tz);
  let problem: string | null = null;
  if (!deadlineIso || !activityIso) problem = "Pick both a commitment deadline and an activity time.";
  else if (Date.parse(deadlineIso) <= serverNow) problem = "The commitment deadline must be in the future.";
  else if (Date.parse(deadlineIso) - serverNow > 48 * 3600_000) problem = "The commitment deadline can be at most 48 hours from now.";
  else if (Date.parse(activityIso) <= Date.parse(deadlineIso)) problem = "The activity must start after the commitment deadline.";
  const mp = Number(minPayers);
  if (!problem && (!Number.isInteger(mp) || mp < 1)) problem = "Minimum payers must be a whole number of at least 1.";
  const canOpen = !!view.organizer?.can.openCollection;

  return (
    <Card as="section" aria-labelledby="open-h" className="space-y-4">
      <div className="flex items-center gap-3">
        <CalendarClock className="size-6 text-coral-700" aria-hidden />
        <h2 id="open-h" className="text-h3">
          Open commitments
        </h2>
      </div>
      <p className="text-ink-muted">
        Times are in {tz}. The deadline is enforced by our server clock, at most 48 hours from now and before the activity.
      </p>
      <div className="grid gap-4">
        <TextField label="Commit by" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        <TextField label="Activity time" type="datetime-local" value={activity} onChange={(e) => setActivity(e.target.value)} />
        <TextField
          label="Minimum payers"
          type="number"
          min={1}
          inputMode="numeric"
          value={minPayers}
          onChange={(e) => setMinPayers(e.target.value)}
          hint="Sets each person’s maximum. More payers lower the final share."
        />
      </div>
      {deadlineIso && !problem && (
        <p className="text-small text-ink-muted" aria-live="polite">
          People will be asked to commit by {formatDeadline(deadlineIso, tz)}.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-small font-semibold text-danger">
          {problem}
        </p>
      )}
      <ActionErrorBanner error={error} />
      <Button
        block
        arrow
        loading={pending === "open"}
        loadingLabel="Opening…"
        disabled={!canOpen || !!problem || !view.proposal?.selectedOfferingId}
        disabledReason={
          !view.proposal?.selectedOfferingId ? "Choose an option first." : !canOpen ? "Add your guests and check the split first." : undefined
        }
        onClick={() =>
          run("open", async () => {
            await actions.open({ activityAt: activityIso!, deadlineAt: deadlineIso!, minPayers: mp });
            await actions.refresh();
          })
        }
      >
        Open commitments
      </Button>
    </Card>
  );
}

export function ProposalStage({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const { pending, error, run } = useAction();
  const proposal = view.proposal;
  const radioName = useId();
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const selectedId = optimistic ?? proposal?.selectedOfferingId ?? null;
  const selected = proposal?.candidates.find((c) => c.offeringId === selectedId);
  const proposed = view.budget.proposedBudgetMinor;

  if (!view.viewer.isOrganizer || !view.organizer) {
    return (
      <div className="space-y-6">
        <ScreenHeader view={view} title="Almost there" />
        <EmptyState icon={<Info className="size-6" />} title="The organizer is finalizing the plan">
          {proposed !== null
            ? `The group agreed on a ${formatMoney(proposed)} starting budget. You'll get a personal invitation to review and commit when it's ready.`
            : "You'll get a personal invitation to review and commit when it's ready."}
        </EmptyState>
        <p className="text-center text-small text-ink-muted">Nothing is charged until you review and authorize your own share.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScreenHeader view={view} title="Pick a merchant-confirmed quote" lead="Suggestions are not bookings or payment approvals." />
      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <section aria-labelledby="cands" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="cands" className="text-h3">
                Ranked for your group
              </h2>
              <AiSourceBadge source={proposal?.source ?? null} />
            </div>
            {proposal?.note && <p className="text-ink-muted">{proposal.note}</p>}
            {view.outing.isFixture && (
              <p className="text-small text-ink-muted">Demo catalogue — availability and prices are fixture data, not a live merchant.</p>
            )}
            {!proposal || proposal.candidates.length === 0 ? (
              <EmptyState icon={<Info className="size-6" />} title="No options yet">
                We couldn&apos;t find a catalogue match for this plan. Try another budget round.
              </EmptyState>
            ) : (
              <div role="radiogroup" aria-label="Catalogue options" className="space-y-3">
                {proposal.candidates.map((c) => (
                  <CandidateCard
                    key={c.offeringId}
                    c={c}
                    name={radioName}
                    selected={selectedId === c.offeringId}
                    disabled={!view.organizer!.can.selectOffering || pending === "select"}
                    onSelect={() => {
                      setOptimistic(c.offeringId);
                      run("select", async () => {
                        await actions.select(c.offeringId);
                        await actions.refresh();
                      }).then(() => setOptimistic(null));
                    }}
                  />
                ))}
              </div>
            )}
            <ActionErrorBanner error={error} />
          </section>
          {view.organizer.can.addInvitees && <InvitePanel actions={actions} />}
        </div>
        <div className="space-y-6">
          {proposed !== null && (
            <Card tone="navy">
              <Eyebrow className="!text-cream/80">Agreed group budget</Eyebrow>
              <p className="font-display text-[40px] leading-[44px] tabular-nums">{formatMoney(proposed)}</p>
              <p className="text-cream/90">A starting point, not a merchant quote.</p>
            </Card>
          )}
          <SponsorCard view={view} actions={actions} />
          <RosterToggles view={view} actions={actions} />
          <SplitPreview view={view} candidate={selected} />
          <OpenForm view={view} actions={actions} />
        </div>
      </div>
    </div>
  );
}

function RosterToggles({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const guests = view.roster.people.filter((p) => p.role !== "ORGANIZER");
  const { error, run, pending } = useAction();
  if (guests.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="req-h" className="space-y-4">
      <h2 id="req-h" className="text-h3">
        Who must be there?
      </h2>
      <p className="text-small text-ink-muted">
        Required guests must accept and authorize or the outing is cancelled. Optional guests never block it.
      </p>
      <ul className="space-y-4">
        {guests.map((g) => (
          <li key={g.participantId}>
            <Toggle
              label={g.displayName}
              checked={g.required}
              disabled={!view.organizer?.can.editRoster || pending !== null}
              stateText={g.required ? "Required" : "Optional"}
              onChange={(next) =>
                run("req" + g.participantId, async () => {
                  await actions.patchParticipant(g.participantId, { required: next });
                  await actions.refresh();
                })
              }
            />
          </li>
        ))}
      </ul>
      <ActionErrorBanner error={error} />
    </Card>
  );
}
