/**
 * POST /api/payments/fixture/approve { attemptId, outcome: "APPROVE" | "CANCEL" }
 *
 * FIXTURE ONLY — the simulated buyer-approval step ("Fixture — not real
 * PayPal"). 404 unless DEMO_FIXTURES_ENABLED and the attempt was created with
 * the FIXTURE provider. Accepts JSON (returns { outcome, redirectUrl }) or an
 * HTML form post (303 redirect to /o/<id>?payment=…).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { paymentAttempts } from "@/lib/db/schema";
import { config } from "@/lib/env";
import { assertSameOrigin, handle, json, notFound, readJson } from "@/lib/http";
import { assertUuid, requireParticipant } from "@/lib/services/access";
import { approveFixturePayment, paymentRedirectPath } from "@/lib/services/payments";

const Body = z.object({ attemptId: z.string(), outcome: z.enum(["APPROVE", "CANCEL"]) });

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  if (!config().demoFixturesEnabled) throw notFound("Not found");
  const isForm = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  const body = isForm ? Body.parse(Object.fromEntries(new URLSearchParams(await req.text()))) : await readJson(req, Body);
  const attemptId = assertUuid(body.attemptId, "payment attempt");

  const db = getDb();
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(paymentAttempts.id, attemptId),
    columns: { outingId: true, provider: true },
  });
  if (!attempt || attempt.provider !== "FIXTURE") throw notFound("Payment attempt not found");
  const { participant } = await requireParticipant(db, req, attempt.outingId);

  const r = await approveFixturePayment(db, { attemptId, participantId: participant.id, outcome: body.outcome, now: new Date() });
  const redirectUrl = paymentRedirectPath(r.outingId, r.outcome);
  if (isForm) return new Response(null, { status: 303, headers: { location: redirectUrl, "cache-control": "no-store" } });
  return json({ outcome: r.outcome, redirectUrl, paymentAttemptId: r.paymentAttemptId });
});
