import type { AttendanceState, OperationKind, OperationStatus, OutingStatus, PaymentStatus, CleanupState } from "@/lib/domain/types";

/** Human labels. Status is always shown as text (never colour alone). */
export const OUTING_STATUS_LABEL: Record<OutingStatus, string> = {
  DRAFT: "Draft",
  BUDGETING: "Budgeting",
  PROPOSED: "Proposed",
  COLLECTING: "Collecting",
  SETTLING: "Settling",
  CONFIRMED: "Confirmed",
  CANCELLING: "Cancelling",
  COMPENSATING: "Recovering",
  CANCELLED: "Cancelled",
};

export const CLEANUP_LABEL: Record<CleanupState, string> = {
  NONE: "None",
  VOID_PENDING: "Hold release pending",
  REFUND_PENDING: "Refund pending",
  NEEDS_ATTENTION: "Needs attention",
  COMPLETE: "Complete",
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  CREATED: "Created",
  APPROVAL_PENDING: "Approval pending",
  AUTHORIZED: "Authorized",
  CAPTURE_PENDING: "Capture pending",
  CAPTURED: "Captured",
  VOID_PENDING: "Hold release pending",
  VOIDED: "Hold released",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
  FAILED: "Failed",
  UNKNOWN: "Unknown (being checked)",
};

export const ATTENDANCE_LABEL: Record<AttendanceState, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
};

/** Audit event type for people: "PAYMENT_ORDER_CREATED" -> "Payment order created" (the raw enum read as a debug log). */
export function eventLabel(type: string): string {
  const words = type.toLowerCase().replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : type;
}

export const OP_KIND_LABEL: Record<OperationKind, string> = { CAPTURE: "Capture", VOID: "Release hold", REFUND: "Refund" };

export const OP_STATUS_LABEL: Record<OperationStatus, string> = {
  PENDING: "Pending",
  IN_FLIGHT: "In progress",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  UNKNOWN: "Unknown",
  SKIPPED: "Skipped",
};

export type Tone = "neutral" | "authorized" | "captured" | "pending" | "refunded" | "cancelled" | "danger" | "fixture";

export function cleanupTone(c: CleanupState): Tone {
  return c === "NEEDS_ATTENTION" ? "danger" : c === "COMPLETE" ? "captured" : c === "NONE" ? "neutral" : "pending";
}
export function outingTone(s: OutingStatus): Tone {
  switch (s) {
    case "CONFIRMED": return "captured";
    case "CANCELLED": return "cancelled";
    case "COMPENSATING": case "CANCELLING": return "pending";
    case "COLLECTING": case "SETTLING": return "authorized";
    default: return "neutral";
  }
}
export function paymentTone(s: PaymentStatus | null): Tone {
  switch (s) {
    case "AUTHORIZED": case "CAPTURE_PENDING": case "APPROVAL_PENDING": return "authorized";
    case "CAPTURED": return "captured";
    case "VOID_PENDING": case "REFUND_PENDING": return "pending";
    case "REFUNDED": return "refunded";
    case "VOIDED": return "cancelled";
    case "FAILED": case "UNKNOWN": return "danger";
    default: return "neutral";
  }
}
export function opStatusTone(s: OperationStatus): Tone {
  return s === "SUCCEEDED" ? "captured" : s === "FAILED" || s === "UNKNOWN" ? "danger" : s === "SKIPPED" ? "cancelled" : "pending";
}
