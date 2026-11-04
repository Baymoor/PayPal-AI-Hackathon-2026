/**
 * Job handlers. Every handler is idempotent and evaluates against stored
 * server-side timestamps, never against "when the job ran".
 */
import type { Job } from "../db/schema";
import type { Db } from "../db/client";
import { runDeadlineSettlement, type DeadlineSettlementResult, type EarlyCancelReason } from "../settlement/deadline";
import { processDueOperations } from "../settlement/operations";
import { reconcileAttempt } from "../settlement/reconcile";
import type { ProviderResolver } from "../settlement/types";

export interface HandlerContext {
  db: Db;
  resolveProvider: ProviderResolver;
  workerId: string;
  now: Date;
}

export class JobNotDueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobNotDueError";
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const EARLY_REASONS: ReadonlySet<string> = new Set<EarlyCancelReason>(["ORGANIZER_CANCELLED", "REQUIRED_DECLINED"]);

export async function handleSettleDeadline(ctx: HandlerContext, job: Job): Promise<DeadlineSettlementResult> {
  if (!job.outingId) throw new Error("SETTLE_DEADLINE job without outingId");
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const early = payload.early === true;
  const reasonRaw = str(payload.reason);
  const reason = reasonRaw && EARLY_REASONS.has(reasonRaw) ? (reasonRaw as EarlyCancelReason) : undefined;
  if (early && !reason) throw new Error(`early SETTLE_DEADLINE job needs a valid reason, got ${String(reasonRaw)}`);

  const result = await runDeadlineSettlement(ctx.db, ctx.resolveProvider, {
    outingId: job.outingId,
    now: ctx.now,
    workerId: ctx.workerId,
    early,
    reason,
    quoteId: str(payload.quoteId),
  });
  // A job that fired before the stored deadline (clock skew, manual enqueue) retries with backoff.
  if (result.outcome === "NOT_DUE") throw new JobNotDueError(`outing ${job.outingId} is not due until ${result.deadlineAt.toISOString()}`);
  return result;
}

export async function handleProcessOperations(ctx: HandlerContext, job: Job) {
  const result = await processDueOperations(ctx.db, ctx.resolveProvider, {
    now: ctx.now,
    workerId: ctx.workerId,
    outingId: job.outingId ?? undefined,
  });
  if (result.errors.length > 0) throw new Error(result.errors.join("; "));
  return result;
}

/**
 * Reconcile one attempt (an authorize call that timed out, a webhook, a
 * manual nudge). If the hold turns out to be late or outside the frozen
 * roster, `reconcileAttempt` plans the VOID; then any due operations of the
 * outing run right away.
 */
export async function handleReconcilePayment(ctx: HandlerContext, job: Job) {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const attemptId = str(payload.paymentAttemptId);
  if (!attemptId) throw new Error("RECONCILE_PAYMENT job without paymentAttemptId");
  const result = await reconcileAttempt(ctx.db, ctx.resolveProvider, { attemptId, now: ctx.now, workerId: ctx.workerId });
  if (result.read === "FAILED") throw new Error(`reconcile ${attemptId}: ${result.note ?? "provider read failed"}`);
  const outingId = result.attempt?.outingId ?? job.outingId ?? undefined;
  const ops = outingId ? await processDueOperations(ctx.db, ctx.resolveProvider, { now: ctx.now, workerId: ctx.workerId, outingId }) : null;
  return { read: result.read, note: result.note, plannedVoid: result.plannedVoid, status: result.attempt?.status ?? null, operationsRun: ops?.operationsRun ?? 0 };
}

export async function dispatchJob(ctx: HandlerContext, job: Job): Promise<unknown> {
  switch (job.kind) {
    case "SETTLE_DEADLINE":
      return handleSettleDeadline(ctx, job);
    case "PROCESS_OPERATIONS":
      return handleProcessOperations(ctx, job);
    case "RECONCILE_PAYMENT":
      return handleReconcilePayment(ctx, job);
    default: {
      const never: never = job.kind;
      throw new Error(`unknown job kind ${String(never)}`);
    }
  }
}
