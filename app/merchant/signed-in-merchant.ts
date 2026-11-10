import "server-only";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db/client";
import { MERCHANT_COOKIE, isPasswordSession, merchantSessionFromCookieValue } from "@/lib/auth/session";
import { merchantNameFor } from "@/lib/services/merchant";

export interface SignedInMerchant {
  /** The merchant the session is scoped to; null when the name could not be loaded. */
  name: string | null;
  /** True for a dashboard-password session. The one-click demo sign-in never gets owner pages (/setup). */
  ownerAccess: boolean;
}

/** Who the dashboard session belongs to (demo sign-in can pick any demo venue), or null without a session. */
export async function signedInMerchant(): Promise<SignedInMerchant | null> {
  const session = merchantSessionFromCookieValue((await cookies()).get(MERCHANT_COOKIE)?.value);
  if (!session) return null;
  const ownerAccess = isPasswordSession(session);
  try {
    return { name: await merchantNameFor(getDb(), session.merchantId), ownerAccess };
  } catch {
    // Only a label: the dashboard itself reports database trouble, so the header falls back to a generic one.
    return { name: null, ownerAccess };
  }
}

/** Name of the signed-in merchant, or null without a session. */
export async function signedInMerchantName(): Promise<string | null> {
  return (await signedInMerchant())?.name ?? null;
}
