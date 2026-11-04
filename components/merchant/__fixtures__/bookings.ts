/**
 * Typed development fixtures for the merchant dashboard (used only with ?fixtures=1 in
 * non-production builds). Times are relative to `now` so "closing today" stays true.
 * These are NOT sandbox data: rows with isFixture=true are labelled "Fixture" in the UI,
 * and the sandbox-looking rows here exist only to exercise the layout.
 */
import type { MerchantBookingRow, MerchantOutingDetail, MerchantOperationRow, MerchantParticipantRow, QuoteView } from "@/lib/contracts/views";
import type { AttendanceState, PaymentStatus } from "@/lib/domain/types";
import type { DashboardQuery } from "@/lib/ai/types";
import { dayKey } from "../format";

const MIN = 60_000;
const HOUR = 60 * MIN;

type Seed = Partial<MerchantBookingRow> & Pick<MerchantBookingRow, "outingId" | "title" | "status">;

function row(now: number, minutesToDeadline: number | null, s: Seed): MerchantBookingRow {
  const deadline = minutesToDeadline === null ? null : new Date(now + minutesToDeadline * MIN);
  const reqInvited = s.requiredInvited ?? 4;
  const reqAccepted = s.requiredAccepted ?? reqInvited;
  return {
    offeringName: "Private karaoke room (up to 10)",
    recoveryStatus: "NONE",
    isFixture: false,
    provider: s.isFixture ? "FIXTURE" : "PAYPAL",
    currency: "USD",
    activityAt: deadline ? new Date(deadline.getTime() + 26 * HOUR).toISOString() : null,
    deadlineAt: deadline ? deadline.toISOString() : null,
    closesInMinutes: minutesToDeadline === null ? null : Math.round(minutesToDeadline),
    closesToday: deadline ? dayKey(deadline) === dayKey(new Date(now)) : false,
    requiredInvited: reqInvited,
    requiredAccepted: reqAccepted,
    missingRequired: reqInvited - reqAccepted,
    payersAuthorized: 0,
    minPayers: 4,
    capacity: 10,
    attendees: reqAccepted,
    totalMinor: 10000,
    capMinor: 2500,
    authorizedTotalMinor: 0,
    allocatedTotalMinor: 0,
    capturedTotalMinor: 0,
    refundedTotalMinor: 0,
    voidPendingCount: 0,
    refundPendingCount: 0,
    updatedAt: new Date(now - 4 * MIN).toISOString(),
    ...s,
  };
}

