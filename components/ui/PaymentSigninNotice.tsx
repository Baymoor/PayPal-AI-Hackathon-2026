"use client";
import { useSearchParams } from "next/navigation";
import { StatusBanner } from "./StatusBanner";

/**
 * Shown on the landing page when a PayPal return/cancel arrives without a participant session
 * (`/?payment=signin`). The outing id is deliberately not in the URL, so we can't say more.
 *
 * Money claims are scoped to "this approval": the return route stops before authorizing when there is no
 * session, so this approval placed no hold. The person may still hold a valid payment from an earlier
 * attempt, so we never say anything about them overall; their outing page shows the real state.
 */
export function PaymentSigninNotice() {
  const params = useSearchParams();
  if (params.get("payment") !== "signin") return null;
  return (
    <StatusBanner tone="warning" title="Open your invitation link to finish" className="mb-6">
      <p>We couldn&apos;t finish this approval in this browser, so it didn&apos;t place a payment hold or charge anything.</p>
      <p className="mt-1">
        Open the personal link the organizer sent you on this device: your outing page shows whether you still need to
        authorize, and you can do it from there.
      </p>
    </StatusBanner>
  );
}
