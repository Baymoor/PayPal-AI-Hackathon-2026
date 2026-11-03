/**
 * Durable Postgres-backed job queue. Jobs are claimed with
 * `FOR UPDATE SKIP LOCKED`, leased with `locked_until`, and re-claimable after
 * the lease expires (crashed worker). Handlers must be idempotent: a job may
 * run more than once, and late — always evaluate against stored server-side
 * timestamps (e.g. the outing's deadline), never against "when the job ran".
 */
import { sql } from "drizzle-orm";
import { jobs, type Job } from "../db/schema";
import type { DbOrTx } from "../db/client";
import type { JobKind } from "../domain/types";

export interface EnqueueInput {
  kind: JobKind;
  outingId: string | null;
  runAt: Date;
  /** Unique logical identity, e.g. `settle:<outingId>:<quoteId>`. */
  dedupeKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /**
   * "ignore": keep an existing job with the same key untouched (default).
   * "requeue": if the existing job already finished (DONE/DEAD/FAILED),
   * queue it again at `runAt`; if it is still QUEUED, pull run_at earlier.
   */
  onConflict?: "ignore" | "requeue";
}

export async function enqueueJob(db: DbOrTx, input: EnqueueInput): Promise<void> {
  const values = {
    kind: input.kind,
    outingId: input.outingId,
    runAt: input.runAt,
    dedupeKey: input.dedupeKey,
    payload: input.payload ?? {},
    maxAttempts: input.maxAttempts ?? 10,
  };
  if ((input.onConflict ?? "ignore") === "ignore") {
    await db.insert(jobs).values(values).onConflictDoNothing({ target: jobs.dedupeKey });
    return;
  }
  await db
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.dedupeKey,
      set: {
        status: sql`case when ${jobs.status} in ('DONE','DEAD','FAILED') then 'QUEUED'::job_status else ${jobs.status} end`,
        runAt: sql`case when ${jobs.status} in ('DONE','DEAD','FAILED') then excluded.run_at else least(${jobs.runAt}, excluded.run_at) end`,
        attempts: sql`case when ${jobs.status} in ('DONE','DEAD','FAILED') then 0 else ${jobs.attempts} end`,
        lastError: sql`case when ${jobs.status} in ('DONE','DEAD','FAILED') then null else ${jobs.lastError} end`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Claim up to `limit` due jobs for `workerId`. Uses the DATABASE clock (now())
 * so all workers agree on time.
 */
export async function claimDueJobs(db: DbOrTx, workerId: string, limit = 10, leaseMs = 60_000): Promise<Job[]> {
  const result = await db.execute(sql`
    update jobs set
      status = 'RUNNING',
      locked_by = ${workerId},
      locked_until = now() + (${leaseMs} * interval '1 millisecond'),
      attempts = attempts + 1,
      updated_at = now()
    where id in (
      select id from jobs
      where (status = 'QUEUED' and run_at <= now())
         or (status = 'RUNNING' and locked_until < now())
      order by run_at asc
      for update skip locked
      limit ${limit}
    )
    returning id
  `);
  const ids = (result.rows as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  return db.query.jobs.findMany({ where: (j, { inArray }) => inArray(j.id, ids) });
}

export async function completeJob(db: DbOrTx, jobId: string, workerId: string): Promise<void> {
  await db.execute(sql`
    update jobs set status = 'DONE', locked_by = null, locked_until = null, updated_at = now()
    where id = ${jobId} and locked_by = ${workerId}
  `);
}

/** Record a failure; retry with exponential backoff until max attempts, then DEAD (visible). */
export async function failJob(db: DbOrTx, jobId: string, workerId: string, error: string): Promise<void> {
  await db.execute(sql`
    update jobs set
      status = case when attempts >= max_attempts then 'DEAD'::job_status else 'QUEUED'::job_status end,
      run_at = now() + (least(power(2, attempts), 600) * interval '1 second'),
      last_error = ${error.slice(0, 2000)},
      locked_by = null, locked_until = null, updated_at = now()
    where id = ${jobId} and locked_by = ${workerId}
  `);
}

export function settleJobKey(outingId: string, quoteId: string): string {
  return `settle:${outingId}:${quoteId}`;
}
export function operationsJobKey(outingId: string): string {
  return `ops:${outingId}`;
}
