import type { Metadata } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./merchant.css";
import { MerchantHeader } from "@/components/merchant/MerchantHeader";

export const metadata: Metadata = {
  title: "Merchant dashboard · Outings",
  description: "The Sound Room: group bookings, authorization holds, captures and refunds.",
};

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="m-root">
      <MerchantHeader />
      <main id="main">{children}</main>
    </div>
  );
}
