/**
 * Demo scenarios (demo only; 404 when DEMO_FIXTURES_ENABLED is off).
 *
 * POST /api/demo/scenario {kind: "settle-soon" | "holdout" | "capture-failure", deadlineSeconds?: 60-600 (default 120)}
 *   -> 201 {outingId, kind, title, deadlineAt, deadlineSeconds, serverNow, personas: [{participantId, displayName, role, payerType, note}], tickAvailable}
 *   Creates a FRESH fixture outing in COLLECTING (see lib/demo/scenarios.ts). Switch personas with POST /api/demo/persona.
 * GET /api/demo/scenario?outingId=<uuid>
 *   -> status of a fixture outing (status, money clean-up, operation counts, one-line headline). 404 for real outings.
 */
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { assertSameOrigin, handle, json, notFound, readJson } from "@/lib/http";
import { DEMO_SCENARIO_DEADLINE_SECONDS, DEMO_SCENARIO_KINDS } from "@/lib/demo/constants";
import { createDemoScenario, demoScenarioStatus, demoTickAllowed } from "@/lib/demo/scenarios";
import { RATE_LIMITS, rateLimit } from "@/lib/rate-limit";

const Body = z.object({
  kind: z.enum(DEMO_SCENARIO_KINDS),
  deadlineSeconds: z.number().int().min(DEMO_SCENARIO_DEADLINE_SECONDS.min).max(DEMO_SCENARIO_DEADLINE_SECONDS.max).optional(),
});

export const POST = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  assertSameOrigin(req);
  rateLimit(req, "demo:scenario", RATE_LIMITS.demo);
  const input = await readJson(req, Body);
  const scenario = await createDemoScenario(getDb(), { kind: input.kind, deadlineSeconds: input.deadlineSeconds });
  return json({ ...scenario, tickAvailable: demoTickAllowed() }, { status: 201 });
});

export const GET = handle(async (req: Request) => {
  if (!config().demoFixturesEnabled) throw notFound();
  const parsed = z.string().uuid().safeParse(new URL(req.url).searchParams.get("outingId"));
  if (!parsed.success) throw notFound("Unknown demo outing");
  const status = await demoScenarioStatus(getDb(), parsed.data);
  if (!status) throw notFound("Unknown demo outing");
  return json({ ...status, tickAvailable: demoTickAllowed() });
});
