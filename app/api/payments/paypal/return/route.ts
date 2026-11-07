/**
 * GET /api/payments/paypal/return?attempt=<id>&token=<orderId>[&PayerID=…]
 *
 * PayPal redirects the buyer here after approval. The server (never the
 * browser) authorizes the order, verifies the authorization, flags it late if
 * needed, then redirects to /o/<id>?payment=authorized|late|pending|failed.
 * The session must belong to the participant who owns the attempt. Without a
 * participant session for the attempt's outing the browser is sent to a
 * neutral page: a valid attempt id alone never reveals which outing it is for.
 * Malformed and unknown attempt ids land on the same page, because this is a
 * browser navigation (never answer it with JSON) and one landing for all three
 * cases means the response does not reveal whether an attempt id exists.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paymentAttempts } from "@/lib/db/schema";
import { badRequest, handle, ServiceError } from "@/lib/http";
import { assertUuid, requireParticipant } from "@/lib/services/access";
import { completeApproval, paymentRedirectPath } from "@/lib/services/payments";

/** Neutral landing page when there is no session for the attempt's outing (no outing id in the URL). */
const SIGN_IN_REDIRECT = "/?payment=signin";

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  let attemptId: string;
  try {
    attemptId = assertUuid(url.searchParams.get("attempt") ?? "", "payment attempt");
  } catch (err) {
    if (err instanceof ServiceError) return redirect(SIGN_IN_REDIRECT);
    throw err;
  }
  const token = url.searchParams.get("token");
  const db = getDb();
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(paymentAttempts.id, attemptId),
    columns: { outingId: true },
  });
  if (!attempt) return redirect(SIGN_IN_REDIRECT);

  // Session first: nothing below may redirect to /o/<outingId> for a caller without a session for that outing.
  let participantId: string;
  try {
    participantId = (await requireParticipant(db, req, attempt.outingId)).participant.id;
  } catch (err) {
    if (err instanceof ServiceError && err.status === 401) return redirect(SIGN_IN_REDIRECT);
    throw err;
  }

  try {
    if (!token) throw badRequest("MISSING_TOKEN", "PayPal did not return an order token");
    const r = await completeApproval(db, { attemptId, participantId, orderId: token, now: new Date() });
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
