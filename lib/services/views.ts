/**
 * Read model for the participant hub: builds the server-authorized,
 * sanitized `OutingView` for ONE viewer.
 *
 * Privacy rules enforced here (not in CSS):
 * - other people's budget vote amounts never leave the server; before reveal
 *   only counts / hasVoted, after reveal only the stored aggregate,
 * - organizer-only data (AI candidates, organizer actions) only for the organizer,
 * - no tokens, no raw provider payloads; provider refs are redacted.
 */
import { FIXTURE_PAYMENT_LABEL, PAYPAL_SANDBOX_LABEL } from "../domain/labels";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import {
  budgetVotes,
  consents,
  merchants,
  offerings,
  outings,
  participants,
  paymentAttempts,
  quoteVersions,
  settlementSnapshots,
  type Merchant,
  type Offering,
  type Outing,
  type Participant,
  type PaymentAttempt,
  type QuoteVersion,
  type SettlementSnapshot,
} from "../db/schema";
import { participantFacingTitle } from "../demo/constants";
import { config } from "../env";
import { notFound } from "../http";
import { budgetFit, comparableCostMinor, type Headcount } from "../domain/budget-fit";
import { ceilDiv, estimatedShare } from "../domain/money";
import type { CommitmentTerms } from "../domain/policy";
import { type BudgetUnit, type OutingStatus, type PaymentStatus } from "../domain/types";
import { canRevealVotes, votesNeededToReveal } from "../domain/budget-reveal";
import type {
  CandidateBudgetView,
  CatalogueCandidateView,
  MyPaymentView,
  OutingStage,
  OutingView,
  PersonView,
  QuoteView,
} from "../contracts/views";
import {
  budgetOptionsFor,
  collectionWindowOpen,
  isActiveParticipant,
  isPreCollection,
  storedExtraction,
  storedProposal,
  storedReveal,
} from "./outings";
import { paymentModeForOuting } from "./payments";

/* ------------------------------- shared helpers ----------------------------- */

export function stageFor(status: OutingStatus): OutingStage {
  switch (status) {
    case "DRAFT":
      return "BRIEF";
    case "BUDGETING":
      return "BUDGET";
    case "PROPOSED":
      return "INVITE";
    case "COLLECTING":
      return "COMMIT";
    default:
      return "RESULT";
  }
}

/** "…4F2A" — never expose full provider identifiers in participant views. */
export function redactRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return `…${ref.slice(-4)}`;
}

export function providerLabel(provider: PaymentAttempt["provider"]): string {
  return provider === "PAYPAL" ? PAYPAL_SANDBOX_LABEL : FIXTURE_PAYMENT_LABEL;
}

const COMMITTED_STATUSES: ReadonlySet<PaymentStatus> = new Set(["AUTHORIZED", "CAPTURE_PENDING", "CAPTURED"]);

/**
 * A payer is committed when they hold a provider-verified, timely (not late)
 * authorization for the CURRENT quote. Browser redirects never count.
 */
export function isCommittedAttempt(a: PaymentAttempt, quote: Pick<QuoteVersion, "id" | "deadlineAt"> | null): boolean {
  if (!quote || a.quoteId !== quote.id) return false;
  if (!a.verified || a.late || !COMMITTED_STATUSES.has(a.status)) return false;
  if (a.authorizedAt && a.authorizedAt.getTime() > quote.deadlineAt.getTime()) return false;
  return true;
}

export function committedParticipantIds(
  people: readonly Participant[],
  attempts: readonly PaymentAttempt[],
  quote: Pick<QuoteVersion, "id" | "deadlineAt"> | null,
): Set<string> {
  const out = new Set<string>();
  for (const p of people) {
    if (p.payerType === "SPONSORED") {
      if (p.attendance === "ACCEPTED") out.add(p.id);
      continue;
    }
    if (!isActiveParticipant(p)) continue;
    if (attempts.some((a) => a.participantId === p.id && isCommittedAttempt(a, quote))) out.add(p.id);
  }
  return out;
}

export function parseTerms(quote: QuoteVersion): CommitmentTerms | null {
  const t = quote.terms as CommitmentTerms | null;
  return t && typeof t === "object" && Array.isArray(t.requiredParticipantIds) ? t : null;
}

/** Allocations from the immutable settlement snapshot (SETTLE only). */
export function snapshotAllocations(snapshot: SettlementSnapshot | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!snapshot || snapshot.decision !== "SETTLE") return out;
  const roster = snapshot.roster as { decision?: { kind?: string; allocations?: { participantId: string; allocationMinor: number }[] } } | null;
  const allocations = roster?.decision?.kind === "SETTLE" ? roster.decision.allocations ?? [] : [];
  for (const a of allocations) {
    if (a && typeof a.participantId === "string" && Number.isSafeInteger(a.allocationMinor)) out.set(a.participantId, a.allocationMinor);
  }
  return out;
}

