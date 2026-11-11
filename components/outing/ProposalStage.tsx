"use client";
import { Bot, Check, Info, TriangleAlert, Users } from "lucide-react";
import { useId, useState } from "react";
import type { CatalogueCandidateView, OutingView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import { AiSourceBadge, Pill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Eyebrow } from "@/components/ui/Card";
import { TextField } from "@/components/ui/Field";
import { MoneyRow, MoneyRows } from "@/components/ui/MoneyRow";
import { EmptyState } from "@/components/ui/States";
import { Toggle } from "@/components/ui/Toggle";
import { cn } from "@/components/ui/cn";
import type { OutingActions } from "./api";
import { formatDeadline, isoToZonedLocal, zonedLocalToIso } from "./format";
import { InvitePanel } from "./InvitePanel";
import { AI_REVIEW_COPY, AiPrefillFrame, PlanDraftPanel, type AppliedPlanDraft } from "./PlanDraftPanel";
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
  aiSuggested = false,
}: {
  c: CatalogueCandidateView;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  name: string;
  /** Selected because the organizer applied an AI plan draft. */
  aiSuggested?: boolean;
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
            // The "price grows with each extra guest" concern is listed below; no second pill for it.
            <Pill tone="neutral">
              {formatMoney(c.priceMinor)} per attendee · up to {c.capacity} people
            </Pill>
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
        {selected && (
          <span className="mt-3 flex flex-wrap items-center gap-2 text-small font-bold text-coral-700">
            Selected
            {aiSuggested && (
              <span className="inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-dashed border-coral-600 bg-blush-50 px-3 py-0.5 text-[13px] text-coral-800">
                <Bot className="size-3.5" aria-hidden />
                AI suggestion · review
              </span>
            )}
          </span>
        )}
      </span>
    </label>
  );
}

function SponsorCard({ view, actions, aiSuggested = false }: { view: OutingView; actions: OutingActions; aiSuggested?: boolean }) {
  const guests = view.roster.people.filter((p) => p.role !== "ORGANIZER");
  const sponsored = view.roster.people.find((p) => p.payerType === "SPONSORED");
  // Default to the guest of honour the brief named ("cover Maya's share"), if they are invited.
  const honour = view.brief.extraction?.guestOfHonour.name?.trim().toLowerCase() ?? "";
  const named = honour ? guests.find((g) => g.displayName.trim().toLowerCase().split(/\s+/)[0] === honour.split(/\s+/)[0]) : undefined;
  const [picked, setPicked] = useState<string>("");
  // Derived (not frozen at first render): guests can be invited after this card mounts.
  const chosen = guests.some((g) => g.participantId === picked) ? picked : (named ?? guests[0])?.participantId ?? "";
  const { pending, error, run } = useAction();
  const selectId = useId();
  const canEdit = !!view.organizer?.can.editRoster;
  const guest = view.roster.people.find((p) => p.participantId === (sponsored?.participantId ?? chosen));
  const first = guest?.displayName.split(" ")[0] ?? "them";

  return (
    <Card as="section" aria-labelledby="sponsor-h" className="space-y-4">
      <h2 id="sponsor-h" className="text-h3">
        Treat someone special
      </h2>
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
                setPicked(next);
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
          <AiPrefillFrame active={aiSuggested}>
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
          </AiPrefillFrame>
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
  // The consent note sits under the card, not inside it: one level of nesting only.
  return (
    <div className="space-y-3">
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
              <MoneyRow label="People paying" value={estimates.projectedPayers} />
              {estimates.estimatedShareMinor !== null && (
                <MoneyRow label="Each person paying" value={formatMoney(estimates.estimatedShareMinor)} emphasis />
              )}
              {estimates.capMinor !== null && <MoneyRow label="The most anyone is asked to approve" value={formatMoney(estimates.capMinor)} />}
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
      </Card>
      <div className="flex items-start gap-3 rounded-[18px] border border-amber-line bg-amber-bg p-4 text-amber-ink">
        <Users className="mt-0.5 size-5 shrink-0" aria-hidden />
        <p>Everyone sees and approves this split before committing. If who pays changes, everyone approves again.</p>
      </div>
    </div>
  );
}

const PART_OF_DAY_HOUR: Record<string, number> = { MORNING: 10, AFTERNOON: 16, EVENING: 19, NIGHT: 21 };
const WEEKDAY_SHORT: Record<string, string> = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };

/**
 * Suggested times (in the outing's timezone): the activity on the next day matching the brief's date window
 * (e.g. Friday evening -> next Friday 19:00, at least 4 h away); commitments close 24 h from now, or 2 h before
 * the activity if that is sooner. The organizer can change both; the server validates them.
 */