export function makeFixtureBookings(now = Date.now()): MerchantBookingRow[] {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return [
    // ---------------- Real PayPal sandbox rows ----------------
    row(now, 3 * 60, { outingId: id(1), title: "Maya's birthday karaoke", status: "COLLECTING", requiredInvited: 5, requiredAccepted: 4, missingRequired: 1, payersAuthorized: 3, minPayers: 4, attendees: 4, authorizedTotalMinor: 7500 }),
    row(now, 45, { outingId: id(2), title: "Design team celebration", status: "COLLECTING", requiredInvited: 4, requiredAccepted: 4, payersAuthorized: 4, minPayers: 4, attendees: 5, authorizedTotalMinor: 10000 }),
    row(now, 18 * 60, { outingId: id(3), title: "Leo's 30th", status: "COLLECTING", requiredInvited: 6, requiredAccepted: 6, payersAuthorized: 3, minPayers: 5, attendees: 6, authorizedTotalMinor: 6000 }),
    row(now, -26 * 60, { outingId: id(4), title: "Dev offsite karaoke", status: "CONFIRMED", requiredInvited: 5, requiredAccepted: 5, payersAuthorized: 5, minPayers: 4, attendees: 5, allocatedTotalMinor: 10000, capturedTotalMinor: 10000 }),
    row(now, -50 * 60, { outingId: id(5), title: "Priya's send-off", status: "CANCELLED", recoveryStatus: "VOID_PENDING", requiredInvited: 4, requiredAccepted: 3, missingRequired: 1, payersAuthorized: 3, minPayers: 4, attendees: 3, authorizedTotalMinor: 6000, voidPendingCount: 3 }),
    row(now, -30 * 60, { outingId: id(6), title: "Trivia crew night", status: "CANCELLED", recoveryStatus: "REFUND_PENDING", requiredInvited: 5, requiredAccepted: 5, payersAuthorized: 5, minPayers: 4, attendees: 5, allocatedTotalMinor: 10000, capturedTotalMinor: 6000, refundedTotalMinor: 2000, refundPendingCount: 2 }),
    row(now, -20 * 60, { outingId: id(7), title: "Alumni reunion room", status: "COMPENSATING", recoveryStatus: "NEEDS_ATTENTION", requiredInvited: 6, requiredAccepted: 6, payersAuthorized: 6, minPayers: 5, attendees: 6, allocatedTotalMinor: 10000, capturedTotalMinor: 5000, refundedTotalMinor: 0, refundPendingCount: 3 }),
    row(now, -72 * 60, { outingId: id(8), title: "Book club karaoke", status: "CANCELLED", recoveryStatus: "COMPLETE", requiredInvited: 4, requiredAccepted: 2, missingRequired: 2, payersAuthorized: 2, minPayers: 4, attendees: 2 }),
    row(now, -96 * 60, { outingId: id(9), title: "Sam's goodbye party", status: "CANCELLED", recoveryStatus: "COMPLETE", requiredInvited: 5, requiredAccepted: 5, payersAuthorized: 5, minPayers: 4, attendees: 5, allocatedTotalMinor: 10000, capturedTotalMinor: 10000, refundedTotalMinor: 10000 }),
    // ---------------- Synthetic fixture rows ----------------
    row(now, 12, { outingId: id(21), isFixture: true, title: "Fixture: Friday crew", status: "COLLECTING", requiredInvited: 4, requiredAccepted: 3, missingRequired: 1, payersAuthorized: 3, minPayers: 4, attendees: 3, authorizedTotalMinor: 7500 }),
    row(now, 2 * 60, { outingId: id(22), isFixture: true, title: "Fixture: Birthday for Noor", status: "COLLECTING", requiredInvited: 3, requiredAccepted: 1, missingRequired: 2, payersAuthorized: 1, minPayers: 3, attendees: 1, authorizedTotalMinor: 2500 }),
    row(now, -28 * 60, { outingId: id(23), isFixture: true, title: "Fixture: Hack night wrap", status: "CONFIRMED", requiredInvited: 6, requiredAccepted: 6, payersAuthorized: 6, minPayers: 5, attendees: 6, allocatedTotalMinor: 10000, capturedTotalMinor: 10000 }),
    row(now, -40 * 60, { outingId: id(24), isFixture: true, title: "Fixture: Capture failure drill", status: "CANCELLED", recoveryStatus: "REFUND_PENDING", requiredInvited: 5, requiredAccepted: 5, payersAuthorized: 5, minPayers: 4, attendees: 5, allocatedTotalMinor: 10000, capturedTotalMinor: 4000, refundPendingCount: 2 }),
    row(now, -60 * 60, { outingId: id(25), isFixture: true, title: "Fixture: Void in progress", status: "CANCELLED", recoveryStatus: "VOID_PENDING", requiredInvited: 3, requiredAccepted: 3, payersAuthorized: 2, minPayers: 3, attendees: 3, authorizedTotalMinor: 5000, voidPendingCount: 2 }),
    row(now, -80 * 60, { outingId: id(26), isFixture: true, title: "Fixture: Stuck refund", status: "COMPENSATING", recoveryStatus: "NEEDS_ATTENTION", requiredInvited: 4, requiredAccepted: 4, payersAuthorized: 4, minPayers: 4, attendees: 4, allocatedTotalMinor: 10000, capturedTotalMinor: 5000, refundPendingCount: 1 }),
  ];
}

/* ------------------------------ drill-down fixtures ------------------------------ */

const NAMES = ["Maya R.", "Ben T.", "Aisha K.", "Diego M.", "Chen W.", "Sofia L.", "Omar H.", "Nina P.", "Jules B.", "Tara S."];

function derivePayment(b: MerchantBookingRow, i: number, payers: number): { status: PaymentStatus | null; auth: number; cap: number; ref: number } {
  const share = 2500;
  if (i >= payers) return { status: null, auth: 0, cap: 0, ref: 0 };
  if (b.status === "CONFIRMED") return { status: "CAPTURED", auth: 0, cap: Math.round(b.capturedTotalMinor / payers), ref: 0 };
  if (b.recoveryStatus === "REFUND_PENDING" || b.recoveryStatus === "NEEDS_ATTENTION") {
    const capturedPayers = Math.max(1, Math.round((b.capturedTotalMinor / Math.max(1, b.allocatedTotalMinor)) * payers));
    if (i < capturedPayers) return { status: b.recoveryStatus === "NEEDS_ATTENTION" && i === 0 ? "UNKNOWN" : "REFUND_PENDING", auth: 0, cap: 2000, ref: 0 };
    return { status: i === capturedPayers ? "FAILED" : "VOIDED", auth: 0, cap: 0, ref: 0 };
  }
  if (b.recoveryStatus === "VOID_PENDING") return { status: "VOID_PENDING", auth: share, cap: 0, ref: 0 };
  if (b.status === "CANCELLED") return { status: b.refundedTotalMinor > 0 ? "REFUNDED" : "VOIDED", auth: 0, cap: b.refundedTotalMinor > 0 ? 2000 : 0, ref: b.refundedTotalMinor > 0 ? 2000 : 0 };
  return { status: i < b.payersAuthorized ? "AUTHORIZED" : "APPROVAL_PENDING", auth: i < b.payersAuthorized ? share : 0, cap: 0, ref: 0 };
}

