/**
 * Durable payment operation processor (captures, voids, refunds).
 *
 * Invariants
 * - An operation is claimed atomically (row lock + status flip to IN_FLIGHT),
 *   so two workers never send the same logical operation at once.
 * - Captures of one outing run strictly in `sequence` order, one at a time;
 *   the next is only claimable once every lower sequence SUCCEEDED.
 * - Before a capture is sent, the amount is re-checked against the attempt's
 *   authorized amount AND the consented cap recorded in the frozen snapshot.
 * - UNKNOWN outcomes (timeout / 5xx) and stale IN_FLIGHT rows are reconciled
 *   by reading provider state first; a re-send always reuses the op's stable
 *   requestId (PayPal-Request-Id), so a replay can never charge twice.
 * - A definitive capture failure flips the outing to COMPENSATING: remaining
 *   captures are SKIPPED, holds are voided, completed captures refunded. The
 *   failed share is never redistributed and the outing is never CONFIRMED.
 * - No SQL transaction is held across a provider call.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  outings,
  paymentAttempts,
  paymentOperations,
  settlementSnapshots,
  type Outing,
  type PaymentAttempt,
  type PaymentOperation,
} from "../db/schema";
import type { Db, DbOrTx, Tx } from "../db/client";
import { assertCurrency, type Currency } from "../domain/money";
import { assertOperationTransition, assertOutingTransition } from "../domain/state-machine";
import type { CancelReason, CleanupState, OperationStatus } from "../domain/types";
import type { AuthorizationView, CaptureView, PaymentProvider, RefundView } from "../payments/provider";
import { planPaymentOperation } from "../payments/plan";
import { recordAudit, type AuditActor } from "../audit";
import { applyAuthorizationView, voidIfNotOnRoster } from "./reconcile";
import { lockAttempt, moveAttempt, patchAttempt, truncateError, type AttemptPatch } from "./attempts";
import { plannedCaptureFor, readRoster, type SettlementRoster } from "./snapshot";
import { workerActor, type ProviderResolver } from "./types";

export const DEFAULT_LEASE_MS = 2 * 60_000;
const MAX_PASSES = 50;

export interface ProcessOperationsOptions {
  now: Date;
  workerId: string;
  /** Restrict to one outing (PROCESS_OPERATIONS job); otherwise every outing with due work. */
  outingId?: string;
  /** An IN_FLIGHT op untouched for longer than this is treated as UNKNOWN. */
  leaseMs?: number;
  /** Retry delay after an UNKNOWN outcome, by attempt count. */
  backoffMs?: (attempts: number) => number;
}

export interface ProcessOperationsResult {
  operationsRun: number;
  errors: string[];
}

interface OpCtx {
  now: Date;
  workerId: string;
  actor: AuditActor;
  leaseMs: number;
  backoffMs: (attempts: number) => number;
}

interface Claimed {
  op: PaymentOperation;
  prior: OperationStatus;
  stale: boolean;
}

interface OpContext {
  op: PaymentOperation;
  attempt: PaymentAttempt;
  outing: Outing;
  roster: SettlementRoster | null;
}

/** Exponential backoff with jitter: 2s, 4s, 8s … capped at 10 minutes. */
export function defaultBackoffMs(attempts: number): number {
  const base = Math.min(2 ** Math.max(1, attempts), 600) * 1000;
  return base + Math.floor(Math.random() * Math.min(base, 5_000));
}

export async function processDueOperations(
  db: Db,
  resolveProvider: ProviderResolver,
  opts: ProcessOperationsOptions,
): Promise<ProcessOperationsResult> {
  const ctx: OpCtx = {
    now: opts.now,
    workerId: opts.workerId,
    actor: workerActor(opts.workerId),
    leaseMs: opts.leaseMs ?? DEFAULT_LEASE_MS,
    backoffMs: opts.backoffMs ?? defaultBackoffMs,
  };
  const result: ProcessOperationsResult = { operationsRun: 0, errors: [] };

  try {
    await sweepStragglerHolds(db, ctx, opts.outingId);
  } catch (err) {
    result.errors.push(`straggler sweep: ${errorMessage(err)}`);
  }

  const outingIds = opts.outingId ? [opts.outingId] : await dueOutingIds(db, ctx);
  for (const outingId of outingIds) {
    try {
      result.operationsRun += await processOuting(db, resolveProvider, ctx, outingId);
    } catch (err) {
      result.errors.push(`outing ${outingId}: ${errorMessage(err)}`);
    }
    try {
      await finalizeOuting(db, ctx, outingId);
    } catch (err) {
      result.errors.push(`finalize ${outingId}: ${errorMessage(err)}`);
    }
  }
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------------- */
/* Straggler holds                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Any AUTHORIZED attempt that has no operation while its outing is frozen
 * (snapshot exists) or no longer collecting must be voided. The payments
 * service enforces this at record time; this sweep catches anything that
 * slipped through (crash between record and plan, webhook-driven recording).
 */
async function sweepStragglerHolds(db: Db, ctx: OpCtx, outingId?: string): Promise<void> {
  const rows = await db.execute(sql`
    select a.id from payment_attempts a
    join outings o on o.id = a.outing_id
    where a.status = 'AUTHORIZED'
      and (o.status <> 'COLLECTING' or exists (select 1 from settlement_snapshots s where s.outing_id = a.outing_id))
      and not exists (select 1 from payment_operations p where p.payment_attempt_id = a.id)
      ${outingId ? sql`and a.outing_id = ${outingId}` : sql``}
    limit 100
  `);
  for (const row of rows.rows as { id: string }[]) {
    await voidIfNotOnRoster(db, row.id, ctx);
  }
}

/* -------------------------------------------------------------------------- */
/* Due work                                                                   */
/* -------------------------------------------------------------------------- */

function dueCondition(lease: number) {
  return sql`(
    (
      (${paymentOperations.status} in ('PENDING', 'UNKNOWN') or (${paymentOperations.status} = 'FAILED' and ${paymentOperations.completedAt} is null))
      and ${paymentOperations.attempts} < ${paymentOperations.maxAttempts}
      and ${paymentOperations.nextAttemptAt} <= now()
    )
    or (${paymentOperations.status} = 'IN_FLIGHT' and ${paymentOperations.updatedAt} + (${lease} * interval '1 millisecond') <= now())
  )`;
}

async function dueOutingIds(db: Db, ctx: OpCtx): Promise<string[]> {
  const rows = await db.execute(sql`
    select id from outings where status in ('SETTLING', 'COMPENSATING')
    union
    select distinct ${paymentOperations.outingId} from ${paymentOperations} where ${dueCondition(ctx.leaseMs)}
  `);
  return (rows.rows as { id: string }[]).map((r) => r.id);
}

async function listDueOps(db: Db, ctx: OpCtx, outingId: string): Promise<PaymentOperation[]> {
  return db
    .select()
    .from(paymentOperations)
    .where(and(eq(paymentOperations.outingId, outingId), dueCondition(ctx.leaseMs)))
    .orderBy(
      sql`case ${paymentOperations.kind} when 'VOID' then 0 when 'REFUND' then 1 else 2 end`,
      paymentOperations.sequence,
      paymentOperations.createdAt,
    );
}

async function processOuting(db: Db, resolveProvider: ProviderResolver, ctx: OpCtx, outingId: string): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const due = await listDueOps(db, ctx, outingId);
    let ran = 0;
    for (const candidate of due) {
      const claimed = await claimOperation(db, ctx, candidate.id);
      if (!claimed) continue;
      ran++;
      total++;
      await executeOperation(db, resolveProvider, ctx, claimed);
    }
    if (ran === 0) break;
  }
  return total;
}

