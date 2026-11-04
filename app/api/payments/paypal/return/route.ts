/**
 * GET /api/payments/paypal/return?attempt=<id>&token=<orderId>[&PayerID=…]
 *
 * PayPal redirects the buyer here after approval. The server (never the
 * browser) authorizes the order, verifies the authorization, flags it late if
 * needed, then redirects to /o/<id>?payment=authorized|late|pending|failed.
 * The session must belong to the participant who owns the attempt.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paymentAttempts } from "@/lib/db/schema";
import { badRequest, handle, notFound, ServiceError } from "@/lib/http";
import { assertUuid, requireParticipant } from "@/lib/services/access";
import { completeApproval, paymentRedirectPath } from "@/lib/services/payments";

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const attemptId = assertUuid(url.searchParams.get("attempt") ?? "", "payment attempt");
  const token = url.searchParams.get("token");
  const db = getDb();
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(paymentAttempts.id, attemptId),
    columns: { outingId: true },
  });
  if (!attempt) throw notFound("Payment attempt not found");
  try {
    const { participant } = await requireParticipant(db, req, attempt.outingId);
    if (!token) throw badRequest("MISSING_TOKEN", "PayPal did not return an order token");
    const r = await completeApproval(db, { attemptId, participantId: participant.id, orderId: token, now: new Date() });
    return redirect(paymentRedirectPath(r.outingId, r.outcome));
  } catch (err) {
    if (err instanceof ServiceError) {
      return redirect(`${paymentRedirectPath(attempt.outingId, "FAILED")}&reason=${encodeURIComponent(err.code.toLowerCase())}`);
    }
    // Unexpected failure: the outcome may be unknown (a reconcile job covers in-flight authorizations).
    console.error("[outings] paypal return failed", err instanceof Error ? err.message : err);
    return redirect(paymentRedirectPath(attempt.outingId, "PENDING"));
  }
});