export function suggestTimes(view: OutingView): { deadline: string; activity: string } {
  const tz = view.outing.displayTimezone;
  const now = Date.parse(view.outing.serverNow);
  const win = view.brief.extraction?.dateWindow;
  const hour = String(PART_OF_DAY_HOUR[win?.partOfDay ?? "EVENING"] ?? 19).padStart(2, "0");
  const wantDay = win?.dayOfWeek ? WEEKDAY_SHORT[win.dayOfWeek] : null;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  let activity = now + 2 * 24 * 3600_000;
  for (let d = 0; d < 15; d++) {
    const day = isoToZonedLocal(new Date(now + d * 24 * 3600_000).toISOString(), tz).slice(0, 10);
    const iso = zonedLocalToIso(`${day}T${hour}:00`, tz);
    if (!iso) continue;
    const t = Date.parse(iso);
    if (t - now < 4 * 3600_000) continue;
    if (wantDay && weekday.format(new Date(t)) !== wantDay) continue;
    activity = t;
    break;
  }
  const quarter = 15 * 60_000;
  const deadline = Math.floor(Math.min(now + 24 * 3600_000, activity - 2 * 3600_000) / quarter) * quarter;
  return { deadline: isoToZonedLocal(new Date(deadline).toISOString(), tz), activity: isoToZonedLocal(new Date(activity).toISOString(), tz) };
}