/**
 * Atomic claim. Returns null when another worker holds the row, the op is
 * not due, or (captures) an earlier capture has not succeeded yet.
 */
async function claimOperation(db: Db, ctx: OpCtx, opId: string): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const [op] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, opId)).for("update", { skipLocked: true });
    if (!op) return null;
    const clock = await tx.execute(sql`select now() as db_now`);
    const dbNow = new Date(clock.rows[0]!.db_now as string | Date).getTime();

    const retryable = op.status === "PENDING" || op.status === "UNKNOWN" || (op.status === "FAILED" && op.completedAt === null);
    const due = retryable && op.attempts < op.maxAttempts && op.nextAttemptAt.getTime() <= dbNow;
    const stale = op.status === "IN_FLIGHT" && op.updatedAt.getTime() + ctx.leaseMs <= dbNow;
    if (!due && !stale) return null;

    if (op.kind === "CAPTURE") {
      const [outing] = await tx.select({ status: outings.status }).from(outings).where(eq(outings.id, op.outingId));
      if (!outing) return null;
      if (outing.status === "SETTLING") {
        const blockers = await tx.execute(sql`
          select 1 from payment_operations
          where outing_id = ${op.outingId} and kind = 'CAPTURE' and sequence < ${op.sequence} and status <> 'SUCCEEDED'
          limit 1
        `);
        if (blockers.rows.length > 0) return null;
      } else if (op.status === "PENDING") {
        // The outing is no longer settling: a capture that was never sent must never be sent now.
        assertOperationTransition("PENDING", "SKIPPED");
        await tx
          .update(paymentOperations)
          .set({ status: "SKIPPED", completedAt: ctx.now, lastError: `outing ${outing.status}; capture not sent`, updatedAt: ctx.now })
          .where(eq(paymentOperations.id, op.id));
        return null;
      }
      // UNKNOWN / stale captures of a compensating outing are still claimed: reconcile only, never re-sent.
    }

    if (!stale) assertOperationTransition(op.status, "IN_FLIGHT");
    const [claimed] = await tx
      .update(paymentOperations)
      .set({ status: "IN_FLIGHT", attempts: op.attempts + 1, updatedAt: sql`now()` })
      .where(eq(paymentOperations.id, op.id))
      .returning();
    if (!claimed) return null;
    return { op: claimed, prior: op.status, stale };
  });
}

async function loadOpContext(db: Db, opId: string): Promise<OpContext> {
  const op = await db.query.paymentOperations.findFirst({ where: eq(paymentOperations.id, opId) });
  if (!op) throw new Error(`operation ${opId} not found`);
  const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, op.paymentAttemptId) });
  if (!attempt) throw new Error(`attempt ${op.paymentAttemptId} not found`);
  const outing = await db.query.outings.findFirst({ where: eq(outings.id, op.outingId) });
  if (!outing) throw new Error(`outing ${op.outingId} not found`);
  const snapshot = await db.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, op.outingId) });
  return { op, attempt, outing, roster: snapshot ? readRoster(snapshot) : null };
}

