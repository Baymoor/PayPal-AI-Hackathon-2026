/**
 * Scheduler endpoint: runs one worker tick (due jobs, overdue settlements,
 * due payment operations). Protected by `Authorization: Bearer $CRON_SECRET`.
 * Without CRON_SECRET it only works outside production in demo mode, and
 * says so in the response.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { json } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments";
import { runWorkerTick } from "@/lib/jobs/runner";

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

async function tick(req: Request): Promise<Response> {
  const c = config();
  let mode: "CRON_SECRET" | "DEMO_OPEN";
  if (c.cronSecret) {
    if (!bearerMatches(req.headers.get("authorization"), c.cronSecret)) {
      return json({ error: { code: "UNAUTHORIZED", message: "Bearer CRON_SECRET required" } }, { status: 401 });
    }
    mode = "CRON_SECRET";
  } else if (!c.isProduction && c.demoFixturesEnabled) {
    mode = "DEMO_OPEN";
  } else {
    return json({ error: { code: "CRON_SECRET_REQUIRED", message: "Set CRON_SECRET to enable the scheduler endpoint" } }, { status: 503 });
  }

  const workerId = `cron:${process.pid}:${Date.now().toString(36)}`;
  try {
    const result = await runWorkerTick(getDb(), getPaymentProvider, { workerId });
    return json({
      ok: result.errors.length === 0,
      mode,
      note: mode === "DEMO_OPEN" ? "CRON_SECRET is not set; endpoint is open because DEMO_FIXTURES_ENABLED and NODE_ENV is not production" : undefined,
      workerId,
      ...result,
    });
  } catch (err) {
    console.error("[outings] cron tick failed", err instanceof Error ? err.message : err);
    return json({ ok: false, mode, workerId, error: { code: "TICK_FAILED", message: "Worker tick failed; see server logs" } }, { status: 500 });
  }
}

export async function GET(req: Request): Promise<Response> {
  return tick(req);
}

export async function POST(req: Request): Promise<Response> {
  return tick(req);
}
