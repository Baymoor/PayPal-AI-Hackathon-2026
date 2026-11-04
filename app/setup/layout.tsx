import type { Metadata } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "../merchant/merchant.css";
import { MerchantHeader } from "@/components/merchant/MerchantHeader";

export const metadata: Metadata = { title: "Setup diagnostics · Outings", robots: { index: false } };

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="m-root">
      <MerchantHeader />
      <main id="main">{children}</main>
    </div>
  );
}
