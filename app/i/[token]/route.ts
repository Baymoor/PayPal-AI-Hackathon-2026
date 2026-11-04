/**
 * GET /i/:token — invitation link. Verifies the HASHED token, sets the
 * participant session for that outing and redirects (303) to the hub.
 * The token never reaches the hub URL, logs or referrers.
 */
import { getDb } from "@/lib/db/client";
import { participantCookie, readParticipantSession, withOuting } from "@/lib/auth/session";
import { findParticipantByToken } from "@/lib/services/outings";
import { clientIp, RATE_LIMITS, takeToken } from "@/lib/rate-limit";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

function notFoundPage(status = 404): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Invitation not found · Outings</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF6EE;color:#1B2440;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:28rem;padding:2rem;text-align:center}h1{font-family:Georgia,serif;font-weight:600;font-size:1.75rem;margin:0 0 .5rem}a{color:#E8553E;font-weight:600}</style></head>
<body><main><h1>This invitation link doesn't work</h1><p>It may have been mistyped or replaced. Ask the organizer to send you a fresh link.</p><p><a href="/">Go to Outings</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!takeToken(`${clientIp(req)}|invite-open`, RATE_LIMITS.invite)) return notFoundPage(429);
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return notFoundPage();
  let participant;
  try {
    participant = await findParticipantByToken(getDb(), token);
  } catch {
    return notFoundPage(503);
  }
  if (!participant) return notFoundPage();
  const session = withOuting(readParticipantSession(req), participant.outingId, participant.id);
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(`/o/${participant.outingId}`, req.url).toString(),
      "set-cookie": participantCookie(session),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
