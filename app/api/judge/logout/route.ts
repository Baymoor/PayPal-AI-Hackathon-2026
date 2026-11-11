/** POST /api/judge/logout: clears the judge session cookie. */
import { clearJudgeCookie } from "@/lib/auth/judge";
import { assertSameOrigin, handle, json } from "@/lib/http";

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  return json({ ok: true }, { headers: { "set-cookie": clearJudgeCookie() } });
});
