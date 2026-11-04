/**
 * Deadline settlement: freeze the roster, re-verify every hold with the
 * provider, decide SETTLE or CANCEL with the pure policy, write the immutable
 * snapshot and plan every capture / void as durable operations.
 *
 * Guarantees
 * - Never settles before the stored deadline (DB clock), however late or
 *   early the job runs. Workers may run minutes late; the deadline is the
 *   stored one, not "when the job ran".
 * - Idempotent: a second run finds the snapshot (or a non-COLLECTING status)
 *   and does nothing but make sure planned operations get processed.
 * - No SQL transaction is held across a provider call. The decision
 *   transaction locks the outing row, re-reads everything inside the lock,
 *   and inserts the snapshot (unique per outing) atomically with the status
 *   change and the planned operations.
 */
import { eq, sql } from "drizzle-orm";
import {
  consents,
  outings,
  participants,
  paymentAttempts,
  quoteVersions,
  settlementSnapshots,
  type Outing,
  type PaymentAttempt,
} from "../db/schema";
import type { Db, Tx } from "../db/client";
import { assertCurrency } from "../domain/money";
import { decideSettlement, PolicyError, type SettlementDecision, type SettlementInput } from "../domain/policy";
import { assertOutingTransition } from "../domain/state-machine";
import type { CancelReason, PaymentStatus, SettlementDecisionKind } from "../domain/types";
import { planPaymentOperation } from "../payments/plan";
import { enqueueJob, operationsJobKey } from "../jobs/queue";
import { recordAudit } from "../audit";
import { checkMerchantAvailability, type MerchantAvailability } from "./availability";
import { reconcileAttempt } from "./reconcile";
import { recomputeCleanup } from "./operations";
import { moveAttempt, patchAttempt, truncateError } from "./attempts";
import type { PlannedCapture, SettlementRoster, SettlementTrigger } from "./snapshot";
import { workerActor, type ProviderResolver } from "./types";

export type EarlyCancelReason = "ORGANIZER_CANCELLED" | "REQUIRED_DECLINED";

export interface RunDeadlineSettlementOptions {
  outingId: string;
  now: Date;
  workerId: string;
  /** Evaluate before the deadline. Only ever cancels (or does nothing). */
  early?: boolean;
  reason?: EarlyCancelReason;
  /** The quote the job was scheduled for; a stale job (terms renewed) is a no-op. */
  quoteId?: string;
}

export type DeadlineSettlementResult =
  | { outcome: "NOT_FOUND" }
  | { outcome: "ALREADY_SETTLED"; decision: SettlementDecisionKind }
  | { outcome: "NOT_COLLECTING"; status: Outing["status"] }
  | { outcome: "NOT_DUE"; deadlineAt: Date }
  | { outcome: "STALE_QUOTE" }
  | { outcome: "STILL_FEASIBLE" }
  | { outcome: "SETTLE"; snapshotId: string; captures: number; voids: number }
  | { outcome: "CANCEL"; snapshotId: string; reasons: CancelReason[]; voids: number };

/** Attempt statuses worth re-reading from the provider before a decision. */
const RECONCILABLE: ReadonlySet<PaymentStatus> = new Set(["CREATED", "APPROVAL_PENDING", "AUTHORIZED", "UNKNOWN"]);
/** Attempts that may hold funds at the provider when the roster freezes. */
const HOLD_LIKE: ReadonlySet<PaymentStatus> = new Set(["AUTHORIZED", "UNKNOWN"]);

async function ensureOperationsScheduled(db: Db, outingId: string, now: Date): Promise<void> {
  await enqueueJob(db, { kind: "PROCESS_OPERATIONS", outingId, runAt: now, dedupeKey: operationsJobKey(outingId), onConflict: "requeue" });
}

