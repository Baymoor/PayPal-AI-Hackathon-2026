"use client";
import { useSearchParams } from "next/navigation";
import { StatusBanner } from "./StatusBanner";

/**
 * Shown on the landing page when a PayPal return/cancel arrives without a participant session
 * (`/?payment=signin`). The outing id is deliberately not in the URL, so we can't say more.
 */
export function PaymentSigninNotice() {
  const params = useSearchParams();
  if (params.get("payment") !== "signin") return null;
  return (
    <StatusBanner tone="warning" title="Open your invitation link to continue" className="mb-6">
      For privacy we can&apos;t show this outing without it.
    </StatusBanner>
  );
}