async function executeOperation(db: Db, resolveProvider: ProviderResolver, ctx: OpCtx, claimed: Claimed): Promise<void> {
  try {
    const c = await loadOpContext(db, claimed.op.id);
    const provider = resolveProvider(c.attempt.provider);
    switch (c.op.kind) {
      case "CAPTURE":
        await executeCapture(db, provider, ctx, c, claimed);
        break;
      case "VOID":
        await executeVoid(db, provider, ctx, c, claimed);
        break;
      case "REFUND":
        await executeRefund(db, provider, ctx, c, claimed);
        break;
    }
  } catch (err) {
    // Never leave a row IN_FLIGHT because of our own bug: park it as UNKNOWN for reconciliation.
    await markOpUnknown(db, ctx, claimed.op, `worker error: ${errorMessage(err)}`);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared outcome writers                                                     */
/* -------------------------------------------------------------------------- */

async function markOpUnknown(
  db: DbOrTx,
  ctx: OpCtx,
  op: PaymentOperation,
  message: string,
  patch: { providerRef?: string; providerStatus?: string } = {},
): Promise<void> {
  const delay = ctx.backoffMs(op.attempts);
  await db
    .update(paymentOperations)
    .set({
      status: "UNKNOWN",
      lastError: truncateError(message),
      nextAttemptAt: sql`now() + (${delay} * interval '1 millisecond')`,
      updatedAt: sql`now()`,
      ...(patch.providerRef ? { providerRef: patch.providerRef } : {}),
      ...(patch.providerStatus ? { providerStatus: patch.providerStatus } : {}),
    })
    .where(and(eq(paymentOperations.id, op.id), eq(paymentOperations.status, "IN_FLIGHT")));
  await recordAudit(db, {
    outingId: op.outingId,
    actor: ctx.actor,
    type: "OPERATION_UNKNOWN",
    data: { operationId: op.id, kind: op.kind, paymentAttemptId: op.paymentAttemptId, attempts: op.attempts, maxAttempts: op.maxAttempts, message: truncateError(message, 200) },
  });
}

async function setOpSucceeded(tx: DbOrTx, op: PaymentOperation, patch: { providerRef?: string | null; providerStatus?: string; note?: string }, now: Date): Promise<void> {
  assertOperationTransition("IN_FLIGHT", "SUCCEEDED");
  await tx
    .update(paymentOperations)
    .set({
      status: "SUCCEEDED",
      providerRef: patch.providerRef ?? op.providerRef,
      providerStatus: patch.providerStatus ?? op.providerStatus,
      lastError: patch.note ?? null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(paymentOperations.id, op.id), eq(paymentOperations.status, "IN_FLIGHT")));
}

async function setOpFailedTerminal(tx: DbOrTx, op: PaymentOperation, code: string, message: string, now: Date): Promise<void> {
  assertOperationTransition("IN_FLIGHT", "FAILED");
  await tx
    .update(paymentOperations)
    .set({ status: "FAILED", providerStatus: code, lastError: truncateError(`${code}: ${message}`), completedAt: now, updatedAt: now })
    .where(and(eq(paymentOperations.id, op.id), eq(paymentOperations.status, "IN_FLIGHT")));
}

/* -------------------------------------------------------------------------- */
/* CAPTURE                                                                    */
/* -------------------------------------------------------------------------- */

type CaptureState =
  | { kind: "COMPLETED"; capture: CaptureView }
  | { kind: "PENDING"; capture: CaptureView }
  | { kind: "DECLINED"; capture: CaptureView }
  | { kind: "NOT_ATTEMPTED" }
  | { kind: "AUTH_GONE"; status: AuthorizationView["status"] }
  | { kind: "READ_FAILED"; code: string }
  | { kind: "INDETERMINATE"; status: string };

async function readCaptureState(provider: PaymentProvider, attempt: PaymentAttempt): Promise<CaptureState> {
  if (!attempt.authorizationId) return { kind: "AUTH_GONE", status: "OTHER" };
  const res = await provider.getAuthorization(attempt.authorizationId);
  if (!res.ok) return { kind: "READ_FAILED", code: res.code };
  const auth = res.authorization;
  const completed = auth.captures.find((c) => c.status === "COMPLETED" || c.status === "REFUNDED" || c.status === "PARTIALLY_REFUNDED");
  if (completed) return { kind: "COMPLETED", capture: completed };
  const pending = auth.captures.find((c) => c.status === "PENDING");
  if (pending) return { kind: "PENDING", capture: pending };
  const declined = auth.captures.find((c) => c.status === "DECLINED" || c.status === "FAILED");
  if (declined) return { kind: "DECLINED", capture: declined };
  if (auth.status === "VOIDED" || auth.status === "EXPIRED" || auth.status === "DENIED") return { kind: "AUTH_GONE", status: auth.status };
  if (auth.status === "CREATED") return { kind: "NOT_ATTEMPTED" };
  return { kind: "INDETERMINATE", status: auth.providerStatus };
}

/** Every reason we refuse to send a capture. Null means safe to send. */
function captureRefusal(c: OpContext): string | null {
  const { op, attempt, outing, roster } = c;
  if (outing.status !== "SETTLING") return `outing is ${outing.status}, not SETTLING`;
  if (!roster) return "no settlement snapshot";
  if (roster.decision.kind !== "SETTLE") return "snapshot decision is CANCEL";
  const planned = plannedCaptureFor(roster, attempt.id);
  if (!planned) return "attempt is not among the frozen allocations";
  if (op.amountMinor <= 0) return "capture amount must be positive";
  if (op.amountMinor !== planned.amountMinor) return `operation amount ${op.amountMinor} differs from allocated ${planned.amountMinor}`;
  if (op.amountMinor > planned.capMinor) return `amount ${op.amountMinor} exceeds consented cap ${planned.capMinor}`;
  if (op.amountMinor > attempt.authorizedMinor) return `amount ${op.amountMinor} exceeds authorized ${attempt.authorizedMinor}`;
  if (op.currency !== attempt.currency || op.currency !== roster.quote.currency) return "currency mismatch";
  if (attempt.status !== "CAPTURE_PENDING" && attempt.status !== "UNKNOWN") return `attempt is ${attempt.status}`;
  if (!attempt.authorizationId) return "attempt has no authorization id";
  return null;
}

async function executeCapture(db: Db, provider: PaymentProvider, ctx: OpCtx, c: OpContext, claimed: Claimed): Promise<void> {
  const { op, attempt } = c;
  const currency = assertCurrency(attempt.currency);

  // Reconciliation already recorded a completed capture: nothing to send.
  if ((attempt.status === "CAPTURED" || attempt.status === "REFUND_PENDING" || attempt.status === "REFUNDED") && attempt.captureId) {
    await recordCaptureSuccess(db, ctx, op, syntheticCapture(attempt.captureId, attempt.capturedMinor, currency, attempt.providerStatus), "already recorded on attempt");
    return;
  }

  const mustReconcile = claimed.prior === "UNKNOWN" || claimed.stale || op.providerRef !== null;
  if (mustReconcile) {
    const state = await readCaptureState(provider, attempt);
    switch (state.kind) {
      case "COMPLETED":
        await recordCaptureSuccess(db, ctx, op, state.capture, "reconciled from provider state");
        return;
      case "PENDING":
        await patchAttempt(db, attempt.id, { captureId: state.capture.captureId, providerStatus: state.capture.providerStatus }, ctx.now);
        await markOpUnknown(db, ctx, op, "capture pending at provider", { providerRef: state.capture.captureId, providerStatus: state.capture.providerStatus });
        return;
      case "DECLINED":
        await recordCaptureFailure(db, ctx, op, `CAPTURE_${state.capture.status}`, "capture declined at provider");
        return;
      case "AUTH_GONE":
        await recordCaptureFailure(db, ctx, op, `AUTHORIZATION_${state.status}`, "authorization no longer capturable");
        return;
      case "READ_FAILED":
        await markOpUnknown(db, ctx, op, `reconcile read failed: ${state.code}`);
        return;
      case "INDETERMINATE":
        await markOpUnknown(db, ctx, op, `authorization status ${state.status}; cannot decide`);
        return;
      case "NOT_ATTEMPTED":
        // Provider shows nothing happened: safe to (re)send with the SAME requestId.
        break;
    }
  }

  const refusal = captureRefusal(c);
  if (refusal) {
    await recordCaptureFailure(db, ctx, op, "CAPTURE_REFUSED", refusal);
    return;
  }

  const res = await provider.captureAuthorization({
    authorizationId: attempt.authorizationId!,
    amountMinor: op.amountMinor,
    currency,
    requestId: op.requestId,
    invoiceId: op.requestId,
    noteToPayer: "Your share of the group booking",
  });
  if (!res.ok) {
    if (res.kind === "UNKNOWN") await markOpUnknown(db, ctx, op, `${res.code}: ${res.message}`);
    else await recordCaptureFailure(db, ctx, op, res.code, res.message);
    return;
  }
  switch (res.capture.status) {
    case "COMPLETED":
      await recordCaptureSuccess(db, ctx, op, res.capture);
      return;
    case "PENDING":
      await patchAttempt(db, attempt.id, { captureId: res.capture.captureId, providerStatus: res.capture.providerStatus }, ctx.now);
      await markOpUnknown(db, ctx, op, "capture pending at provider", { providerRef: res.capture.captureId, providerStatus: res.capture.providerStatus });
      return;
    case "DECLINED":
    case "FAILED":
      await recordCaptureFailure(db, ctx, op, `CAPTURE_${res.capture.status}`, "capture declined by provider");
      return;
    default:
      await markOpUnknown(db, ctx, op, `capture status ${res.capture.providerStatus}; reconcile`, { providerRef: res.capture.captureId });
  }
}

function syntheticCapture(captureId: string, amountMinor: number, currency: Currency, providerStatus: string | null): CaptureView {
  return { captureId, status: "COMPLETED", providerStatus: providerStatus ?? "COMPLETED", amountMinor, currency, finalCapture: true, createTime: null };
}

async function recordCaptureSuccess(db: Db, ctx: OpCtx, op: PaymentOperation, capture: CaptureView, note?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [outing] = await tx.select().from(outings).where(eq(outings.id, op.outingId)).for("update");
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!outing || !attempt) throw new Error("capture context vanished");

    await setOpSucceeded(tx, op, { providerRef: capture.captureId, providerStatus: capture.providerStatus, note }, ctx.now);

    const mismatch = capture.amountMinor !== op.amountMinor;
    const capturedMinor = Math.min(capture.amountMinor, attempt.authorizedMinor);
    const facts: AttemptPatch = {
      captureId: attempt.captureId ?? capture.captureId,
      capturedMinor: Math.max(attempt.capturedMinor, capturedMinor),
      providerStatus: capture.providerStatus,
      verified: true,
      verifiedAt: ctx.now,
      lastError: mismatch ? `provider captured ${capture.amountMinor}, operation planned ${op.amountMinor}` : null,
    };
    let updated: PaymentAttempt;
    if (attempt.status === "CAPTURE_PENDING" || attempt.status === "UNKNOWN" || attempt.status === "AUTHORIZED") {
      updated = await moveAttempt(tx, attempt, "CAPTURED", facts, ctx.now);
    } else {
      updated = await patchAttempt(tx, attempt.id, facts, ctx.now);
    }
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: mismatch ? "CAPTURE_AMOUNT_MISMATCH" : "CAPTURE_SUCCEEDED",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, amountMinor: capture.amountMinor, plannedMinor: op.amountMinor, captureId: capture.captureId, sequence: op.sequence, note },
    });
    // Money captured for a booking that is already being unwound must go back.
    if ((outing.status === "COMPENSATING" || outing.status === "CANCELLED") && updated.status === "CAPTURED") {
      await planRefundFor(tx, updated, ctx.now);
    }
  });
}

