/**
 * Merchant dashboard read models and the ONLY merchant write: re-queueing an
 * existing FAILED/UNKNOWN payment operation of the merchant's own outing.
 *
 * Money vocabulary (never conflated):
 * - authorized = uncaptured AUTHORIZED holds — NOT revenue,
 * - allocated  = sum of allocations in the frozen settlement snapshot,
 * - captured / refunded = provider-confirmed amounts on the attempts.
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client";
import {
  aiRuns,
  auditEvents,
  consents,
  merchants,
  offerings,
  outings,
  participants,
  paymentAttempts,
  paymentOperations,
  quoteVersions,
  settlementSnapshots,
  type Consent,
  type Merchant,
  type Offering,
  type Outing,
  type Participant,
  type PaymentAttempt,
  type PaymentOperation,
  type QuoteVersion,
  type SettlementSnapshot,
} from "../db/schema";
import { ServiceError, badRequest, conflict, notFound } from "../http";
import { assertUuid } from "./access";
import { recordAudit } from "../audit";
import { enqueueJob, operationsJobKey } from "../jobs/queue";
import type { MerchantBookingRow, MerchantOperationRow, MerchantOutingDetail, MerchantParticipantRow } from "../contracts/views";
import type { PaymentProviderName } from "../domain/types";
import { getOutingsAi } from "../ai";
import { DashboardQuerySchema, type AiSource, type DashboardQuery } from "../ai/types";
import { config } from "../env";
import { isActiveParticipant } from "./outings";
import { buildQuoteView, committedParticipantIds, parseTerms, snapshotAllocations, snapshotSponsoredIds } from "./views";
import { sameLocalDate } from "./catalogue";

interface OutingBundle {
  outing: Outing;
  quote: QuoteVersion | null;
  offering: Offering | null;
  people: Participant[];
  attempts: PaymentAttempt[];
  snapshot: SettlementSnapshot | null;
}

async function loadBundles(db: DbOrTx, outingRows: Outing[]): Promise<OutingBundle[]> {
  if (outingRows.length === 0) return [];
  const ids = outingRows.map((o) => o.id);
  const quoteIds = outingRows.map((o) => o.currentQuoteId).filter((x): x is string => !!x);
  const [quotes, people, attempts, snapshots] = await Promise.all([
    quoteIds.length ? db.query.quoteVersions.findMany({ where: inArray(quoteVersions.id, quoteIds) }) : Promise.resolve([]),
    db.query.participants.findMany({ where: inArray(participants.outingId, ids), orderBy: [asc(participants.sortKey)] }),
    db.query.paymentAttempts.findMany({ where: inArray(paymentAttempts.outingId, ids), orderBy: [desc(paymentAttempts.createdAt)] }),
    db.query.settlementSnapshots.findMany({ where: inArray(settlementSnapshots.outingId, ids) }),
  ]);
  const offeringIds = [...new Set(quotes.map((q) => q.offeringId))];
  const offeringRows = offeringIds.length ? await db.query.offerings.findMany({ where: inArray(offerings.id, offeringIds) }) : [];
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const offeringById = new Map(offeringRows.map((o) => [o.id, o]));
  return outingRows.map((outing) => {
    const quote = outing.currentQuoteId ? quoteById.get(outing.currentQuoteId) ?? null : null;
    return {
      outing,
      quote,
      offering: quote ? offeringById.get(quote.offeringId) ?? null : null,
      people: people.filter((p) => p.outingId === outing.id),
      attempts: attempts.filter((a) => a.outingId === outing.id),
      snapshot: snapshots.find((s) => s.outingId === outing.id) ?? null,
    };
  });
}

function bookingRow(b: OutingBundle, merchant: Merchant, now: Date): MerchantBookingRow {
  const { outing, quote, attempts, people, snapshot } = b;
  const committed = committedParticipantIds(people, attempts, quote);
  const terms = quote ? parseTerms(quote) : null;
  const requiredIds = terms?.requiredParticipantIds ?? people.filter((p) => p.required).map((p) => p.id);
  const requiredAccepted = requiredIds.filter((id) => committed.has(id)).length;
  const providers = new Set<PaymentProviderName>(attempts.map((a) => a.provider));
  const allocations = snapshotAllocations(snapshot);
  const deadline = outing.deadlineAt;
  const attendees =
    snapshot && snapshot.decision === "SETTLE"
      ? allocations.size + snapshotSponsoredIds(snapshot).length
      : people.filter(isActiveParticipant).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    outingId: outing.id,
    title: outing.title,
    offeringName: b.offering?.name ?? terms?.offeringName ?? null,
    status: outing.status,
    recoveryStatus: outing.cleanup,
    isFixture: outing.isFixture,
    provider: providers.size === 0 ? null : providers.size === 1 ? [...providers][0] : "MIXED",
    currency: quote?.currency ?? outing.currency,
    activityAt: outing.activityAt?.toISOString() ?? null,
    deadlineAt: deadline?.toISOString() ?? null,
    closesInMinutes: deadline ? Math.round((deadline.getTime() - now.getTime()) / 60_000) : null,
    closesToday: !!deadline && deadline.getTime() > now.getTime() && sameLocalDate(deadline, now, merchant.timezone),
    merchantTimezone: merchant.timezone,
    requiredInvited: requiredIds.length,
    requiredAccepted,
    missingRequired: requiredIds.length - requiredAccepted,
    payersAuthorized: people.filter((p) => p.payerType === "PAYER" && committed.has(p.id)).length,
    minPayers: quote?.minPayers ?? outing.minPayers ?? null,
    capacity: quote?.capacity ?? outing.maxAttendees ?? null,
    attendees,
    totalMinor: quote?.totalMinor ?? null,
    capMinor: quote?.capMinor ?? null,
    authorizedTotalMinor: sum(attempts.filter((a) => a.status === "AUTHORIZED").map((a) => a.authorizedMinor)),
    allocatedTotalMinor: sum([...allocations.values()]),
    capturedTotalMinor: sum(attempts.map((a) => a.capturedMinor)),
    refundedTotalMinor: sum(attempts.map((a) => a.refundedMinor)),
    voidPendingCount: attempts.filter((a) => a.status === "VOID_PENDING").length,
    refundPendingCount: attempts.filter((a) => a.status === "REFUND_PENDING").length,
    updatedAt: outing.updatedAt.toISOString(),
  };
}

async function loadMerchant(db: DbOrTx, merchantId: string): Promise<Merchant> {
  const m = await db.query.merchants.findFirst({ where: eq(merchants.id, merchantId) });
  if (!m) throw notFound("Merchant not found");
  return m;
}

/** Bookings = outings with terms (a quote) at this merchant. Scoped strictly to `merchantId`. */
export async function listBookingRows(db: DbOrTx, merchantId: string, now: Date = new Date()): Promise<MerchantBookingRow[]> {
  const merchant = await loadMerchant(db, merchantId);
  const rows = await db.query.outings.findMany({
    where: and(eq(outings.merchantId, merchantId), isNotNull(outings.currentQuoteId)),
    orderBy: [asc(outings.deadlineAt)],
  });
  const bundles = await loadBundles(db, rows);
  return bundles.map((b) => bookingRow(b, merchant, now));
}