export function makeFixtureDetail(b: MerchantBookingRow, now = Date.now()): MerchantOutingDetail {
  const total = Math.max(b.attendees, b.requiredInvited, 3);
  const payers = Math.max(1, Math.min(total, b.minPayers ?? total));
  const provider = b.isFixture ? "FIXTURE" : "PAYPAL";
  const participants: MerchantParticipantRow[] = Array.from({ length: total }, (_, i) => {
    const sponsored = i === 0 && total > payers;
    const accepted = i < b.requiredAccepted || i >= b.requiredInvited;
    const p = sponsored ? { status: null as PaymentStatus | null, auth: 0, cap: 0, ref: 0 } : derivePayment(b, i - (total > payers ? 1 : 0), payers);
    const attendance: AttendanceState = accepted ? "ACCEPTED" : i === total - 1 && b.status === "CANCELLED" ? "DECLINED" : "PENDING";
    const idx = String(i + 1).padStart(4, "0");
    return {
      participantId: `p-${b.outingId.slice(-4)}-${i}`,
      displayName: NAMES[i % NAMES.length],
      role: i === 0 ? "ORGANIZER" : "INVITEE",
      payerType: sponsored ? "SPONSORED" : "PAYER",
      required: i < b.requiredInvited,
      attendance,
      consentQuoteVersion: accepted ? 1 : null,
      consentAcceptedAt: accepted ? new Date(now - (6 - (i % 5)) * HOUR).toISOString() : null,
      consentCurrent: accepted,
      paymentStatus: p.status,
      provider: p.status ? provider : null,
      late: p.status === "FAILED" || (b.status === "CANCELLED" && i === total - 1 && b.missingRequired > 0 && p.status !== null),
      orderRef: p.status ? `…A${idx}` : null,
      authorizationRef: p.status && p.status !== "APPROVAL_PENDING" ? `…B${idx}` : null,
      captureRef: p.cap > 0 ? `…C${idx}` : null,
      refundRef: p.ref > 0 ? `…D${idx}` : null,
      authorizedMinor: p.auth,
      allocationMinor: b.allocatedTotalMinor > 0 && !sponsored ? Math.round(b.allocatedTotalMinor / payers) : null,
      capturedMinor: p.cap,
      refundedMinor: p.ref,
    };
  });

  const ops: MerchantOperationRow[] = [];
  const mk = (n: number, kind: MerchantOperationRow["kind"], status: MerchantOperationRow["status"], extra: Partial<MerchantOperationRow> = {}) =>
    ops.push({
      operationId: `op-${b.outingId.slice(-4)}-${n}`,
      participantName: participants[n % participants.length].displayName,
      kind, status, amountMinor: 2000, attempts: status === "PENDING" ? 0 : 1, lastError: null, providerStatus: null,
      updatedAt: new Date(now - (n + 1) * 7 * MIN).toISOString(), canRetry: false, ...extra,
    });
  if (b.status === "CONFIRMED") for (let n = 0; n < payers; n++) mk(n, "CAPTURE", "SUCCEEDED", { providerStatus: "COMPLETED" });
  if (b.recoveryStatus === "REFUND_PENDING" || b.recoveryStatus === "NEEDS_ATTENTION") {
    mk(0, "CAPTURE", "SUCCEEDED", { providerStatus: "COMPLETED" });
    mk(1, "CAPTURE", "FAILED", { attempts: 3, lastError: "INSTRUMENT_DECLINED (sandbox)", providerStatus: "DECLINED", canRetry: true, amountMinor: 2000 });
    mk(2, "VOID", "SUCCEEDED", { amountMinor: 2500, providerStatus: "VOIDED" });
    mk(3, "REFUND", b.recoveryStatus === "NEEDS_ATTENTION" ? "UNKNOWN" : "PENDING", { amountMinor: 2000, attempts: b.recoveryStatus === "NEEDS_ATTENTION" ? 2 : 0, lastError: b.recoveryStatus === "NEEDS_ATTENTION" ? "Timeout; outcome unknown, reconcile before retry" : null, canRetry: b.recoveryStatus === "NEEDS_ATTENTION" });
  }
  if (b.recoveryStatus === "VOID_PENDING") for (let n = 0; n < Math.max(1, b.voidPendingCount); n++) mk(n, "VOID", n === 0 ? "IN_FLIGHT" : "PENDING", { amountMinor: 2500 });
  if (b.recoveryStatus === "COMPLETE" && b.refundedTotalMinor > 0) for (let n = 0; n < 5; n++) mk(n, "REFUND", "SUCCEEDED", { providerStatus: "COMPLETED" });

  const quote: QuoteView | null = b.totalMinor === null ? null : {
    id: `q-${b.outingId.slice(-4)}`,
    version: 1,
    merchantName: "The Sound Room",
    offeringName: b.offeringName ?? "Private karaoke room",
    location: "Downtown",
    pricingModel: "FIXED_TOTAL",
    totalMinor: b.totalMinor,
    currency: b.currency,
    capMinor: b.capMinor ?? 2500,
    minPayers: b.minPayers ?? 4,
    capacity: b.capacity ?? 10,
    activityAt: b.activityAt ?? new Date(now).toISOString(),
    deadlineAt: b.deadlineAt ?? new Date(now).toISOString(),
    expiresAt: new Date((b.deadlineAt ? new Date(b.deadlineAt).getTime() : now) + HOUR).toISOString(),
    termsHash: "9f2c4ab1e07d83c55a1b6e0f4d7a92c3b8e1d0f6a4c2b9e7d5f3a1c8b6e4d2f0",
    merchantConfirmedAt: new Date(now - 3 * 24 * HOUR).toISOString(),
    availabilitySource: "FIXTURE",
    sponsoredNames: total > payers ? [participants[0].displayName] : [],
    requiredCount: b.requiredInvited,
  };

  const timeline = [
    { at: new Date(now - 72 * HOUR).toISOString(), actor: "Organizer", type: "Outing created" },
    { at: new Date(now - 60 * HOUR).toISOString(), actor: "Organizer", type: "Quote v1 confirmed by The Sound Room" },
    { at: new Date(now - 50 * HOUR).toISOString(), actor: "System", type: "Collection opened" },
    { at: new Date(now - 30 * HOUR).toISOString(), actor: participants[1].displayName, type: "Consent given and payment authorized" },
    ...(b.status === "CONFIRMED" ? [{ at: new Date(now - 24 * HOUR).toISOString(), actor: "System", type: "Settlement frozen: SETTLE; captures started" }] : []),
    ...(b.status === "CANCELLED" || b.status === "COMPENSATING" ? [{ at: new Date(now - 26 * HOUR).toISOString(), actor: "System", type: "Settlement frozen: CANCEL; recovery started" }] : []),
  ];

  return { booking: b, quote, participants, operations: ops, timeline };
}

