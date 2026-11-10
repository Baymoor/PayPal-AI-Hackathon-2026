/**
 * POST /api/merchant/setup/anthropic  (dashboard-password session, same-origin, rate-limited)
 * Owner diagnostics: one minimal real extractBrief call, only when the AI mode is ANTHROPIC.
 * Returns ok / model / latency / validated summary rows. The API key is never returned.
 */
import { assertSameOrigin, handle, json } from "@/lib/http";
import { config } from "@/lib/env";
import { getOutingsAi } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";
import { requirePasswordMerchant } from "@/lib/services/access";

export const dynamic = "force-dynamic";

const RULE = { capacity: 3, refillPerMinute: 3 };

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  requirePasswordMerchant(req);
  rateLimit(req, "merchant-setup-anthropic", RULE);

  const c = config();
  if (c.aiMode !== "ANTHROPIC") {
    return json({
      ok: false,
      mode: c.aiMode,
      status: "NOT_CONFIGURED",
      label: c.aiMode === "FIXTURE" ? "FIXTURE mode: canned keyword parser, not a real model" : "AI is disabled",
      message: "No Anthropic key configured (OUTINGS_ANTHROPIC_API_KEY). No model was called.",
    });
  }

  const started = Date.now();
  try {
    const r = await getOutingsAi().extractBrief({
      brief: "Dinner for four on Friday evening, around $40 each.",
      now: new Date(),
      timezone: "America/New_York",
    });
    return json({
      ok: true,
      mode: c.aiMode,
      status: "OK",
      source: r.source,
      model: r.model,
      latencyMs: Date.now() - started,
      summary: r.output.summary,
      warnings: r.warnings,
      message: "Claude answered and the output passed validation.",
    });
  } catch (err) {
    return json({
      ok: false,
      mode: c.aiMode,
      status: "ERROR",
      latencyMs: Date.now() - started,
      errorName: err instanceof Error ? err.name : "Error",
      httpStatus: typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : null,
      message: "The Anthropic call failed or its output did not validate. Check the key, model id and network; see server logs.",
    });
  }
});