export async function runDeadlineSettlement(
  db: Db,
  resolveProvider: ProviderResolver,
  opts: RunDeadlineSettlementOptions,
): Promise<DeadlineSettlementResult> {
  const { now, workerId } = opts;
  const actor = workerActor(workerId);
  const early = opts.early === true;
  const trigger: SettlementTrigger = early ? (opts.reason === "ORGANIZER_CANCELLED" ? "ORGANIZER_CANCELLED" : "REQUIRED_DECLINED") : "DEADLINE";

  const outing = await db.query.outings.findFirst({ where: eq(outings.id, opts.outingId) });
  if (!outing) return { outcome: "NOT_FOUND" };

  const existing = await db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, outing.id) });
  if (existing) {
    await ensureOperationsScheduled(db, outing.id, now);
    return { outcome: "ALREADY_SETTLED", decision: existing.decision };
  }
  if (outing.status !== "COLLECTING") return { outcome: "NOT_COLLECTING", status: outing.status };
  if (!outing.currentQuoteId || !outing.deadlineAt) throw new Error(`outing ${outing.id} is COLLECTING without a quote or deadline`);
  if (opts.quoteId && opts.quoteId !== outing.currentQuoteId) return { outcome: "STALE_QUOTE" };

  if (!early) {
    // CAS freeze on the DATABASE clock. Zero rows means: not due, already frozen, or no longer collecting.
    const frozen = await db.execute(sql`
      update outings set frozen_at = now(), updated_at = now()
      where id = ${outing.id} and status = 'COLLECTING' and frozen_at is null and deadline_at <= now()
      returning frozen_at
    `);
    if (frozen.rows.length > 0) {
      await recordAudit(db, { outingId: outing.id, actor, type: "ROSTER_FROZEN", data: { deadlineAt: outing.deadlineAt.toISOString() } });
    } else {
      const again = await db.query.outings.findFirst({ where: eq(outings.id, outing.id) });
      if (!again || again.status !== "COLLECTING") return { outcome: "NOT_COLLECTING", status: again?.status ?? "CANCELLED" };
      if (!again.frozenAt) return { outcome: "NOT_DUE", deadlineAt: again.deadlineAt ?? outing.deadlineAt };
      // Frozen earlier but no snapshot: a previous run stopped between freeze and decision. Resume.
    }
  }

  // 1. Reconcile every relevant hold with the provider — outside any transaction.
  const attempts = await db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, outing.id) });
  const reconcileNotes: string[] = [];
  for (const attempt of attempts) {
    if (!RECONCILABLE.has(attempt.status)) continue;
    try {
      const r = await reconcileAttempt(db, resolveProvider, { attemptId: attempt.id, now, workerId, deadlineAt: outing.deadlineAt, deferLateVoid: true });
      if (r.read === "FAILED" || r.note) reconcileNotes.push(`${attempt.id}: ${r.read}${r.note ? ` (${r.note})` : ""}`);
    } catch (err) {
      // Fail closed for this person: a hold whose provider state could not be re-read (adapter threw,
      // e.g. its provider is not configured any more) is unverified — exactly like a failed read.
      const message = `provider unavailable: ${err instanceof Error ? err.message : String(err)}`;
      reconcileNotes.push(`${attempt.id}: ERROR ${message}`);
      try {
        const current = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attempt.id) });
        if (current && current.status === "AUTHORIZED" && current.verified) {
          await patchAttempt(db, current.id, { verified: false, verifiedAt: now, lastError: truncateError(message) }, now);
        }
      } catch (inner) {
        reconcileNotes.push(`${attempt.id}: could not mark unverified (${inner instanceof Error ? inner.message : String(inner)})`);
      }
    }
  }

  // 2. Merchant availability (DB-only in the MVP, but still outside the decision transaction).
  const quoteRow = await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId) });
  if (!quoteRow) throw new Error(`quote ${outing.currentQuoteId} not found`);
  const availability = await checkMerchantAvailability(db, quoteRow);

  // 3. Decision transaction.
  return db.transaction((tx) => decide(tx, { outing, early, reason: opts.reason, trigger, now, workerId, availability, reconcileNotes }));
}

interface DecideContext {
  outing: Outing;
  early: boolean;
  reason?: EarlyCancelReason;
  trigger: SettlementTrigger;
  now: Date;
  workerId: string;
  availability: MerchantAvailability;
  reconcileNotes: string[];
}

