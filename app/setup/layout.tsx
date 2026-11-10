import type { Metadata } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "../merchant/merchant.css";
import "../merchant/owner-access.css";
import { MerchantHeader } from "@/components/merchant/MerchantHeader";
import { signedInMerchant } from "../merchant/signed-in-merchant";

export const metadata: Metadata = { title: "Setup · Outings", robots: { index: false } };

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const merchant = await signedInMerchant();
  return (
    <div className="m-root" data-owner-access={merchant?.ownerAccess ? "true" : "false"}>
      <MerchantHeader merchantName={merchant?.name ?? null} />
      <main id="main">{children}</main>
    </div>
  );
}
