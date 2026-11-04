import DashboardClient from "@/components/merchant/DashboardClient";

export const dynamic = "force-dynamic";

export default async function MerchantDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  // Dev-only fixture mode; hard-disabled in production builds.
  const fixtures = process.env.NODE_ENV !== "production" && sp.fixtures === "1";
  // Configuration value; passed to the client provider, never logged.
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY?.trim() || undefined;
  // Studio's AI module needs a PRO-AI licence; trial mode (no key) unlocks it. Offer the assistant only when
  // a real Anthropic key exists AND we are either on trial or explicitly licensed for PRO-AI.
  const hasModel = Boolean(process.env.OUTINGS_ANTHROPIC_API_KEY?.trim());
  const aiEnabled =
    (hasModel && (!licenseKey || process.env.AG_STUDIO_AI_LICENSED === "true")) ||
    (process.env.NODE_ENV !== "production" && fixtures && sp.ai === "1"); // dev-only preview of the panel
  return <DashboardClient licenseKey={licenseKey} fixtures={fixtures} aiEnabled={aiEnabled} />;
}
