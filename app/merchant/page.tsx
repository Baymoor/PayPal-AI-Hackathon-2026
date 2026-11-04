import DashboardClient from "@/components/merchant/DashboardClient";

export const dynamic = "force-dynamic";

export default async function MerchantDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  // Dev-only fixture mode; hard-disabled in production builds.
  const fixtures = process.env.NODE_ENV !== "production" && sp.fixtures === "1";
  // Configuration value; passed to the client provider, never logged.
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY?.trim() || undefined;
  const aiEnabled = Boolean(process.env.OUTINGS_ANTHROPIC_API_KEY?.trim()) && process.env.MERCHANT_STUDIO_AI === "true";
  return <DashboardClient licenseKey={licenseKey} fixtures={fixtures} aiEnabled={aiEnabled} />;
}
