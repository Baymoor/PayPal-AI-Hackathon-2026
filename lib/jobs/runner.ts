/**
 * One worker tick: claim due jobs, dispatch them, run due payment
 * operations, and self-heal (any COLLECTING outing whose deadline passed
 * without a settlement snapshot is settled even if its job was lost).
 *
 * Safe to run from several processes at once: jobs are claimed with
 * SKIP LOCKED, operations are claimed atomically, and settlement is
 * serialised by the outing row lock + the unique snapshot.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { claimDueJobs, completeJob, failJob } from "./queue";
import { dispatchJob, type HandlerContext } from "./handlers";
import { runDeadlineSettlement } from "../settlement/deadline";
import { processDueOperations } from "../settlement/operations";
import type { ProviderResolver } from "../settlement/types";

export interface WorkerTickOptions {
  workerId: string;
  now?: Date;
  maxJobs?: number;
  /** Job lease; a crashed worker's job is re-claimable after this. */
  leaseMs?: number;
}

export interface WorkerTickResult {
  jobsRun: number;
  operationsRun: number;
  /** Outings settled by the self-healing sweep (not by a job). */
  sweptOutings: number;
  errors: string[];
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}

export async function runWorkerTick(db: Db, resolveProvider: ProviderResolver, opts: WorkerTickOptions): Promise<WorkerTickResult> {
  const now = opts.now ?? new Date();
  const ctx: HandlerContext = { db, resolveProvider, workerId: opts.workerId, now };
  const result: WorkerTickResult = { jobsRun: 0, operationsRun: 0, sweptOutings: 0, errors: [] };

  const jobs = await claimDueJobs(db, opts.workerId, opts.maxJobs ?? 10, opts.leaseMs ?? 60_000);
  for (const job of jobs) {
    try {
      await dispatchJob(ctx, job);
      await completeJob(db, job.id, opts.workerId);
      result.jobsRun++;
    } catch (err) {
      const message = describeError(err);
      result.errors.push(`job ${job.kind} ${job.id}: ${message}`);
      await failJob(db, job.id, opts.workerId, message);
    }
  }

  // Self-healing sweep: overdue COLLECTING outings without a snapshot.
  const overdue = await db.execute(sql`
    select o.id from outings o
    where o.status = 'COLLECTING' and o.deadline_at is not null and o.deadline_at <= now()
      and not exists (select 1 from settlement_snapshots s where s.outing_id = o.id)
    order by o.deadline_at asc
    limit 50
  `);
  for (const row of overdue.rows as { id: string }[]) {
    try {
      const r = await runDeadlineSettlement(db, resolveProvider, { outingId: row.id, now, workerId: opts.workerId });
      if (r.outcome === "SETTLE" || r.outcome === "CANCEL") result.sweptOutings++;
    } catch (err) {
      result.errors.push(`sweep ${row.id}: ${describeError(err)}`);
    }
  }

  const ops = await processDueOperations(db, resolveProvider, { now, workerId: opts.workerId });
  result.operationsRun += ops.operationsRun;
  result.errors.push(...ops.errors);
  return result;
}
