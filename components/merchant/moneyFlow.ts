import type { MerchantBookingRow } from "@/lib/contracts/views";

/**
 * Money-flow arithmetic: integer minor units only, derived exactly from the booking row.
 *
 *   authorizedTotalMinor  = holds that are still AUTHORIZED (uncaptured; not revenue)
 *   capturedTotalMinor    = everything ever captured (refunded money is still counted here)
 *   refundedTotalMinor    = refunded after capture
 *
 * Segments (they add up to captured + still-on-hold):
 *   refundDue  = captured - refunded, only while the outing is in refund recovery
 *   kept       = captured - refunded - refundDue
 *   refunded   = refunded
 *   hold       = still on hold
 *
 * Holds that were voided or expired are NOT in the booking row, so "released" is not drawn.
 */
export interface FlowAmounts {
  authorizedMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  refundDueMinor: number;
}

export interface FlowSegments {
  keptMinor: number;
  refundDueMinor: number;
  refundedMinor: number;
  holdMinor: number;
  totalMinor: number;
}

/** Captured money that is waiting to be refunded (0 unless the outing is in refund recovery). */
export function refundDueMinor(r: Pick<MerchantBookingRow, "recoveryStatus" | "refundPendingCount" | "capturedTotalMinor" | "refundedTotalMinor">): number {
  const inRefund = r.recoveryStatus === "REFUND_PENDING" || r.refundPendingCount > 0;
  return inRefund ? Math.max(0, r.capturedTotalMinor - r.refundedTotalMinor) : 0;
}

export function flowSegments(a: FlowAmounts): FlowSegments {
  const due = Math.min(Math.max(0, a.refundDueMinor), Math.max(0, a.capturedMinor - a.refundedMinor));
  const kept = Math.max(0, a.capturedMinor - a.refundedMinor - due);
  const hold = Math.max(0, a.authorizedMinor);
  const refunded = Math.max(0, a.refundedMinor);
  return { keptMinor: kept, refundDueMinor: due, refundedMinor: refunded, holdMinor: hold, totalMinor: kept + due + refunded + hold };
}

export const MONEY_FLOW_FORMULA =
  "Bar = captured + still on hold. Kept = captured - refunded - refund pending. " +
  "Refund pending = captured - refunded on outings in refund recovery. " +
  "Holds that were released or expired are not in the booking data, so they are not drawn.";
