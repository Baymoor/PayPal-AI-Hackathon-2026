import "server-only";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db/client";
import { MERCHANT_COOKIE, merchantSessionFromCookieValue } from "@/lib/auth/session";
import { merchantNameFor } from "@/lib/services/merchant";

/**
 * Name of the merchant the dashboard session is scoped to (demo sign-in can pick any demo venue),
 * or null without a session.
 */
export async function signedInMerchantName(): Promise<string | null> {
  const session = merchantSessionFromCookieValue((await cookies()).get(MERCHANT_COOKIE)?.value);
  if (!session) return null;
  try {
    return await merchantNameFor(getDb(), session.merchantId);
  } catch {
    // Only a label: the dashboard itself reports database trouble, so the header falls back to a generic one.
    return null;
  }
}
