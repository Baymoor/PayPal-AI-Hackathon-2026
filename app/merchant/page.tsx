import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isJudgeSession, judgeLoginHref } from "@/lib/auth/judge";
import { MERCHANT_COOKIE, merchantSessionFromCookieValue } from "@/lib/auth/session";
import DashboardClient from "@/components/merchant/DashboardClient";
import { signedInMerchantName } from "./signed-in-merchant";

export const dynamic = "force-dynamic";

export default async function MerchantDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  // Dev-only fixture mode; hard-disabled in production builds.
  const fixtures = process.env.NODE_ENV !== "production" && sp.fixtures === "1";
  // Check the session on the server so a visitor without one never triggers a failing client fetch.
  // (?fixtures=1 renders synthetic rows without calling the API, so it needs no session.)
  if (!fixtures) {
    const jar = await cookies();
    if (!merchantSessionFromCookieValue(jar.get(MERCHANT_COOKIE)?.value)) redirect("/merchant/login");
  }
  // Configuration value; passed to the client provider, never logged.
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY?.trim() || undefined;
  // Studio's AI module needs a PRO-AI licence; trial mode (no key) unlocks it. Offer the assistant only when
  // a real Anthropic key exists AND we are either on trial or explicitly licensed for PRO-AI.
  const hasModel = Boolean(process.env.OUTINGS_ANTHROPIC_API_KEY?.trim());
  const aiEnabled =
    (hasModel && (!licenseKey || process.env.AG_STUDIO_AI_LICENSED === "true")) ||
    (process.env.NODE_ENV !== "production" && fixtures && sp.ai === "1"); // dev-only preview of the panel
  // Fixture rows are all The Sound Room's; a real session names whichever venue it is scoped to.
  const merchantName = fixtures ? "The Sound Room" : await signedInMerchantName();
  // The assistant is real Claude: with the judge gate on, visitors who are not judges get a sign-in link instead.
  const assistantSignInHref = aiEnabled && !(await isJudgeSession()) ? judgeLoginHref("/merchant") : null;
  return <DashboardClient licenseKey={licenseKey} fixtures={fixtures} aiEnabled={aiEnabled} assistantSignInHref={assistantSignInHref} merchantName={merchantName} />;
}