async function decide(tx: Tx, ctx: DecideContext): Promise<DeadlineSettlementResult> {
  const { now, early } = ctx;
  const actor = workerActor(ctx.workerId);

  const [locked] = await tx.select().from(outings).where(eq(outings.id, ctx.outing.id)).for("update");
  if (!locked) return { outcome: "NOT_FOUND" };
  if (locked.status !== "COLLECTING") return { outcome: "NOT_COLLECTING", status: locked.status };
  const existing = await tx.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, locked.id) });
  if (existing) return { outcome: "ALREADY_SETTLED", decision: existing.decision };
  if (!locked.currentQuoteId || !locked.deadlineAt) throw new Error("outing lost its quote or deadline");

  const clock = await tx.execute(sql`select now() as db_now, (${locked.deadlineAt} <= now()) as due`);
  const dbNow = new Date(clock.rows[0]!.db_now as string | Date);
  const due = Boolean(clock.rows[0]!.due);
  if (!early && !due) return { outcome: "NOT_DUE", deadlineAt: locked.deadlineAt };

  const quote = await tx.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, locked.currentQuoteId) });
  if (!quote) throw new Error(`quote ${locked.currentQuoteId} not found`);
  const currency = assertCurrency(quote.currency);
  const people = await tx.query.participants.findMany({ where: eq(participants.outingId, locked.id) });
  const consentRows = await tx.query.consents.findMany({ where: eq(consents.outingId, locked.id) });
  const attemptRows = await tx.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, locked.id) });

  const input: SettlementInput = {
    now: dbNow,
    outingId: locked.id,
    policy: locked.policy,
    deadlineAt: locked.deadlineAt,
    quote: {
      id: quote.id,
      termsHash: quote.termsHash,
      totalMinor: quote.totalMinor,
      currency,
      capMinor: quote.capMinor,
      minPayers: quote.minPayers,
      capacity: quote.capacity,
      expiresAt: quote.expiresAt,
    },
    participants: people.map((p) => ({
      id: p.id,
      sortKey: p.sortKey,
      payerType: p.payerType,
      required: p.required,
      attendance: p.attendance,
      attendanceAt: p.attendanceAt,
    })),
    consents: consentRows.map((c) => ({
      id: c.id,
      participantId: c.participantId,
      quoteId: c.quoteId,
      termsHash: c.termsHash,
      capMinor: c.capMinor,
      currency: assertCurrency(c.currency),
      acceptedAt: c.acceptedAt,
      withdrawnAt: c.withdrawnAt,
    })),
    authorizations: attemptRows.map((a) => ({
      paymentAttemptId: a.id,
      participantId: a.participantId,
      consentId: a.consentId,
      status: a.status,
      verified: a.verified,
      authorizedMinor: a.authorizedMinor,
      currency: assertCurrency(a.currency),
      authorizedAt: a.authorizedAt,
      expiresAt: a.authorizationExpiresAt,
    })),
    merchantAvailable: ctx.availability.available,
    early,
  };

  const holds = attemptRows.filter((a) => HOLD_LIKE.has(a.status)).map((a) => a.id);
  let decision: SettlementDecision;
  if (early && ctx.reason === "ORGANIZER_CANCELLED") {
    decision = { kind: "CANCEL", reasons: ["ORGANIZER_CANCELLED"], ineligible: [], voidPaymentAttemptIds: holds };
  } else {
    try {
      decision = decideSettlement(input);
    } catch (err) {
      if (early && err instanceof PolicyError && err.code === "NOT_INFEASIBLE") {
        await recordAudit(tx, { outingId: locked.id, actor, type: "EARLY_SETTLEMENT_SKIPPED", data: { trigger: ctx.trigger } });
        return { outcome: "STILL_FEASIBLE" };
      }
      throw err;
    }
  }

  const frozenAt = locked.frozenAt ?? dbNow;
  const byId = new Map(attemptRows.map((a) => [a.id, a]));

  // Attempts without a hold: the approval never completed before the roster froze.
  const failedApprovals: string[] = [];
  for (const a of attemptRows) {
    if (a.status === "CREATED" || a.status === "APPROVAL_PENDING") {
      await moveAttempt(tx, a, "FAILED", { lastError: "approval not completed before deadline" }, now);
      failedApprovals.push(a.id);
    }
  }

  const plannedCaptures: PlannedCapture[] = [];
  if (decision.kind === "SETTLE") {
    decision.allocations.forEach((alloc, i) =>
      plannedCaptures.push({
        paymentAttemptId: alloc.paymentAttemptId,
        participantId: alloc.participantId,
        sequence: i + 1,
        amountMinor: alloc.allocationMinor,
        capMinor: alloc.capMinor,
        authorizedMinor: alloc.authorizedMinor,
      }),
    );
  }
  const voids = [...new Set(decision.voidPaymentAttemptIds)].filter((id) => byId.has(id));

  const roster: SettlementRoster = {
    version: 1,
    trigger: ctx.trigger,
    early,
    decision,
    allocations: decision.kind === "SETTLE" ? decision.allocations : [],
    deadlineAt: locked.deadlineAt.toISOString(),
    frozenAt: frozenAt.toISOString(),
    evaluatedAt: dbNow.toISOString(),
    quote: {
      id: quote.id,
      termsHash: quote.termsHash,
      totalMinor: quote.totalMinor,
      currency: quote.currency,
      capMinor: quote.capMinor,
      minPayers: quote.minPayers,
      capacity: quote.capacity,
    },
    merchantAvailability: ctx.availability,
    participants: people
      .map((p) => ({ id: p.id, sortKey: p.sortKey, role: p.role, payerType: p.payerType, required: p.required, attendance: p.attendance }))
      .sort((a, b) => a.sortKey - b.sortKey),
    planned: { captures: plannedCaptures, voids, failedApprovals },
    reconcileNotes: ctx.reconcileNotes,
  };

  const [snapshot] = await tx
    .insert(settlementSnapshots)
    .values({
      outingId: locked.id,
      quoteId: quote.id,
      termsHash: quote.termsHash,
      decision: decision.kind,
      reasons: decision.kind === "CANCEL" ? decision.reasons : [],
      frozenAt,
      totalMinor: quote.totalMinor,
      currency: quote.currency,
      payerCount: decision.kind === "SETTLE" ? decision.payerCount : 0,
      roster,
    })
    .returning();
  if (!snapshot) throw new Error("failed to insert settlement snapshot");

  if (decision.kind === "SETTLE") {
    assertOutingTransition(locked.status, "SETTLING");
    await tx
      .update(outings)
      .set({ status: "SETTLING", frozenAt, version: locked.version + 1, updatedAt: now })
      .where(eq(outings.id, locked.id));
    for (const c of plannedCaptures) {
      // planPaymentOperation re-checks amount <= authorized; the DB check constraint is the last line.
      await planPaymentOperation(tx, {
        outingId: locked.id,
        paymentAttemptId: c.paymentAttemptId,
        kind: "CAPTURE",
        amountMinor: c.amountMinor,
        currency: quote.currency,
        sequence: c.sequence,
        runAt: now,
      });
    }
    await planVoids(tx, voids, byId, now);
    // Derived from the operations (a withdrawn payer's void may still be pending / stuck), never assumed.
    await recomputeCleanup(tx, locked.id);
    await recordAudit(tx, {
      outingId: locked.id,
      actor,
      type: "SETTLEMENT_DECIDED",
      data: {
        decision: "SETTLE",
        trigger: ctx.trigger,
        payerCount: decision.payerCount,
        totalMinor: decision.totalMinor,
        captures: plannedCaptures.map((c) => ({ paymentAttemptId: c.paymentAttemptId, sequence: c.sequence, amountMinor: c.amountMinor })),
        voids,
        failedApprovals,
        ineligible: decision.ineligible,
        merchantAvailability: ctx.availability,
      },
    });
    return { outcome: "SETTLE", snapshotId: snapshot.id, captures: plannedCaptures.length, voids: voids.length };
  }

  assertOutingTransition(locked.status, "CANCELLING");
  await tx
    .update(outings)
    .set({ status: "CANCELLING", frozenAt, version: locked.version + 1, updatedAt: now })
    .where(eq(outings.id, locked.id));
  await planVoids(tx, voids, byId, now);
  // Booking is cancelled now; the money clean-up is tracked separately in `cleanup` and derived from
  // EVERY operation of the outing (including voids planned earlier by a withdrawal that may be stuck),
  // so COMPLETE is only ever written when the provider confirmed every release.
  const cleanup = await recomputeCleanup(tx, locked.id);
  assertOutingTransition("CANCELLING", "CANCELLED");
  await tx
    .update(outings)
    .set({
      status: "CANCELLED",
      cancelReasons: decision.reasons,
      cancelledAt: now,
      cleanup,
      version: locked.version + 2,
      updatedAt: now,
    })
    .where(eq(outings.id, locked.id));
  await recordAudit(tx, {
    outingId: locked.id,
    actor,
    type: "SETTLEMENT_DECIDED",
    data: {
      decision: "CANCEL",
      trigger: ctx.trigger,
      reasons: decision.reasons,
      voids,
      failedApprovals,
      ineligible: decision.ineligible,
      merchantAvailability: ctx.availability,
    },
  });
  await recordAudit(tx, { outingId: locked.id, actor, type: "OUTING_CANCELLED", data: { reasons: decision.reasons, cleanup } });
  return { outcome: "CANCEL", snapshotId: snapshot.id, reasons: decision.reasons, voids: voids.length };
}

async function planVoids(tx: Tx, ids: string[], byId: Map<string, PaymentAttempt>, now: Date): Promise<void> {
  for (const id of ids) {
    const attempt = byId.get(id);
    if (!attempt) continue;
    await planPaymentOperation(tx, {
      outingId: attempt.outingId,
      paymentAttemptId: attempt.id,
      kind: "VOID",
      amountMinor: Math.max(0, attempt.authorizedMinor - attempt.capturedMinor),
      currency: attempt.currency,
      runAt: now,
    });
  }
}
