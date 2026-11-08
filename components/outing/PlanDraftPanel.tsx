"use client";
/**
 * "Ask AI to draft the plan": fetches a validated draft (POST /api/outings/:id/plan-draft) and pre-fills the
 * organizer's proposal screen. The AI never overrides a choice the organizer already made: an offering or a
 * sponsored guest is applied (through the organizer's own reversible preview actions) only when none is chosen
 * yet; otherwise a different suggestion is shown as a note. Times and minimum payers only pre-fill the local
 * form. Nothing is booked, consented to or charged: "Open commitments" stays the only way forward.
 */
import { Bot, Check, Info, TriangleAlert } from "lucide-react";
import type { PlanDraftField, PlanDraftResponse } from "@/lib/ai/types";
import type { OutingView } from "@/lib/contracts/views";
import { AiSourceBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { describeError, errorSummary } from "@/components/errors/friendlyError";
import { request, type OutingActions } from "./api";
import { formatWhenFull, isoToZonedLocal } from "./format";
import { ActionErrorBanner, useAction } from "./useAction";

export const AI_REVIEW_COPY = "Review every field. The AI only suggests; you decide, and each payer still approves their own terms.";

export interface AppliedPlanDraft {
  /** Changes on every draft so the form re-initializes from the new suggestions. */
  nonce: number;
  response: PlanDraftResponse;
  /** "YYYY-MM-DDTHH:mm" in the outing's display timezone (converted from the UTC instants). */
  prefill: { activity: string | null; deadline: string | null; minPayers: number | null };
  offeringApplied: boolean;
  sponsorApplied: boolean;
  /** Suggestions the server refused when applying them (e.g. the offering became unavailable). */
  notApplied: string[];
}

const FIELD_LABEL: Record<PlanDraftField, string> = {
  offeringId: "Offering",
  activityStart: "Activity time",
  deadline: "Commit by",
  minPayers: "Minimum payers",
  sponsor: "Sponsored guest",
};

/** Dashed coral frame + label marking a value the AI pre-filled and the organizer has not changed. */
export function AiPrefillFrame({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <div className="rounded-[18px] border-[1.5px] border-dashed border-coral-600 bg-blush-50 p-3">
      <p className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-bold text-coral-800">
        <Bot className="size-3.5" aria-hidden />
        AI suggestion · review
      </p>
      {children}
    </div>
  );
}

async function applyDraft(view: OutingView, actions: OutingActions, res: PlanDraftResponse): Promise<Omit<AppliedPlanDraft, "nonce">> {
  const d = res.draft;
  const notApplied: string[] = [];
  let offeringApplied = false;
  if (d.offeringId) {
    const selected = view.proposal?.selectedOfferingId ?? null;
    if (d.offeringId === selected) offeringApplied = true;
    else if (selected) {
      // Never override the organizer's own choice.
      notApplied.push(`AI suggested ${d.offeringName ?? "another offering"}; your current selection was kept. Change it yourself if you agree.`);
    } else {
      try {
        await actions.select(d.offeringId);
        offeringApplied = true;
      } catch (e) {
        notApplied.push(`${d.offeringName ?? "Offering"}: ${errorSummary(describeError(e, "draft"))}`);
      }
    }
  }
  let sponsorApplied = false;
  if (d.sponsor) {
    const current = view.roster.people.find((p) => p.payerType === "SPONSORED")?.participantId ?? null;
    const target = d.sponsor.participantId;
    if (current === target) sponsorApplied = true;
    else if (current) {
      // Never remove or replace a sponsorship the organizer set; only suggest.
      notApplied.push(
        target
          ? `AI suggested covering ${d.sponsor.displayName ?? "another guest"}; your current sponsored guest was kept.`
          : "AI suggested no sponsored guest; your current sponsored guest was kept.",
      );
    } else if (target) {
      try {
        await actions.patchParticipant(target, { payerType: "SPONSORED" });
        sponsorApplied = true;
      } catch (e) {
        notApplied.push(`Sponsored guest: ${errorSummary(describeError(e, "draft"))}`);
      }
    }
  }
  await actions.refresh();
  const tz = view.outing.displayTimezone;
  return {
    response: res,
    prefill: {
      activity: d.activityAt ? isoToZonedLocal(d.activityAt, tz) : null,
      deadline: d.deadlineAt ? isoToZonedLocal(d.deadlineAt, tz) : null,
      minPayers: d.minPayers,
    },
    offeringApplied,
    sponsorApplied,
    notApplied,
  };
}

function DraftSummary({ view, applied }: { view: OutingView; applied: AppliedPlanDraft }) {
  const { draft, dropped } = applied.response;
  const tz = view.outing.displayTimezone;
  const rows: { label: string; value: string | null }[] = [
    { label: "Offering", value: applied.offeringApplied ? draft.offeringName : null },
    { label: "Activity", value: draft.activityAt ? formatWhenFull(draft.activityAt, tz) : null },
    { label: "Commit by", value: draft.deadlineAt ? formatWhenFull(draft.deadlineAt, tz) : null },
    { label: "Minimum payers", value: draft.minPayers !== null ? String(draft.minPayers) : null },
    {
      label: "Sponsored guest",
      value:
        draft.sponsor && applied.sponsorApplied
          ? draft.sponsor.displayName
            ? `Cover ${draft.sponsor.displayName}'s share`
            : "Nobody; everyone attending pays"
          : null,
    },
  ];
  const filled = rows.filter((r) => r.value !== null);
  const notes = [
    ...dropped.map((x) => ({ key: `d-${x.field}-${x.reason}`, label: FIELD_LABEL[x.field], text: x.reason })),
    ...applied.notApplied.map((t, i) => ({ key: `n-${i}`, label: "Not applied", text: t })),
  ];

  return (
    <div className="pop-in space-y-4 rounded-[18px] border border-line bg-surface p-4">
      <p className="font-bold">
        {filled.length > 0 ? "Suggestions filled in. Review the highlighted fields." : "Nothing could be filled in. The form is unchanged."}
      </p>
      {filled.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-[auto_1fr]">
          {filled.map((r) => (
            <div key={r.label} className="contents">
              <dt className="font-semibold text-ink-muted">{r.label}</dt>
              <dd className="mb-1 sm:mb-0">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {draft.rationale.length > 0 && (
        <div>
          <h3 className="text-small font-bold">Why</h3>
          <ul className="mt-1 space-y-1 text-small">
            {draft.rationale.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-captured" aria-hidden />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft.cautions.length > 0 && (
        <div>
          <h3 className="text-small font-bold">Double-check</h3>
          <ul className="mt-1 space-y-1 text-small text-void-pending">
            {draft.cautions.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <h3 className="text-small font-bold">Left for you</h3>
          <p className="text-small text-ink-muted">These suggestions failed our checks, so they were not filled in.</p>
          <ul className="mt-1 space-y-1 text-small">
            {notes.map((n) => (
              <li key={n.key} className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                <span>
                  <span className="font-semibold">{n.label}:</span> {n.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {filled.length > 0 && notes.length === 0 && (
        <p className="text-small text-ink-muted">Every suggestion passed our availability, deadline and roster checks.</p>
      )}
    </div>
  );
}

export function PlanDraftPanel({
  view,
  actions,
  applied,
  onApplied,
}: {
  view: OutingView;
  actions: OutingActions;
  applied: AppliedPlanDraft | null;
  onApplied: (draft: AppliedPlanDraft) => void;
}) {
  const { pending, error, run } = useAction();
  const aiMode = view.outing.aiMode;
  const source = applied?.response.source ?? (aiMode === "DISABLED" ? null : aiMode);
  const ask = () =>
    run("draft", async () => {
      const res = await request<PlanDraftResponse>(`/api/outings/${view.outing.id}/plan-draft`, { method: "POST" });
      const result = await applyDraft(view, actions, res);
      onApplied({ ...result, nonce: Date.now() });
    });

  return (
    <Card as="section" aria-labelledby="ai-plan-h" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ai-plan-h" className="text-h3">
          Draft the plan with AI
        </h2>
        <AiSourceBadge source={source} />
      </div>
      <p className="text-ink-muted">
        From your brief, the agreed budget and the ranked options, the AI suggests the offering, activity time, commitment deadline,
        minimum payers and who is covered. It never sees individual budget votes.
      </p>
      <p className="font-semibold">{AI_REVIEW_COPY}</p>
      <Button variant="secondary" loading={pending === "draft"} loadingLabel="Drafting…" onClick={ask} disabled={!view.organizer?.can.draftPlan}>
        <Bot className="size-5" aria-hidden />
        {applied ? "Ask AI again" : "Ask AI to draft the plan"}
      </Button>
      <ActionErrorBanner error={error} />
      <div aria-live="polite">{applied && <DraftSummary view={view} applied={applied} />}</div>
      {applied && (
        <p className="text-small text-ink-muted">Nothing is booked, sent to your guests or charged until you press Open commitments.</p>
      )}
    </Card>
  );
}