function actorLabel(actor: string, names: Map<string, string>): string {
  if (actor.startsWith("PARTICIPANT:")) return names.get(actor.slice("PARTICIPANT:".length)) ?? "Participant";
  if (actor.startsWith("WORKER:")) return "Deadline worker";
  if (actor === "MERCHANT") return "Merchant";
  if (actor === "WEBHOOK") return "PayPal webhook";
  return "System";
}

export async function getOutingDetail(db: DbOrTx, merchantId: string, outingId: string, now: Date = new Date()): Promise<MerchantOutingDetail> {
  assertUuid(outingId, "outing");
  const merchant = await loadMerchant(db, merchantId);
  const outing = await db.query.outings.findFirst({ where: eq(outings.id, outingId) });
  // Not-found (not forbidden) for other merchants' outings: do not reveal existence.
  if (!outing || outing.merchantId !== merchantId || !outing.currentQuoteId) throw notFound("Outing not found");
  const [bundle] = await loadBundles(db, [outing]);
  const booking = bookingRow(bundle, merchant, now);
  const { quote, people, attempts, snapshot } = bundle;
  const names = new Map(people.map((p) => [p.id, p.displayName]));
  const allocations = snapshotAllocations(snapshot);
  const consentRows: Consent[] = await db.query.consents.findMany({ where: eq(consents.outingId, outingId), orderBy: [desc(consents.acceptedAt)] });
  const quoteVersionsById = new Map(
    (await db.query.quoteVersions.findMany({ where: eq(quoteVersions.outingId, outingId) })).map((q) => [q.id, q.version]),
  );

  const participantRows: MerchantParticipantRow[] = people.map((p) => {
    const c = consentRows.find((x) => x.participantId === p.id && x.withdrawnAt === null) ?? null;
    const mine = attempts.filter((a) => a.participantId === p.id);
    const a = (quote ? mine.find((x) => x.quoteId === quote.id) : undefined) ?? mine[0] ?? null;
    return {
      participantId: p.id,
      displayName: p.displayName,
      role: p.role,
      payerType: p.payerType,
      required: p.required,
      attendance: p.attendance,
      consentQuoteVersion: c ? quoteVersionsById.get(c.quoteId) ?? null : null,
      consentAcceptedAt: c?.acceptedAt.toISOString() ?? null,
      consentCurrent: !!(c && quote && c.quoteId === quote.id && c.termsHash === quote.termsHash),
      paymentStatus: a?.status ?? null,
      provider: a?.provider ?? null,
      late: a?.late ?? false,
      orderRef: a?.providerOrderId ?? null,
      authorizationRef: a?.authorizationId ?? null,
      captureRef: a?.captureId ?? null,
      refundRef: a?.refundId ?? null,
      authorizedMinor: a?.authorizedMinor ?? 0,
      allocationMinor: allocations.has(p.id) ? allocations.get(p.id)! : null,
      capturedMinor: a?.capturedMinor ?? 0,
      refundedMinor: a?.refundedMinor ?? 0,
    };
  });

  const ops = await db.query.paymentOperations.findMany({
    where: eq(paymentOperations.outingId, outingId),
    orderBy: [asc(paymentOperations.sequence), asc(paymentOperations.createdAt)],
  });
  const attemptOwner = new Map(attempts.map((a) => [a.id, a.participantId]));
  const operationRows: MerchantOperationRow[] = ops.map((op) => ({
    operationId: op.id,
    participantName: names.get(attemptOwner.get(op.paymentAttemptId) ?? "") ?? "Participant",
    kind: op.kind,
    status: op.status,
    amountMinor: op.amountMinor,
    attempts: op.attempts,
    lastError: op.lastError ? op.lastError.slice(0, 300) : null,
    providerStatus: op.providerStatus,
    updatedAt: op.updatedAt.toISOString(),
    canRetry: isRetryable(op),
  }));

  const events = await db.query.auditEvents.findMany({
    where: eq(auditEvents.outingId, outingId),
    orderBy: [asc(auditEvents.createdAt)],
    limit: 500,
  });
  const quoteOffering = quote ? await db.query.offerings.findFirst({ where: eq(offerings.id, quote.offeringId) }) : null;

  return {
    booking,
    quote: quote ? buildQuoteView(quote, { merchant, offering: quoteOffering ?? null, people }) : null,
    participants: participantRows,
    operations: operationRows,
    timeline: events.map((e) => ({ at: e.createdAt.toISOString(), actor: actorLabel(e.actor, names), type: e.type })),
  };
}

