import type { AgDataSourcesDefinition } from "ag-studio";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import { CLEANUP_LABEL, OUTING_STATUS_LABEL } from "./labels";
import { formatInstant, MERCHANT_TIMEZONE } from "./format";

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
}

export function toStudioRow(r: MerchantBookingRow): StudioRow {
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
  };
}

export const TABLE = "bookings";
export const f = (name: keyof StudioRow) => `${TABLE}.${name}`;

/** Pass rows for ONE currency only (Studio has no currency conversion). */
export function buildStudioData(rows: MerchantBookingRow[], currency: string): AgDataSourcesDefinition {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: MERCHANT_TIMEZONE, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
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
        data: rows.map(toStudioRow),
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
        ],
      },
    ],
  };
}