/** Definitive capture failure → terminal op, FAILED attempt, outing COMPENSATING, compensation planned. */
async function recordCaptureFailure(db: Db, ctx: OpCtx, op: PaymentOperation, code: string, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [outing] = await tx.select().from(outings).where(eq(outings.id, op.outingId)).for("update");
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!outing || !attempt) throw new Error("capture context vanished");

    await setOpFailedTerminal(tx, op, code, message, ctx.now);
    if (attempt.status === "CAPTURE_PENDING" || attempt.status === "UNKNOWN" || attempt.status === "AUTHORIZED") {
      await moveAttempt(tx, attempt, "FAILED", { lastError: truncateError(`${code}: ${message}`), providerStatus: code }, ctx.now);
    }
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: "CAPTURE_FAILED",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, amountMinor: op.amountMinor, code, message: truncateError(message, 200), sequence: op.sequence },
    });

    let status = outing.status;
    if (status === "SETTLING") {
      assertOutingTransition("SETTLING", "COMPENSATING");
      await tx
        .update(outings)
        .set({ status: "COMPENSATING", cancelReasons: withReason(outing.cancelReasons, "CAPTURE_FAILED"), version: outing.version + 1, updatedAt: ctx.now })
        .where(eq(outings.id, outing.id));
      status = "COMPENSATING";
      await recordAudit(tx, { outingId: outing.id, actor: ctx.actor, type: "OUTING_COMPENSATING", data: { failedPaymentAttemptId: attempt.id, code } });
    }
    if (status === "COMPENSATING" || status === "CANCELLED") {
      await planCompensation(tx, outing.id, ctx.now);
    }
  });
}