export function snapshotSponsoredIds(snapshot: SettlementSnapshot | null | undefined): string[] {
  if (!snapshot || snapshot.decision !== "SETTLE") return [];
  const roster = snapshot.roster as { decision?: { kind?: string; sponsoredParticipantIds?: string[] } } | null;
  return roster?.decision?.kind === "SETTLE" ? roster.decision.sponsoredParticipantIds ?? [] : [];
}

export function buildQuoteView(
  quote: QuoteVersion,
  ctx: { merchant: Merchant | null; offering: Offering | null; people: readonly Participant[] },
): QuoteView {
  const terms = parseTerms(quote);
  const names = new Map(ctx.people.map((p) => [p.id, p.displayName]));
  return {
    id: quote.id,
    version: quote.version,
    merchantName: terms?.merchantName ?? ctx.merchant?.name ?? "",
    offeringName: terms?.offeringName ?? ctx.offering?.name ?? "",
    category: ctx.offering?.category ?? "",
    location: ctx.offering?.location ?? "",
    pricingModel: quote.pricingModel,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    capMinor: quote.capMinor,
    minPayers: quote.minPayers,
    capacity: quote.capacity,
    activityAt: quote.activityAt.toISOString(),
    deadlineAt: quote.deadlineAt.toISOString(),
    expiresAt: quote.expiresAt.toISOString(),
    termsHash: quote.termsHash,
    merchantConfirmedAt: quote.merchantConfirmedAt.toISOString(),
    availabilitySource: quote.availabilitySource === "MERCHANT_API" ? "MERCHANT_API" : "FIXTURE",
    sponsoredNames: (terms?.sponsoredParticipantIds ?? []).map((id) => names.get(id) ?? "Guest"),
    requiredCount: terms?.requiredParticipantIds.length ?? 0,
  };
}

/** The agreed budget and the roster it is compared against; null until a budget is agreed and someone pays. */
interface BudgetComparison {
  amountMinor: number;
  unit: BudgetUnit;
  headcount: Headcount;
}

/** The offering's cost in the budget's unit for the roster as it stands now, so covering a guest shows at once. */
function candidateBudget(offering: Offering, comparison: BudgetComparison | null): CandidateBudgetView | null {
  if (!comparison) return null;
  const fit = budgetFit(comparableCostMinor(offering, comparison.headcount, comparison.unit), comparison.amountMinor);
  return { costMinor: fit.costMinor, payers: comparison.headcount.payers, within: fit.kind === "WITHIN", overByMinor: fit.overByMinor };
}

function candidateView(
  offering: Offering,
  merchant: Merchant | undefined,
  ai: { fit: CatalogueCandidateView["fit"]; reasons: string[]; concerns: string[] } | null,
  comparison: BudgetComparison | null,
): CatalogueCandidateView {
  return {
    offeringId: offering.id,
    name: offering.name,
    merchantName: merchant?.name ?? "",
    category: offering.category,
    description: offering.description,
    location: offering.location,
    pricingModel: offering.pricingModel,
    // Display prices always come from OUR catalogue, never from AI text.
    priceMinor: offering.priceMinor,
    currency: offering.currency,
    capacity: offering.capacity,
    minAttendees: offering.minAttendees,
    fit: ai?.fit ?? null,
    reasons: ai?.reasons ?? [],
    concerns: ai?.concerns ?? [],
    budget: candidateBudget(offering, comparison),
  };
}

/* ---------------------------------- view ------------------------------------ */

