/** POST /api/merchant/logout */
import { MERCHANT_COOKIE, clearCookie } from "@/lib/auth/session";
import { assertSameOrigin, handle, json } from "@/lib/http";

export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  return json({ ok: true }, { headers: { "set-cookie": clearCookie(MERCHANT_COOKIE) } });
});