function withReason(reasons: string[], reason: CancelReason): string[] {
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}

async function planRefundFor(tx: Tx, attempt: PaymentAttempt, now: Date): Promise<void> {
  const remaining = attempt.capturedMinor - attempt.refundedMinor;
  if (remaining <= 0) return;
  await planPaymentOperation(tx, { outingId: attempt.outingId, paymentAttemptId: attempt.id, kind: "REFUND", amountMinor: remaining, currency: attempt.currency, runAt: now });
}

async function planVoidFor(tx: Tx, attempt: PaymentAttempt, now: Date): Promise<void> {
  await planPaymentOperation(tx, {
    outingId: attempt.outingId,
    paymentAttemptId: attempt.id,
    kind: "VOID",
    amountMinor: Math.max(0, attempt.authorizedMinor - attempt.capturedMinor),
    currency: attempt.currency,
    runAt: now,
  });
}

/**
 * Idempotent compensation planning for a COMPENSATING / CANCELLED outing:
 * skip unsent captures, void every resolved hold, refund every completed
 * capture. Captures still in flight / UNKNOWN are left alone until they resolve.
 */
async function planCompensation(tx: Tx, outingId: string, now: Date): Promise<void> {
  const ops = await tx.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, outingId) });
  const attempts = await tx.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, outingId) });
  const captureOps = new Map(ops.filter((o) => o.kind === "CAPTURE").map((o) => [o.paymentAttemptId, o]));

  for (const op of captureOps.values()) {
    if (op.status === "PENDING") {
      assertOperationTransition("PENDING", "SKIPPED");
      await tx
        .update(paymentOperations)
        .set({ status: "SKIPPED", completedAt: now, lastError: "skipped after a capture failure", updatedAt: now })
        .where(and(eq(paymentOperations.id, op.id), eq(paymentOperations.status, "PENDING")));
      op.status = "SKIPPED";
    } else if (op.status === "FAILED" && op.completedAt === null) {
      await tx.update(paymentOperations).set({ completedAt: now, updatedAt: now }).where(eq(paymentOperations.id, op.id));
      op.completedAt = now;
    }
  }

  const unresolved = (op: PaymentOperation | undefined) =>
    op !== undefined && (op.status === "IN_FLIGHT" || op.status === "UNKNOWN" || (op.status === "FAILED" && op.completedAt === null));

  for (const attempt of attempts) {
    const captureOp = captureOps.get(attempt.id);
    if (unresolved(captureOp)) continue;
    if (attempt.status === "CAPTURED") {
      await planRefundFor(tx, attempt, now);
    } else if (attempt.status === "CAPTURE_PENDING" || attempt.status === "AUTHORIZED" || (attempt.status === "FAILED" && attempt.authorizationId)) {
      await planVoidFor(tx, attempt, now);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* VOID                                                                       */
/* -------------------------------------------------------------------------- */

function pickAuthorization(auths: AuthorizationView[]): AuthorizationView | null {
  const rank = (a: AuthorizationView) =>
    a.status === "CREATED" ? 0 : a.status === "CAPTURED" || a.status === "PARTIALLY_CAPTURED" ? 1 : a.status === "PENDING" ? 2 : 3;
  return [...auths].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

async function executeVoid(db: Db, provider: PaymentProvider, ctx: OpCtx, c: OpContext, claimed: Claimed): Promise<void> {
  const { op, outing } = c;
  let attempt = c.attempt;

  if (attempt.status === "VOIDED") {
    await recordVoidSuccess(db, ctx, op, attempt.providerStatus ?? "VOIDED", "already voided");
    return;
  }

  if (!attempt.authorizationId) {
    if (!attempt.providerOrderId) {
      await recordVoidNothingHeld(db, ctx, op, "no provider order exists; nothing is held");
      return;
    }
    const res = await provider.getOrder(attempt.providerOrderId);
    if (!res.ok) {
      await markOpUnknown(db, ctx, op, `getOrder failed: ${res.code}`);
      return;
    }
    const auth = pickAuthorization(res.order.authorizations);
    if (!auth) {
      if (res.order.status === "COMPLETED") {
        await markOpUnknown(db, ctx, op, "order completed but no authorization visible; needs reconciliation");
      } else {
        await recordVoidNothingHeld(db, ctx, op, `order ${res.order.providerStatus}; no authorization was created`);
      }
      return;
    }
    ({ attempt } = await applyAuthorizationView(db, attempt.id, auth, outing.deadlineAt, ctx.now));
    if (attempt.status === "VOIDED") {
      await recordVoidSuccess(db, ctx, op, auth.providerStatus, "authorization already released at provider");
      return;
    }
    if (!attempt.authorizationId) {
      await markOpUnknown(db, ctx, op, "authorization could not be recorded on the attempt");
      return;
    }
  }
  const authorizationId = attempt.authorizationId;

  if (claimed.prior === "UNKNOWN" || claimed.stale) {
    const res = await provider.getAuthorization(authorizationId);
    if (!res.ok) {
      await markOpUnknown(db, ctx, op, `getAuthorization failed: ${res.code}`);
      return;
    }
    const handled = await settleVoidFromView(db, ctx, op, res.authorization, "reconciled from provider state");
    if (handled) return;
  }

  const res = await provider.voidAuthorization({ authorizationId, requestId: op.requestId });
  if (res.ok) {
    await recordVoidSuccess(db, ctx, op, res.providerStatus);
    return;
  }
  if (res.kind === "UNKNOWN") {
    await markOpUnknown(db, ctx, op, `${res.code}: ${res.message}`);
    return;
  }
  // Definitive refusal: the authorization may already be released or captured. Read and decide.
  const view = await provider.getAuthorization(authorizationId);
  if (!view.ok) {
    await markOpUnknown(db, ctx, op, `void refused (${res.code}) and getAuthorization failed (${view.code})`);
    return;
  }
  const handled = await settleVoidFromView(db, ctx, op, view.authorization, `void refused (${res.code})`);
  if (!handled) await markOpUnknown(db, ctx, op, `void refused (${res.code}: ${res.message}); authorization still ${view.authorization.providerStatus}`);
}

/** Resolve a VOID op from an authorization view when the provider already decided. */
async function settleVoidFromView(db: Db, ctx: OpCtx, op: PaymentOperation, auth: AuthorizationView, why: string): Promise<boolean> {
  if (auth.status === "VOIDED" || auth.status === "EXPIRED") {
    await recordVoidSuccess(db, ctx, op, auth.providerStatus, `${why}; authorization ${auth.status.toLowerCase()} at provider`);
    return true;
  }
  if (auth.status === "DENIED") {
    await recordVoidNothingHeld(db, ctx, op, `${why}; authorization denied at provider, nothing is held`);
    return true;
  }
  if (auth.status === "CAPTURED" || auth.status === "PARTIALLY_CAPTURED") {
    const captured = auth.captures.find((c) => c.status === "COMPLETED" || c.status === "REFUNDED" || c.status === "PARTIALLY_REFUNDED");
    if (captured) {
      await recordVoidCapturedConflict(db, ctx, op, captured, why);
      return true;
    }
  }
  return false;
}

async function recordVoidSuccess(db: Db, ctx: OpCtx, op: PaymentOperation, providerStatus: string, note?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!attempt) throw new Error("attempt vanished");
    await setOpSucceeded(tx, op, { providerStatus, note }, ctx.now);
    const facts: AttemptPatch = { providerStatus, lastError: note ?? null };
    if (attempt.status !== "VOIDED") {
      if (attempt.status === "VOID_PENDING" || attempt.status === "AUTHORIZED" || attempt.status === "UNKNOWN" || attempt.status === "CAPTURE_PENDING") {
        await moveAttempt(tx, attempt, "VOIDED", facts, ctx.now);
      } else {
        await patchAttempt(tx, attempt.id, { ...facts, lastError: `void succeeded while attempt was ${attempt.status}` }, ctx.now);
      }
    }
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: "HOLD_VOIDED",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, providerStatus, note },
    });
  });
}

