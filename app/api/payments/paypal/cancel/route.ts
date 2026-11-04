/**
 * GET /api/payments/paypal/cancel?attempt=<id>[&token=<orderId>]
 * The buyer cancelled at PayPal: the attempt is abandoned (no hold exists).
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paymentAttempts } from "@/lib/db/schema";
import { handle, notFound, ServiceError } from "@/lib/http";
import { assertUuid, requireParticipant } from "@/lib/services/access";
import { cancelApproval, paymentRedirectPath } from "@/lib/services/payments";

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
  try {
    const { participant } = await requireParticipant(db, req, attempt.outingId);
    const r = await cancelApproval(db, {
      attemptId,
      participantId: participant.id,
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