function OpenForm({
  view,
  actions,
  candidate,
  prefill,
}: {
  view: OutingView;
  actions: OutingActions;
  candidate: CatalogueCandidateView | undefined;
  /** Values from an applied AI plan draft (already validated by the server); the organizer can change any of them. */
  prefill?: AppliedPlanDraft["prefill"];
}) {
  const tz = view.outing.displayTimezone;
  const serverNow = Date.parse(view.outing.serverNow);
  const { pending, error, run } = useAction();
  const [dflt] = useState(() => suggestTimes(view));
  const [deadline, setDeadline] = useState(
    prefill?.deadline ?? (view.outing.deadlineAt ? isoToZonedLocal(view.outing.deadlineAt, tz) : dflt.deadline),
  );
  const [activity, setActivity] = useState(
    prefill?.activity ?? (view.outing.activityAt ? isoToZonedLocal(view.outing.activityAt, tz) : dflt.activity),
  );
  // Follows the number of paying guests (sponsoring someone lowers it) until the organizer edits it.
  const payers = view.roster.invitedPayers;
  const [minPayersEdit, setMinPayers] = useState<string | null>(prefill?.minPayers != null ? String(prefill.minPayers) : null);
  const minPayers = minPayersEdit ?? String(view.roster.minPayers ?? Math.max(1, payers));
  // Highlight a pre-filled value only while it is still the AI's suggestion.
  const aiDeadline = !!prefill?.deadline && deadline === prefill.deadline;
  const aiActivity = !!prefill?.activity && activity === prefill.activity;
  const aiMinPayers = prefill?.minPayers != null && minPayers === String(prefill.minPayers);
  const fromAi = aiDeadline || aiActivity || aiMinPayers;

  const deadlineIso = zonedLocalToIso(deadline, tz);
  const activityIso = zonedLocalToIso(activity, tz);
  let problem: string | null = null;
  if (!deadlineIso || !activityIso) problem = "Pick both a commitment deadline and an activity time.";
  else if (Date.parse(deadlineIso) <= serverNow) problem = "The commitment deadline must be in the future.";
  else if (Date.parse(deadlineIso) - serverNow > 48 * 3600_000) problem = "The commitment deadline can be at most 48 hours from now.";
  else if (Date.parse(activityIso) <= Date.parse(deadlineIso)) problem = "The activity must start after the commitment deadline.";
  const mp = Number(minPayers);
  if (!problem && (!Number.isInteger(mp) || mp < 1)) problem = "Minimum payers must be a whole number of at least 1.";
  if (!problem && mp > payers) problem = `Minimum payers can't be more than the ${payers} ${payers === 1 ? "person" : "people"} paying.`;
  const canOpen = !!view.organizer?.can.openCollection;
  const cap = candidate && candidate.pricingModel === "FIXED_TOTAL" && Number.isInteger(mp) && mp >= 1 ? Math.ceil(candidate.priceMinor / mp) : null;

  return (
    <Card as="section" aria-labelledby="open-h" className="space-y-4">
      <h2 id="open-h" className="text-h3">
        Open commitments
      </h2>
      <p className="text-ink-muted">Times in {tz}. The server enforces the deadline: within 48 hours and before the activity.</p>
      <div className="grid gap-4">
        <AiPrefillFrame active={aiDeadline}>
          <TextField label="Commit by" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </AiPrefillFrame>
        <AiPrefillFrame active={aiActivity}>
          <TextField label="Activity time" type="datetime-local" value={activity} onChange={(e) => setActivity(e.target.value)} />
        </AiPrefillFrame>
        <AiPrefillFrame active={aiMinPayers}>
          <TextField
            label="Minimum payers"
            type="number"
            min={1}
            max={Math.max(1, payers)}
            inputMode="numeric"
            value={minPayers}
            onChange={(e) => setMinPayers(e.target.value)}
            hint="Sets each person’s maximum. More payers lower the final share."
          />
        </AiPrefillFrame>
      </div>
      {deadlineIso && !problem && (
        <p className="text-small font-semibold" aria-live="polite">
          {cap !== null
            ? `Each payer authorizes up to ${formatMoney(cap)} by ${formatDeadline(deadlineIso, tz)}.`
            : `Everyone commits by ${formatDeadline(deadlineIso, tz)}.`}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-small font-semibold text-danger">
          {problem}
        </p>
      )}
      {fromAi && (
        <p className="flex items-start gap-2 rounded-[18px] bg-blush-50 p-3 text-small font-semibold text-coral-800">
          <Bot className="mt-0.5 size-4 shrink-0" aria-hidden />
          {AI_REVIEW_COPY}
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

/** The sponsorship on screen is still exactly what the applied AI draft suggested. */
function aiSponsorStill(view: OutingView, plan: AppliedPlanDraft | null): boolean {
  const s = plan?.sponsorApplied ? plan.response.draft.sponsor : null;
  if (!s) return false;
  const current = view.roster.people.find((p) => p.payerType === "SPONSORED")?.participantId ?? null;
  return current === s.participantId;
}

export function ProposalStage({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const { pending, error, run } = useAction();
  const proposal = view.proposal;
  const radioName = useId();
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [aiPlan, setAiPlan] = useState<AppliedPlanDraft | null>(null);
  const selectedId = optimistic ?? proposal?.selectedOfferingId ?? null;
  const selected = proposal?.candidates.find((c) => c.offeringId === selectedId);
  const proposed = view.budget.proposedBudgetMinor;

  if (!view.viewer.isOrganizer || !view.organizer) {
    return (
      <div className="space-y-6">
        <ScreenHeader
          view={view}
          title="The organizer is finalizing the plan"
          lead={
            proposed !== null
              ? `The group agreed on a ${formatMoney(proposed)} starting budget. You'll get a personal invitation to review and commit when it's ready.`
              : "You'll get a personal invitation to review and commit when it's ready."
          }
        />
        <p className="text-center text-small text-ink-muted">Nothing is charged until you review and authorize your own share.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScreenHeader view={view} title="Pick a place and a price" lead="These are the venues’ own prices. Picking one books nothing yet." />
      {view.organizer.can.draftPlan && <PlanDraftPanel view={view} actions={actions} applied={aiPlan} onApplied={setAiPlan} />}
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
              <p className="text-small text-ink-muted">Demo catalogue. Prices and availability are sample data.</p>
            )}
            {!proposal || proposal.candidates.length === 0 ? (
              <EmptyState icon={<Info className="size-6" />} title="No options yet">
                We couldn&apos;t find a venue that fits this plan. Try another budget round.
              </EmptyState>
            ) : (
              <div role="radiogroup" aria-label="Catalogue options" className="space-y-3">
                {proposal.candidates.map((c) => (
                  <CandidateCard
                    key={c.offeringId}
                    c={c}
                    name={radioName}
                    selected={selectedId === c.offeringId}
                    aiSuggested={!!aiPlan?.offeringApplied && aiPlan.response.draft.offeringId === c.offeringId}
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
          {view.organizer.can.addInvitees && <InvitePanel view={view} actions={actions} />}
        </div>
        <div className="space-y-6">
          {proposed !== null && (
            <Card tone="navy">
              <Eyebrow className="!text-cream/80">Agreed group budget</Eyebrow>
              <p className="font-money text-[40px] leading-[44px]">{formatMoney(proposed)}</p>
              <p className="text-cream/90">A starting point, not a merchant quote.</p>
            </Card>
          )}
          <SponsorCard view={view} actions={actions} aiSuggested={aiSponsorStill(view, aiPlan)} />
          <RosterToggles view={view} actions={actions} />
          <SplitPreview view={view} candidate={selected} />
          <OpenForm
            key={aiPlan ? `ai-${aiPlan.nonce}` : "manual"}
            view={view}
            actions={actions}
            candidate={selected}
            prefill={aiPlan?.prefill}
          />
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