async function recordVoidNothingHeld(db: Db, ctx: OpCtx, op: PaymentOperation, note: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!attempt) throw new Error("attempt vanished");
    await setOpSucceeded(tx, op, { providerStatus: "NO_AUTHORIZATION", note }, ctx.now);
    if (attempt.status === "VOID_PENDING" || attempt.status === "UNKNOWN" || attempt.status === "AUTHORIZED") {
      await moveAttempt(tx, attempt, "FAILED", { lastError: note, providerStatus: "NO_AUTHORIZATION" }, ctx.now);
    }
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: "VOID_NOTHING_HELD",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, note },
    });
  });
}

/** A void failed because money was captured: record the capture and plan a refund instead. */
async function recordVoidCapturedConflict(db: Db, ctx: OpCtx, op: PaymentOperation, capture: CaptureView, why: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!attempt) throw new Error("attempt vanished");
    await setOpFailedTerminal(tx, op, "PREVIOUSLY_CAPTURED", `${why}; capture ${capture.captureId} exists, refund planned`, ctx.now);
    const facts: AttemptPatch = {
      captureId: attempt.captureId ?? capture.captureId,
      authorizedMinor: Math.max(attempt.authorizedMinor, capture.amountMinor),
      capturedMinor: Math.max(attempt.capturedMinor, capture.amountMinor),
      providerStatus: capture.providerStatus,
      lastError: "void refused: already captured; refund planned",
    };
    let updated = attempt;
    if (attempt.status === "VOID_PENDING" || attempt.status === "UNKNOWN" || attempt.status === "AUTHORIZED" || attempt.status === "CAPTURE_PENDING") {
      updated = await moveAttempt(tx, attempt, "FAILED", facts, ctx.now);
    } else {
      updated = await patchAttempt(tx, attempt.id, facts, ctx.now);
    }
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: "VOID_CONFLICT_CAPTURED",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, captureId: capture.captureId, amountMinor: capture.amountMinor },
    });
    if (updated.status === "FAILED" || updated.status === "CAPTURED") await planRefundFor(tx, updated, ctx.now);
  });
}

