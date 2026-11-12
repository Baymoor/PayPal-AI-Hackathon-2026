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
  // Plain HTML (this is a route, not a page), styled to match the app: same colours, header, card and button.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Invitation not found · Outings</title>
<style>
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#FBF6F1;color:#14213D;font:16px/1.5 "Inter Variable",system-ui,-apple-system,"Segoe UI",sans-serif}
header{border-bottom:1px solid #EADFD3;padding:10px 20px}
.logo{font-family:"Fraunces Variable",Georgia,serif;font-weight:600;font-size:28px;color:#14213D;text-decoration:none}
main{flex:1;display:grid;place-items:center;padding:48px 20px}
.card{max-width:28rem;background:#fff;border:1px solid #EADFD3;border-radius:20px;padding:40px 24px;text-align:center}
h1{font-family:"Fraunces Variable",Georgia,serif;font-weight:600;font-size:28px;line-height:1.2;margin:0 0 8px}
p{margin:0;color:#5B6478}
.btn{display:inline-flex;align-items:center;min-height:52px;margin-top:20px;padding:0 28px;border:1.5px solid #14213D;border-radius:999px;color:#14213D;font-weight:600;text-decoration:none}
.btn:hover{background:#FDF1EC}
footer{padding:24px 20px;text-align:center;font-size:14px;color:#5B6478}
</style></head>
<body><header><a class="logo" href="/">Outings</a></header><main><div class="card"><h1>This invitation link doesn't work</h1><p>It may have been mistyped or replaced. Ask the organizer to send you a fresh link.</p><a class="btn" href="/">Back to home</a></div></main><footer>Independent hackathon project. No real money moves.</footer></body></html>`;
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
      // Relative on purpose: behind a reverse proxy, `next start` builds req.url from its own host and port
      // (https://localhost:3000), so an absolute URL sent invitees to a dead address. Browsers resolve this
      // against the public URL they actually opened, like the PayPal return route does.
      location: `/o/${participant.outingId}`,
      "set-cookie": participantCookie(session),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
