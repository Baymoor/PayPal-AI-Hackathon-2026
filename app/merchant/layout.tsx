import type { Metadata } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./merchant.css";
import "./owner-access.css";
import { MerchantHeader } from "@/components/merchant/MerchantHeader";
import { signedInMerchant } from "./signed-in-merchant";

export const metadata: Metadata = {
  title: "Merchant dashboard · Outings",
  description: "Group bookings, authorization holds, captures and refunds for a demo venue.",
};

export default async function MerchantLayout({ children }: { children: React.ReactNode }) {
  // Sign-in and sign-out both call router.refresh(), so the header follows the session.
  const merchant = await signedInMerchant();
  return (
    <div className="m-root" data-owner-access={merchant?.ownerAccess ? "true" : "false"}>
      <MerchantHeader merchantName={merchant?.name ?? null} />
      <main id="main">{children}</main>
    </div>
  );
}
