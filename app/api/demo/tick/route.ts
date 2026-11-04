/**
 * POST /api/demo/tick {outingId?} (demo only): run ONE worker tick now, exactly what the
 * scheduler / `npm run worker` does (`runWorkerTick`: due jobs, overdue settlements, due
 * payment operations), so a demo does not have to wait for the next poll.
 *
 * Why no CRON_SECRET: this is a demo convenience button. It is only available when
 * DEMO_FIXTURES_ENABLED is on (404 otherwise) and either NODE_ENV is not production, or
 * DEMO_ALLOW_PUBLIC_TICK=true is set explicitly (403 otherwise). In a hosted demo the real
 * worker or a cron hitting /api/cron/tick with the bearer secret keeps running; the button
 * only saves waiting. It cannot settle anything early: a tick only processes DUE work, and the
 * settlement engine freezes and decides strictly against the stored deadline using the
 * database clock (lib/settlement/deadline.ts).
 *
 * With `outingId` (a fixture outing) the response also carries that outing's status.
 */
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { ServiceError, assertSameOrigin, handle, json, notFound, readJson } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments";
import { runWorkerTick } from "@/lib/jobs/runner";
import { demoScenarioStatus, demoTickAllowed } from "@/lib/demo/scenarios";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({ outingId: z.string().uuid().optional() });

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  assertSameOrigin(req);
  if (!demoTickAllowed()) {
    throw new ServiceError(
      "DEMO_TICK_DISABLED",
      403,
      "On this deployment the background worker processes due work on its own. Set DEMO_ALLOW_PUBLIC_TICK=true to enable this demo button.",
    );
  }
  rateLimit(req, "demo:tick", RATE_LIMITS.mutation);
  const { outingId } = await readJson(req, Body);

  const workerId = `demo-tick:${process.pid}:${Date.now().toString(36)}`;
  const db = getDb();
  const result = await runWorkerTick(db, getPaymentProvider, { workerId });
  if (result.errors.length > 0) console.error("[outings] demo tick errors", result.errors);
  const outing = outingId ? await demoScenarioStatus(db, outingId) : null;
  return json({
    ok: result.errors.length === 0,
    mode: "DEMO_TICK",
    workerId,
    jobsRun: result.jobsRun,
    operationsRun: result.operationsRun,
    sweptOutings: result.sweptOutings,
    errors: result.errors,
    serverNow: new Date().toISOString(),
    outing,
  });
});
