import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MERCHANT_COOKIE, merchantSessionFromCookieValue } from "@/lib/auth/session";
import OutingDetailClient from "@/components/merchant/OutingDetailClient";

export const dynamic = "force-dynamic";

export default async function MerchantOutingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const fixtures = process.env.NODE_ENV !== "production" && sp.fixtures === "1";
  if (!fixtures) {
    const jar = await cookies();
    if (!merchantSessionFromCookieValue(jar.get(MERCHANT_COOKIE)?.value)) redirect("/merchant/login");
  }
  return <OutingDetailClient outingId={id} fixtures={fixtures} />;
}