export async function buildOutingView(
  db: DbOrTx,
  { outingId, participantId, now = new Date() }: { outingId: string; participantId: string; now?: Date },
): Promise<OutingView> {
  const outing: Outing | undefined = await db.query.outings.findFirst({ where: eq(outings.id, outingId) });
  if (!outing) throw notFound("Outing not found");
  const people = await db.query.participants.findMany({ where: eq(participants.outingId, outingId), orderBy: [asc(participants.sortKey)] });
  const viewer = people.find((p) => p.id === participantId);
  if (!viewer) throw notFound("Outing not found");
  const isOrganizer = viewer.role === "ORGANIZER";

  // Budget: only WHO voted in the current round (never amounts), plus the viewer's own amount.
  const voterRows = await db
    .select({ participantId: budgetVotes.participantId })
    .from(budgetVotes)
    .where(and(eq(budgetVotes.outingId, outingId), eq(budgetVotes.round, outing.budgetRound)));
  const voters = new Set(voterRows.map((r) => r.participantId));
  const [myVote] = await db
    .select({ amountMinor: budgetVotes.amountMinor })
    .from(budgetVotes)
    .where(and(eq(budgetVotes.outingId, outingId), eq(budgetVotes.round, outing.budgetRound), eq(budgetVotes.participantId, viewer.id)))
    .limit(1);

  const quote = outing.currentQuoteId
    ? ((await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId) })) ?? null)
    : null;

  // Offerings referenced by the quote, the selection and the stored AI proposal.
  const proposalStored = storedProposal(outing);
  const offeringIds = new Set<string>();
  if (quote) offeringIds.add(quote.offeringId);
  if (outing.selectedOfferingId) offeringIds.add(outing.selectedOfferingId);
  if (isOrganizer && proposalStored) for (const r of proposalStored.ranked) offeringIds.add(r.offeringId);
  const offeringRows = offeringIds.size
    ? await db.query.offerings.findMany({ where: inArray(offerings.id, [...offeringIds]) })
    : [];
  const offeringById = new Map(offeringRows.map((o) => [o.id, o]));
  const merchantIds = [...new Set(offeringRows.map((o) => o.merchantId))];
  const merchantRows = merchantIds.length ? await db.query.merchants.findMany({ where: inArray(merchants.id, merchantIds) }) : [];
  const merchantById = new Map(merchantRows.map((m) => [m.id, m]));

  const attempts = await db.query.paymentAttempts.findMany({
    where: eq(paymentAttempts.outingId, outingId),
    orderBy: [desc(paymentAttempts.createdAt)],
  });
  const myConsents = await db.query.consents.findMany({
    where: and(eq(consents.outingId, outingId), eq(consents.participantId, viewer.id)),
    orderBy: [desc(consents.acceptedAt)],
  });
  const snapshot = (await db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, outingId) })) ?? null;

  /* ---------------------------- roster figures ----------------------------- */
  const committed = committedParticipantIds(people, attempts, quote);
  const active = people.filter(isActiveParticipant);
  const activePayers = active.filter((p) => p.payerType === "PAYER");
  // Same rule the reveal endpoint enforces: 75% of the party, never below the privacy floor.
  const revealOpen = outing.status === "BUDGETING" && !outing.budgetRevealedAt && canRevealVotes(voters.size, active.length);
  const terms = quote ? parseTerms(quote) : null;
  const requiredIds = terms ? new Set(terms.requiredParticipantIds) : new Set(people.filter((p) => p.required).map((p) => p.id));
  const payersAuthorized = people.filter((p) => p.payerType === "PAYER" && committed.has(p.id)).length;

  const personViews: PersonView[] = people.map((p) => ({
    participantId: p.id,
    displayName: p.displayName,
    role: p.role,
    payerType: p.payerType,
    required: p.required,
    attendance: p.attendance,
    committed: committed.has(p.id),
    hasVoted: voters.has(p.id),
  }));

  const selectedOffering = outing.selectedOfferingId ? offeringById.get(outing.selectedOfferingId) ?? null : null;
  const quoteOffering = quote ? offeringById.get(quote.offeringId) ?? null : null;
  const capacity = quote?.capacity ?? selectedOffering?.capacity ?? null;

  /* ------------------------------- me -------------------------------------- */
  const windowOpen = collectionWindowOpen(outing, now);
  const pre = isPreCollection(outing.status);
  const iAmPayer = viewer.payerType === "PAYER";
  const iAmActive = isActiveParticipant(viewer);
  const latestConsent = myConsents.find((c) => c.withdrawnAt === null) ?? null;
  const consentCurrent = !!(latestConsent && quote && latestConsent.quoteId === quote.id && latestConsent.termsHash === quote.termsHash);
  const myAttempts = attempts.filter((a) => a.participantId === viewer.id);
  const myAttempt = (quote ? myAttempts.find((a) => a.quoteId === quote.id) : undefined) ?? myAttempts[0] ?? null;
  const iAmCommitted = committed.has(viewer.id);
  const blockingAttempt = myAttempts.some(
    (a) => quote && a.quoteId === quote.id && ["AUTHORIZED", "CAPTURE_PENDING", "CAPTURED", "UNKNOWN", "VOID_PENDING"].includes(a.status),
  );
  const hasHold = myAttempts.some((a) => ["AUTHORIZED", "APPROVAL_PENDING", "UNKNOWN"].includes(a.status));

  const can = {
    vote: outing.status === "BUDGETING" && !outing.budgetRevealedAt && iAmActive,
    accept:
      !isOrganizer &&
      viewer.attendance !== "ACCEPTED" &&
      viewer.attendance !== "WITHDRAWN" &&
      (pre || (windowOpen && viewer.payerType === "SPONSORED" && viewer.attendance === "PENDING")),
    decline:
      !isOrganizer &&
      viewer.attendance !== "DECLINED" &&
      viewer.attendance !== "WITHDRAWN" &&
      (pre || (windowOpen && !latestConsent && !hasHold)),
    consent: iAmPayer && iAmActive && windowOpen && !!quote && !consentCurrent,
    authorize: iAmPayer && iAmActive && windowOpen && consentCurrent && !iAmCommitted && !blockingAttempt,
    withdraw: iAmPayer && windowOpen && iAmActive && (!!latestConsent || hasHold),
  };

  const payment: MyPaymentView | null = myAttempt
    ? {
        paymentAttemptId: myAttempt.id,
        status: myAttempt.status,
        provider: myAttempt.provider,
        providerLabel: providerLabel(myAttempt.provider),
        authorizedMinor: myAttempt.authorizedMinor,
        capturedMinor: myAttempt.capturedMinor,
        refundedMinor: myAttempt.refundedMinor,
        late: myAttempt.late,
        verified: myAttempt.verified,
        authorizationRef: redactRef(myAttempt.authorizationId),
      }
    : null;

  /* ----------------------------- estimates ---------------------------------- */
  let estimates: OutingView["estimates"];
  if (quote) {
    const couldStillCommit = iAmPayer && !iAmCommitted && windowOpen && iAmActive;
    const projectedPayers = payersAuthorized + (couldStillCommit ? 1 : 0);
    estimates = {
      capMinor: quote.capMinor,
      projectedPayers,
      estimatedShareMinor: estimatedShare(quote.totalMinor, quote.minPayers, projectedPayers),
    };
  } else if (selectedOffering && selectedOffering.pricingModel === "FIXED_TOTAL") {
    estimates = {
      capMinor: null,
      projectedPayers: activePayers.length,
      estimatedShareMinor: activePayers.length > 0 ? ceilDiv(selectedOffering.priceMinor, activePayers.length) : null,
    };
  } else {
    estimates = { capMinor: null, projectedPayers: activePayers.length, estimatedShareMinor: null };
  }

  /* ------------------------------ budget ------------------------------------ */
  const reveal = storedReveal(outing);
  const revealed = !!outing.budgetRevealedAt && !!reveal && reveal.round === outing.budgetRound;

  /* ----------------------------- proposal ----------------------------------- */
  const comparison: BudgetComparison | null =
    outing.proposedBudgetMinor !== null && outing.proposedBudgetMinor > 0 && activePayers.length > 0
      ? { amountMinor: outing.proposedBudgetMinor, unit: outing.budgetUnit, headcount: { attendees: active.length, payers: activePayers.length } }
      : null;
  let proposal: OutingView["proposal"] = null;
  if (isOrganizer && (proposalStored || selectedOffering)) {
    const candidates: CatalogueCandidateView[] = [];
    for (const r of proposalStored?.ranked ?? []) {
      const o = offeringById.get(r.offeringId);
      if (!o || !o.active) continue;
      candidates.push(candidateView(o, merchantById.get(o.merchantId), { fit: r.fit, reasons: r.reasons, concerns: r.concerns }, comparison));
    }
    if (selectedOffering && !candidates.some((c) => c.offeringId === selectedOffering.id)) {
      candidates.push(candidateView(selectedOffering, merchantById.get(selectedOffering.merchantId), null, comparison));
    }
    proposal = {
      candidates,
      note: proposalStored?.note ?? null,
      source: proposalStored?.source ?? null,
      selectedOfferingId: outing.selectedOfferingId,
    };
  } else if (selectedOffering) {
    const ai = proposalStored?.ranked.find((r) => r.offeringId === selectedOffering.id) ?? null;
    proposal = {
      candidates: [
        candidateView(selectedOffering, merchantById.get(selectedOffering.merchantId), ai ? { fit: ai.fit, reasons: ai.reasons, concerns: ai.concerns } : null, comparison),
      ],
      note: null,
      source: ai ? proposalStored?.source ?? null : null,
      selectedOfferingId: selectedOffering.id,
    };
  }

  const extraction = storedExtraction(outing);
  const allocations = snapshotAllocations(snapshot);
  const cfg = config();

  const view: OutingView = {
    outing: {
      id: outing.id,
      // Scenario outings keep their hub label as the stored title; participants see the story name.
      title: participantFacingTitle(outing.title),
      brief: outing.brief,
      status: outing.status,
      stage: stageFor(outing.status),
      isFixture: outing.isFixture,
      currency: outing.currency,
      displayTimezone: outing.displayTimezone,
      activityAt: outing.activityAt?.toISOString() ?? null,
      deadlineAt: outing.deadlineAt?.toISOString() ?? null,
      serverNow: now.toISOString(),
      cancelReasons: outing.cancelReasons ?? [],
      cleanup: outing.cleanup,
      // Per outing, not per deployment: a demo outing's simulated holds are never labelled PayPal sandbox.
      paymentMode: paymentModeForOuting(outing),
      aiMode: cfg.aiMode,
      demoMode: cfg.demoFixturesEnabled,
    },
    viewer: {
      participantId: viewer.id,
      displayName: viewer.displayName,
      role: viewer.role,
      payerType: viewer.payerType,
      required: viewer.required,
      attendance: viewer.attendance,
      isOrganizer,
    },
    brief: {
      extraction: extraction?.extraction ?? null,
      source: extraction?.source ?? null,
      model: extraction?.model ?? null,
    },
    budget: {
      round: outing.budgetRound,
      unit: outing.budgetUnit,
      options: budgetOptionsFor(outing),
      myVoteMinor: myVote?.amountMinor ?? null,
      votedCount: voters.size,
      invitedCount: active.length,
      revealed,
      votesNeeded: votesNeededToReveal(active.length),
      canReveal: isOrganizer && revealOpen,
      aggregate: revealed ? reveal!.aggregate : null,
      aiSummary:
        revealed && reveal!.summary
          ? {
              headline: reveal!.summary.headline,
              summary: reveal!.summary.summary,
              // Reveals stored before per-person voting kept this under `suggestedTotalMinor`.
              suggestedAmountMinor: reveal!.summary.suggestedAmountMinor ?? reveal!.summary.suggestedTotalMinor ?? reveal!.aggregate.medianMinor,
              source: reveal!.summary.source,
              model: reveal!.summary.model,
            }
          : null,
      proposedBudgetMinor: outing.proposedBudgetMinor,
    },
    proposal,
    quote: quote ? buildQuoteView(quote, { merchant: quoteOffering ? merchantById.get(quoteOffering.merchantId) ?? null : null, offering: quoteOffering, people }) : null,
    roster: {
      people: personViews,
      capacity,
      minPayers: quote?.minPayers ?? outing.minPayers ?? null,
      invitedPayers: activePayers.length,
      sponsoredCount: active.filter((p) => p.payerType === "SPONSORED").length,
      attendeeCount: active.length,
      requiredInvited: requiredIds.size,
      requiredAccepted: [...requiredIds].filter((id) => committed.has(id)).length,
      payersAuthorized,
    },
    estimates,
    me: {
      consent: latestConsent
        ? {
            acceptedAt: latestConsent.acceptedAt.toISOString(),
            capMinor: latestConsent.capMinor,
            termsHash: latestConsent.termsHash,
            current: consentCurrent,
          }
        : null,
      payment,
      finalShareMinor: allocations.get(viewer.id) ?? (snapshot?.decision === "SETTLE" && viewer.payerType === "SPONSORED" && snapshotSponsoredIds(snapshot).includes(viewer.id) ? 0 : null),
      can,
    },
    organizer: isOrganizer
      ? {
          can: {
            startBudget: outing.status === "DRAFT",
            addInvitees: pre || windowOpen,
            reveal: revealOpen,
            newRound: outing.status === "BUDGETING" || outing.status === "PROPOSED",
            agreeBudget: outing.status === "BUDGETING",
            propose: outing.status === "BUDGETING" || outing.status === "PROPOSED",
            selectOffering: outing.status === "PROPOSED",
            editRoster: pre,
            openCollection:
              outing.status === "PROPOSED" && !!selectedOffering && selectedOffering.active && selectedOffering.pricingModel === "FIXED_TOTAL",
            cancel: pre || windowOpen,
            draftPlan:
              outing.status === "PROPOSED" &&
              cfg.aiMode !== "DISABLED" &&
              (!!outing.selectedOfferingId || (proposalStored?.ranked.length ?? 0) > 0),
          },
        }
      : null,
    settlement: snapshot
      ? {
          decision: snapshot.decision,
          frozenAt: snapshot.frozenAt.toISOString(),
          payerCount: snapshot.payerCount,
          totalMinor: snapshot.totalMinor,
          reasons: snapshot.reasons ?? [],
        }
      : null,
  };
  return view;
}
