import type { Metadata } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./merchant.css";
import { MerchantHeader } from "@/components/merchant/MerchantHeader";
import { signedInMerchantName } from "./signed-in-merchant";

export const metadata: Metadata = {
  title: "Merchant dashboard · Outings",
  description: "Group bookings, authorization holds, captures and refunds for a demo venue.",
};

export default async function MerchantLayout({ children }: { children: React.ReactNode }) {
  // Sign-in and sign-out both call router.refresh(), so this label follows the session.
  const merchantName = await signedInMerchantName();
  return (
    <div className="m-root">
      <MerchantHeader merchantName={merchantName} />
      <main id="main">{children}</main>
    </div>
  );
}