/* -------------------------------------------------------------------------- */
/* REFUND                                                                     */
/* -------------------------------------------------------------------------- */

async function executeRefund(db: Db, provider: PaymentProvider, ctx: OpCtx, c: OpContext, claimed: Claimed): Promise<void> {
  const { op } = c;
  let attempt = c.attempt;
  const currency = assertCurrency(attempt.currency);

  if (attempt.status === "REFUNDED") {
    await recordRefundSuccess(db, ctx, op, { refundId: attempt.refundId ?? op.providerRef ?? "unknown", status: "COMPLETED", providerStatus: attempt.providerStatus ?? "COMPLETED", amountMinor: attempt.refundedMinor, currency }, "already refunded");
    return;
  }

  // A refund we already created: poll it instead of sending again.
  const knownRefundId = op.providerRef ?? attempt.refundId;
  if (knownRefundId) {
    const res = await provider.getRefund(knownRefundId);
    if (!res.ok) {
      await markOpUnknown(db, ctx, op, `getRefund failed: ${res.code}`, { providerRef: knownRefundId });
      return;
    }
    await settleRefundFromView(db, ctx, op, res.refund, "polled refund");
    return;
  }

  if (!attempt.captureId) {
    if (!attempt.authorizationId) {
      await recordRefundFailure(db, ctx, op, "NO_CAPTURE", "no capture id or authorization id on the attempt");
      return;
    }
    const res = await provider.getAuthorization(attempt.authorizationId);
    if (!res.ok) {
      await markOpUnknown(db, ctx, op, `getAuthorization failed: ${res.code}`);
      return;
    }
    const done = res.authorization.captures.find((x) => x.status === "COMPLETED" || x.status === "REFUNDED" || x.status === "PARTIALLY_REFUNDED");
    if (!done) {
      if (res.authorization.captures.some((x) => x.status === "PENDING")) await markOpUnknown(db, ctx, op, "capture still pending; cannot refund yet");
      else await recordRefundFailure(db, ctx, op, "NO_CAPTURE", "no completed capture exists at provider");
      return;
    }
    attempt = await patchAttempt(db, attempt.id, { captureId: done.captureId }, ctx.now);
    if (done.status === "REFUNDED") {
      await recordRefundSuccess(db, ctx, op, { refundId: "unknown", status: "COMPLETED", providerStatus: done.providerStatus, amountMinor: done.amountMinor, currency }, "capture already refunded at provider");
      return;
    }
  }

  if ((claimed.prior === "UNKNOWN" || claimed.stale) && attempt.authorizationId) {
    const res = await provider.getAuthorization(attempt.authorizationId);
    if (!res.ok) {
      await markOpUnknown(db, ctx, op, `getAuthorization failed: ${res.code}`);
      return;
    }
    const cap = res.authorization.captures.find((x) => x.captureId === attempt.captureId);
    if (cap?.status === "REFUNDED") {
      await recordRefundSuccess(db, ctx, op, { refundId: "unknown", status: "COMPLETED", providerStatus: cap.providerStatus, amountMinor: cap.amountMinor, currency }, "refund observed at provider");
      return;
    }
    // Otherwise re-send with the SAME requestId: the provider replays if it already happened.
  }

  const res = await provider.refundCapture({
    captureId: attempt.captureId!,
    amountMinor: op.amountMinor,
    currency,
    requestId: op.requestId,
    noteToPayer: "Booking not confirmed: your payment is being refunded",
  });
  if (!res.ok) {
    if (res.kind === "UNKNOWN") await markOpUnknown(db, ctx, op, `${res.code}: ${res.message}`);
    else await recordRefundFailure(db, ctx, op, res.code, res.message);
    return;
  }
  await settleRefundFromView(db, ctx, op, res.refund, "refund requested");
}

async function settleRefundFromView(db: Db, ctx: OpCtx, op: PaymentOperation, refund: RefundView, why: string): Promise<void> {
  switch (refund.status) {
    case "COMPLETED":
      await recordRefundSuccess(db, ctx, op, refund);
      return;
    case "PENDING":
      await patchAttempt(db, op.paymentAttemptId, { refundId: refund.refundId, providerStatus: refund.providerStatus }, ctx.now);
      await markOpUnknown(db, ctx, op, `${why}: refund pending at provider`, { providerRef: refund.refundId, providerStatus: refund.providerStatus });
      return;
    case "FAILED":
    case "CANCELLED":
      await recordRefundFailure(db, ctx, op, `REFUND_${refund.status}`, `${why}: refund ${refund.providerStatus}`);
      return;
    default:
      await markOpUnknown(db, ctx, op, `${why}: refund status ${refund.providerStatus}`, { providerRef: refund.refundId, providerStatus: refund.providerStatus });
  }
}

async function recordRefundSuccess(db: Db, ctx: OpCtx, op: PaymentOperation, refund: RefundView, note?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!attempt) throw new Error("attempt vanished");
    await setOpSucceeded(tx, op, { providerRef: refund.refundId, providerStatus: refund.providerStatus, note }, ctx.now);
    const facts: AttemptPatch = {
      refundId: attempt.refundId ?? refund.refundId,
      refundedMinor: Math.min(attempt.capturedMinor, Math.max(attempt.refundedMinor, refund.amountMinor)),
      providerStatus: refund.providerStatus,
      lastError: note ?? null,
    };
    if (attempt.status === "REFUND_PENDING" || attempt.status === "UNKNOWN") await moveAttempt(tx, attempt, "REFUNDED", facts, ctx.now);
    else if (attempt.status !== "REFUNDED") await patchAttempt(tx, attempt.id, { ...facts, lastError: `refund completed while attempt was ${attempt.status}` }, ctx.now);
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: "REFUND_COMPLETED",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, amountMinor: refund.amountMinor, refundId: refund.refundId, note },
    });
  });
}

