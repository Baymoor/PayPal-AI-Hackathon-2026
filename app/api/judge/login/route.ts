/**
 * POST /api/judge/login {username, password}: constant-time check, then a signed judge session cookie.
 * A wrong username and a wrong password give the same answer.
 */
import { z } from "zod";
import { judgeCookie, judgeCredentialsMatch, judgeGateEnabled } from "@/lib/auth/judge";
import { ServiceError, assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { RATE_LIMITS, clientIp, hasToken, rateLimit, takeToken } from "@/lib/rate-limit";

const Body = z.object({ username: z.string().max(200), password: z.string().max(200) });

const FAILURE_ROUTE = "judge:login:failed";

const tooManyFailures = () => new ServiceError("RATE_LIMITED", 429, "Too many wrong sign-in attempts. Wait a minute and try again.", 60);

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  rateLimit(req, "judge:login", RATE_LIMITS.judgeLogin);
  // Checked before the credentials, so a locked-out client learns nothing from further guesses.
  if (!hasToken(req, FAILURE_ROUTE, RATE_LIMITS.judgeLoginFailure)) throw tooManyFailures();
  const credentials = await readJson(req, Body);
  if (!judgeGateEnabled()) throw new ServiceError("LOGIN_DISABLED", 503, "Judge sign-in is not switched on for this deployment");
  if (!judgeCredentialsMatch(credentials)) {
    takeToken(`${clientIp(req)}|${FAILURE_ROUTE}`, RATE_LIMITS.judgeLoginFailure);
    throw new ServiceError("INVALID_CREDENTIALS", 401, "Wrong username or password");
  }
  return json({ ok: true }, { headers: { "set-cookie": judgeCookie() } });
});
