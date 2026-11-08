import type { MerchantBookingRow } from "@/lib/contracts/views";

/**
 * Booking Readiness rule (deterministic; shown verbatim in the widget footer).
 *
 * Applies to OPEN outings only (status COLLECTING). Deadline policy is ALL_REQUIRED:
 *   gaps    = missingRequired (required invited - required accepted) and
 *             payerGap (minPayers - payersAuthorized, floored at 0)
 *   READY       no gaps
 *   AT RISK     gaps remain and more than WILL_CANCEL_MINUTES left
 *   WILL CANCEL gaps remain and the deadline is within WILL_CANCEL_MINUTES or has passed
 *               (the deadline job would cancel and release holds)
 * Nothing here moves money; it only explains what the settlement rule will decide.
 */
export const WILL_CANCEL_MINUTES = 30;

export type Verdict = "READY" | "AT_RISK" | "WILL_CANCEL";

export const VERDICT_LABEL: Record<Verdict, string> = { READY: "Ready", AT_RISK: "At risk", WILL_CANCEL: "Will cancel" };

export const READINESS_RULE_TEXT =
  `Ready when every required person has accepted and enough payers have authorized. ` +
  `Will cancel when ${WILL_CANCEL_MINUTES} minutes or less remain, or the deadline has passed.`;

export interface ReadinessInput {
  requiredAccepted: number;
  requiredInvited: number;
  payersAuthorized: number;
  minPayers: number | null;
  minutesLeft: number | null;
}

export interface Readiness {
  verdict: Verdict;
  missingRequired: number;
  payerGap: number;
  reasons: string[];
}

export function assessReadiness(i: ReadinessInput): Readiness {
  const missingRequired = Math.max(0, i.requiredInvited - i.requiredAccepted);
  const payerGap = i.minPayers === null ? 0 : Math.max(0, i.minPayers - i.payersAuthorized);
  const reasons: string[] = [];
  if (missingRequired > 0) reasons.push(`${missingRequired} required ${missingRequired === 1 ? "person has" : "people have"} not accepted`);
  if (payerGap > 0) reasons.push(`${payerGap} more ${payerGap === 1 ? "payer" : "payers"} must authorize`);
  if (reasons.length === 0) return { verdict: "READY", missingRequired, payerGap, reasons: ["All requirements met"] };
  const late = i.minutesLeft !== null && i.minutesLeft <= WILL_CANCEL_MINUTES;
  return { verdict: late ? "WILL_CANCEL" : "AT_RISK", missingRequired, payerGap, reasons };
}

export function assessRow(r: MerchantBookingRow, minutesLeft = r.closesInMinutes): Readiness {
  return assessReadiness({
    requiredAccepted: r.requiredAccepted,
    requiredInvited: r.requiredInvited,
    payersAuthorized: r.payersAuthorized,
    minPayers: r.minPayers,
    minutesLeft,
  });
}

export function minutesUntil(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : (t - now) / 60000;
}
