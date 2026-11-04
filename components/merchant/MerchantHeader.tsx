"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { merchantLogout } from "./api";

export function MerchantHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
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
          Outings<span>.</span>
        </Link>
        <span className="m-merchant">The Sound Room · Merchant</span>
        <span className="m-header-sp" />
        <span className="m-badge" data-tone="navy">PayPal sandbox</span>
        {!onLogin && (
          <button type="button" className="m-signout" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