/**
 * Retryable = outcome UNKNOWN (must be reconciled, then re-sent with the same
 * request id) or a FAILED attempt the engine left open (`completedAt` null).
 * A FAILED op with `completedAt` set is a definitive provider refusal: final.
 */
export function isRetryable(op: Pick<PaymentOperation, "status" | "completedAt">): boolean {
  return op.status === "UNKNOWN" || (op.status === "FAILED" && op.completedAt === null);
}

/**
 * Safe manual recovery: re-queue an EXISTING FAILED/UNKNOWN operation of the
 * merchant's own outing. Keeps the same requestId (PayPal-Request-Id), so a
 * retry can never create a second money movement; never creates new operations.
 */
export async function retryOperation(
  db: Db,
  merchantId: string,
  operationId: string,
  now: Date = new Date(),
): Promise<{ operationId: string; status: string; nextAttemptAt: string }> {
  assertUuid(operationId, "operation");
  return db.transaction(async (tx) => {
    const [op] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)).for("update");
    if (!op) throw notFound("Operation not found");
    const outing = await tx.query.outings.findFirst({ where: eq(outings.id, op.outingId) });
    if (!outing || outing.merchantId !== merchantId) throw notFound("Operation not found");
    if (op.status !== "FAILED" && op.status !== "UNKNOWN") {
      throw conflict("NOT_RETRYABLE", `Only failed or unknown operations can be retried (this one is ${op.status})`);
    }
    if (!isRetryable(op)) {
      throw conflict("NOT_RETRYABLE", "The provider definitively refused this operation; recovery has already been planned");
    }
    const exhausted = op.attempts >= op.maxAttempts;
    await tx
      .update(paymentOperations)
      .set({ nextAttemptAt: now, ...(exhausted ? { attempts: 0 } : {}), updatedAt: now })
      .where(eq(paymentOperations.id, op.id));
    await enqueueJob(tx, {
      kind: "PROCESS_OPERATIONS",
      outingId: op.outingId,
      runAt: now,
      dedupeKey: operationsJobKey(op.outingId),
      onConflict: "requeue",
    });
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: "MERCHANT",
      type: "OPERATION_RETRY_REQUESTED",
      data: { operationId: op.id, kind: op.kind, previousStatus: op.status, attemptsReset: exhausted },
    });
    return { operationId: op.id, status: op.status, nextAttemptAt: now.toISOString() };
  });
}

