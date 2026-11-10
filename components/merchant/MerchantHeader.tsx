"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { FIXTURE_PAYMENT_LABEL } from "@/components/ui/Badge";
import { merchantLogout } from "./api";
import { usePaymentMode } from "./modes";

/** `merchantName`: the signed-in merchant, resolved on the server; a generic label without a session. */
export function MerchantHeader({ merchantName = null }: { merchantName?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const paymentMode = usePaymentMode();
  const onLogin = pathname?.startsWith("/merchant/login");

  async function signOut() {
    setBusy(true);
    try {
      await merchantLogout();
    } catch {
      /* cookie may already be gone */
    }
    router.push("/merchant/login");
    router.refresh();
    setBusy(false);
  }

  return (
    <header className="m-header">
      <div className="m-header-in">
        <Link href="/merchant" className="m-brand">
          Outings
          {/* Same spark as the consumer logo (components/ui/SiteChrome.tsx): one mark for the whole product. */}
          <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M5 14 L9 12 M7 7 L11 9 M12 4 L12 9" />
          </svg>
        </Link>
        <span className="m-merchant">{merchantName ? `${merchantName} · Merchant` : "Merchant"}</span>
        <span className="m-header-sp" />
        {paymentMode === "PAYPAL_SANDBOX" && <span className="m-badge" data-tone="navy">PayPal sandbox</span>}
        {paymentMode === "FIXTURE" && <span className="m-badge" data-tone="fixture">{FIXTURE_PAYMENT_LABEL}</span>}
        {paymentMode === "DISABLED" && <span className="m-badge">Payments off</span>}
        {!onLogin && (
          <Link href="/setup" className="m-setup-link">
            Setup
          </Link>
        )}
        {!onLogin && (
          <button type="button" className="m-signout" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
