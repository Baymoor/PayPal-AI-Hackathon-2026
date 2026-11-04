/**
 * GET /api/payments/paypal/cancel?attempt=<id>[&token=<orderId>]
 * The buyer cancelled at PayPal: the attempt is abandoned (no hold exists).
 * Without a participant session for the attempt's outing the browser is sent
 * to a neutral page: a valid attempt id alone never reveals which outing it is for.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paymentAttempts } from "@/lib/db/schema";
import { handle, notFound, ServiceError } from "@/lib/http";
import { assertUuid, requireParticipant } from "@/lib/services/access";
import { cancelApproval, paymentRedirectPath } from "@/lib/services/payments";

/** Neutral landing page when there is no session for the attempt's outing (no outing id in the URL). */
const SIGN_IN_REDIRECT = "/?payment=signin";

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const attemptId = assertUuid(url.searchParams.get("attempt") ?? "", "payment attempt");
  const db = getDb();
  const attempt = await db.query.paymentAttempts.findFirst({
    where: eq(paymentAttempts.id, attemptId),
    columns: { outingId: true },
  });
  if (!attempt) throw notFound("Payment attempt not found");

  // Session first: nothing below may redirect to /o/<outingId> for a caller without a session for that outing.
  let participantId: string;
  try {
    participantId = (await requireParticipant(db, req, attempt.outingId)).participant.id;
  } catch (err) {
    if (err instanceof ServiceError && err.status === 401) return redirect(SIGN_IN_REDIRECT);
    throw err;
  }

  try {
    const r = await cancelApproval(db, {
      attemptId,
      participantId,
      orderId: url.searchParams.get("token"),
      now: new Date(),
    });
    return redirect(paymentRedirectPath(r.outingId, r.outcome));
  } catch (err) {
    if (err instanceof ServiceError) {
      return redirect(`${paymentRedirectPath(attempt.outingId, "FAILED")}&reason=${encodeURIComponent(err.code.toLowerCase())}`);
    }
    throw err;
  }
});