/** Deterministic stand-in for POST /api/merchant/ai/query in ?fixtures=1 mode. NOT a model call. */
export function fixtureAsk(question: string): DashboardQuery {
  const q = question.toLowerCase();
  const filters: DashboardQuery["filters"] = [];
  if (q.includes("today")) filters.push({ field: "closesToday", op: "eq", value: true });
  if (q.includes("missing")) filters.push({ field: "missingRequired", op: "gt", value: 0 });
  if (q.includes("refund")) filters.push({ field: "cleanup", op: "eq", value: "REFUND_PENDING" });
  if (q.includes("attention")) filters.push({ field: "cleanup", op: "eq", value: "NEEDS_ATTENTION" });
  if (q.includes("confirmed")) filters.push({ field: "status", op: "eq", value: "CONFIRMED" });
  if (filters.length && (q.includes("today") || q.includes("missing"))) filters.push({ field: "status", op: "eq", value: "COLLECTING" });
  return {
    filters,
    sort: q.includes("today") || q.includes("closing") ? { field: "closesWithinHours", direction: "asc" } : null,
    focus: q.includes("readiness") || q.includes("missing") ? "READINESS" : null,
    explanation: filters.length ? "Keyword match on your question (fixture parser, no model call)." : "No recognised filter; showing everything.",
  };
}
