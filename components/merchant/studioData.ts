import type { AgDataSourcesDefinition } from "ag-studio";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import { CLEANUP_LABEL, OUTING_STATUS_LABEL } from "./labels";
import { formatInstant, merchantTz } from "./format";
import { refundDueMinor } from "./moneyFlow";

/** One flat row per outing, in major currency units for Studio's currency format. */
export interface StudioRow {
  id: string;
  title: string;
  mode: "Sandbox" | "Fixture";
  /** Same as mode with trailing em spaces: works around Studio's grid auto-size truncating the column. */
  modeLabel: string;
  status: string;
  closingAt: string | null;
  closingLabel: string;
  requiredAccepted: number;
  requiredInvited: number;
  requiredLabel: string;
  payersLabel: string;
  missingRequired: number;
  payersAuthorized: number;
  minPayers: number;
  authorized: number;
  allocated: number;
  captured: number;
  refunded: number;
  recovery: string;
  /** Integer minor units (exact sums): used by the Money flow widget. */
  holdMinor: number;
  allocatedMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  refundDueMinor: number;
  voidPending: number;
  refundPending: number;
  /** KPI helpers (0/1 or major units) so Studio value widgets cross-filter like everything else. */
  isOpen: number;
  closesTodayOpen: number;
  closesTodayFlag: number;
  capturedConfirmed: number;
  refundDue: number;
  confirmedRecently: number;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function toStudioRow(r: MerchantBookingRow, now = Date.now()): StudioRow {
  return {
    id: r.outingId,
    title: r.title,
    mode: r.isFixture ? "Fixture" : "Sandbox",
    modeLabel: `${r.isFixture ? "Fixture" : "Sandbox"}\u2003\u2003\u2003`,
    status: OUTING_STATUS_LABEL[r.status],
    closingAt: r.deadlineAt,
    closingLabel: formatInstant(r.deadlineAt),
    requiredAccepted: r.requiredAccepted,
    requiredInvited: r.requiredInvited,
    requiredLabel: `${r.requiredAccepted} / ${r.requiredInvited}`,
    payersLabel: `${r.payersAuthorized} / ${r.minPayers ?? "n/a"}`,
    missingRequired: r.missingRequired,
    payersAuthorized: r.payersAuthorized,
    minPayers: r.minPayers ?? 0,
    authorized: r.authorizedTotalMinor / 100,
    allocated: r.allocatedTotalMinor / 100,
    captured: r.capturedTotalMinor / 100,
    refunded: r.refundedTotalMinor / 100,
    recovery: CLEANUP_LABEL[r.recoveryStatus],
    holdMinor: r.authorizedTotalMinor,
    allocatedMinor: r.allocatedTotalMinor,
    capturedMinor: r.capturedTotalMinor,
    refundedMinor: r.refundedTotalMinor,
    refundDueMinor: refundDueMinor(r),
    voidPending: r.voidPendingCount,
    refundPending: r.refundPendingCount,
    isOpen: r.status === "COLLECTING" ? 1 : 0,
    closesTodayOpen: r.status === "COLLECTING" && r.closesToday ? 1 : 0,
    closesTodayFlag: r.closesToday ? 1 : 0,
    // Same definition the old KPI cards used: money actually collected on confirmed bookings.
    capturedConfirmed: r.status === "CONFIRMED" ? r.capturedTotalMinor / 100 : 0,
    refundDue: refundDueMinor(r) / 100,
    // "Confirmed this week" = confirmed and the booking last changed within 7 days (no confirmation timestamp in the row).
    confirmedRecently: r.status === "CONFIRMED" && now - new Date(r.updatedAt).getTime() <= WEEK_MS ? 1 : 0,
  };
}

export const TABLE = "bookings";
export const f = (name: keyof StudioRow) => `${TABLE}.${name}`;

/** Pass rows for ONE currency only (Studio has no currency conversion). */
export function buildStudioData(rows: MerchantBookingRow[], currency: string): AgDataSourcesDefinition {
  const now = Date.now();
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: merchantTz(rows[0]), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const money = { format: new Intl.NumberFormat("en-US", { style: "currency", currency }) };
  return {
    description:
      "One row per outing booked with The Sound Room. Money fields are in major currency units of a single currency. " +
      "'Authorized holds' are uncaptured PayPal authorizations and are NOT revenue. 'Captured' is money actually collected. " +
      "Mode 'Sandbox' = real PayPal sandbox transactions; 'Fixture' = simulated payments (fixture simulator or synthetic demo rows), not real PayPal; never add them together without saying so.",
    sources: [
      {
        id: TABLE,
        name: "Bookings",
        description: "Group bookings, one row per outing.",
        data: rows.map((r) => toStudioRow(r, now)),
        fields: [
          { id: "id", name: "Outing ID", format: "textFormat", hide: true },
          { id: "title", name: "Outing", format: "textFormat" },
          { id: "mode", name: "Mode", format: "textFormat", description: "Sandbox = real PayPal sandbox; Fixture = simulated, not real PayPal" },
          { id: "modeLabel", name: "Row type", format: "textFormat", description: "Sandbox = real PayPal sandbox; Fixture = simulated, not real PayPal" },
          { id: "status", name: "Status", format: "textFormat" },
          { id: "closingAt", name: "Closing time", format: "dateTimeFormat", formatOptions: { format: dtf } },
          { id: "closingLabel", name: "Closes (merchant time)", format: "textFormat" },
          { id: "requiredAccepted", name: "Required accepted", format: "integerFormat" },
          { id: "requiredInvited", name: "Required invited", format: "integerFormat" },
          { id: "requiredLabel", name: "Required (accepted / invited)", format: "textFormat" },
          { id: "payersLabel", name: "Payers (authorized / min)", format: "textFormat" },
          { id: "missingRequired", name: "Missing required", format: "integerFormat" },
          { id: "payersAuthorized", name: "Payers authorized", format: "integerFormat" },
          { id: "minPayers", name: "Min payers", format: "integerFormat" },
          { id: "authorized", name: "Authorized hold (not revenue)", format: "currencyFormat", formatOptions: money, description: "Uncaptured holds. Not revenue." },
          { id: "allocated", name: "Final allocated", format: "currencyFormat", formatOptions: money },
          { id: "captured", name: "Captured (collected)", format: "currencyFormat", formatOptions: money },
          { id: "refunded", name: "Refunded", format: "currencyFormat", formatOptions: money },
          { id: "recovery", name: "Recovery status", format: "textFormat" },
          { id: "holdMinor", name: "Still on hold (minor units)", format: "integerFormat", hide: true, description: "Uncaptured holds in cents. Not revenue." },
          { id: "allocatedMinor", name: "Final allocated (minor units)", format: "integerFormat", hide: true },
          { id: "capturedMinor", name: "Captured (minor units)", format: "integerFormat", hide: true },
          { id: "refundedMinor", name: "Refunded (minor units)", format: "integerFormat", hide: true },
          { id: "refundDueMinor", name: "Refund pending (minor units)", format: "integerFormat", hide: true, description: "Captured minus refunded, only while the outing is in refund recovery." },
          { id: "voidPending", name: "Hold releases pending", format: "integerFormat" },
          { id: "refundPending", name: "Refunds pending", format: "integerFormat" },
          { id: "isOpen", name: "Open outing (1/0)", format: "integerFormat", hide: true },
          { id: "closesTodayOpen", name: "Open and closing today (1/0)", format: "integerFormat", hide: true },
          { id: "closesTodayFlag", name: "Closes today (1/0)", format: "integerFormat", hide: true },
          { id: "capturedConfirmed", name: "Captured on confirmed bookings", format: "currencyFormat", formatOptions: money, hide: true },
          { id: "refundDue", name: "Awaiting refund", format: "currencyFormat", formatOptions: money, hide: true, description: "Captured money waiting to be refunded." },
          { id: "confirmedRecently", name: "Confirmed, changed in last 7 days (1/0)", format: "integerFormat", hide: true },
        ],
      },
    ],
  };
}