export interface DashboardQueryResult {
  query: DashboardQuery;
  source: AiSource;
  model: string | null;
  warnings: string[];
}

export const MAX_DASHBOARD_QUESTION_CHARS = 300;

/**
 * Natural-language dashboard question -> validated, READ-ONLY filter spec.
 * The result is data for the client-side grid; it cannot invoke any service,
 * let alone capture/void/refund.
 */
export async function dashboardQuery(db: DbOrTx, question: string, now: Date = new Date()): Promise<DashboardQueryResult> {
  const q = question.replace(/\s+/g, " ").trim().slice(0, MAX_DASHBOARD_QUESTION_CHARS);
  if (!q) throw badRequest("INVALID_QUESTION", "Ask a question about your bookings");
  let source: string = config().aiMode;
  try {
    const ai = getOutingsAi();
    source = ai.source;
    const result = await ai.dashboardQuery({ question: q, now });
    const query = DashboardQuerySchema.parse(result.output);
    await db.insert(aiRuns).values({ outingId: null, purpose: "DASHBOARD_QUERY", source: result.source, model: result.model, ok: true, output: query });
    return { query, source: result.source, model: result.model, warnings: result.warnings.slice(0, 10) };
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    await db.insert(aiRuns).values({ outingId: null, purpose: "DASHBOARD_QUERY", source, model: null, ok: false, error: message.slice(0, 300) });
    throw new ServiceError("AI_UNAVAILABLE", 503, "The assistant could not answer that right now. Filters still work.");
  }
}