async function recordRefundFailure(db: Db, ctx: OpCtx, op: PaymentOperation, code: string, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, op.paymentAttemptId);
    if (!attempt) throw new Error("attempt vanished");
    await setOpFailedTerminal(tx, op, code, message, ctx.now);
    if (attempt.status === "REFUND_PENDING" || attempt.status === "UNKNOWN") {
      await moveAttempt(tx, attempt, "FAILED", { lastError: truncateError(`${code}: ${message}`), providerStatus: code }, ctx.now);
    }
    await recordAudit(tx, {
      outingId: op.outingId,
      actor: ctx.actor,
      type: "REFUND_FAILED",
      data: { operationId: op.id, paymentAttemptId: attempt.id, participantId: attempt.participantId, amountMinor: op.amountMinor, code, message: truncateError(message, 200) },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Completion and clean-up state                                              */
/* -------------------------------------------------------------------------- */

const UNRESOLVED = (op: PaymentOperation) =>
  op.status === "PENDING" || op.status === "IN_FLIGHT" || op.status === "UNKNOWN" || (op.status === "FAILED" && op.completedAt === null);

/** Move SETTLING → CONFIRMED or COMPENSATING → CANCELLED when the operations say so, then refresh `cleanup`. */
export async function finalizeOuting(db: Db, ctx: { now: Date; workerId: string }, outingId: string): Promise<Outing | null> {
  const actor = workerActor(ctx.workerId);
  return db.transaction(async (tx) => {
    const [outing] = await tx.select().from(outings).where(eq(outings.id, outingId)).for("update");
    if (!outing) return null;
    const ops = await tx.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, outingId) });
    const captures = ops.filter((o) => o.kind === "CAPTURE");

    if (outing.status === "SETTLING") {
      if (captures.length > 0 && captures.every((c) => c.status === "SUCCEEDED")) {
        assertOutingTransition("SETTLING", "CONFIRMED");
        await tx.update(outings).set({ status: "CONFIRMED", settledAt: ctx.now, version: outing.version + 1, updatedAt: ctx.now }).where(eq(outings.id, outingId));
        await recordAudit(tx, {
          outingId,
          actor,
          type: "OUTING_CONFIRMED",
          data: { captures: captures.length, totalMinor: captures.reduce((acc, c) => acc + c.amountMinor, 0) },
        });
      }
    } else if (outing.status === "COMPENSATING") {
      if (!captures.some(UNRESOLVED)) {
        await planCompensation(tx, outingId, ctx.now);
        assertOutingTransition("COMPENSATING", "CANCELLED");
        await tx
          .update(outings)
          .set({ status: "CANCELLED", cancelledAt: ctx.now, cancelReasons: withReason(outing.cancelReasons, "CAPTURE_FAILED"), version: outing.version + 1, updatedAt: ctx.now })
          .where(eq(outings.id, outingId));
        await recordAudit(tx, { outingId, actor, type: "OUTING_CANCELLED", data: { reasons: withReason(outing.cancelReasons, "CAPTURE_FAILED") } });
      }
    }

    await recomputeCleanup(tx, outingId);
    const [after] = await tx.select().from(outings).where(eq(outings.id, outingId));
    return after ?? null;
  });
}

/**
 * Derive the money clean-up state from the operations and write it:
 * NONE / VOID_PENDING / REFUND_PENDING / NEEDS_ATTENTION / COMPLETE.
 * COMPLETE only when the provider confirmed every void and refund.
 */
export async function recomputeCleanup(db: DbOrTx, outingId: string): Promise<CleanupState> {
  const outing = await db.query.outings.findFirst({ where: eq(outings.id, outingId) });
  if (!outing) throw new Error(`outing ${outingId} not found`);
  const ops = await db.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, outingId) });
  const cleanupOps = ops.filter((o) => o.kind !== "CAPTURE");
  const captures = ops.filter((o) => o.kind === "CAPTURE");

  const exhausted = (o: PaymentOperation) =>
    (o.status === "UNKNOWN" || (o.status === "FAILED" && o.completedAt === null)) && o.attempts >= o.maxAttempts;
  const terminalFailure = (o: PaymentOperation) => o.status === "FAILED" && o.completedAt !== null;

  let state: CleanupState;
  if (cleanupOps.some((o) => exhausted(o) || terminalFailure(o)) || captures.some(exhausted)) {
    state = "NEEDS_ATTENTION";
  } else if (cleanupOps.some((o) => o.kind === "REFUND" && o.status !== "SUCCEEDED")) {
    state = "REFUND_PENDING";
  } else if (cleanupOps.some((o) => o.kind === "VOID" && o.status !== "SUCCEEDED" && o.status !== "SKIPPED")) {
    state = "VOID_PENDING";
  } else if (outing.status === "COMPENSATING" && captures.some(UNRESOLVED)) {
    state = "VOID_PENDING";
  } else if (cleanupOps.length === 0) {
    state = outing.status === "CANCELLED" || outing.status === "CANCELLING" || outing.status === "COMPENSATING" ? "COMPLETE" : "NONE";
  } else {
    state = "COMPLETE";
  }

  if (outing.cleanup !== state) {
    await db.update(outings).set({ cleanup: state, updatedAt: new Date() }).where(eq(outings.id, outingId));
  }
  return state;
}
