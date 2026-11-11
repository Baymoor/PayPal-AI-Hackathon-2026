import { DashboardQuerySchema, type DashboardQuery } from "@/lib/ai/types";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import { formatMoney } from "./format";
import { CLEANUP_LABEL, OUTING_STATUS_LABEL } from "./labels";

/**
 * Applies a validated, read-only DashboardQuery to booking rows entirely in the browser.
 * Only whitelisted fields exist here; there is no code path from a query to any
 * payment, capture, refund or retry action.
 */
type Field = DashboardQuery["filters"][number]["field"];
type Scalar = string | number | boolean | null;

const NUMERIC: ReadonlySet<Field> = new Set<Field>([
  "closesWithinHours", "missingRequired", "requiredAccepted", "requiredInvited", "payersAuthorized",
  "minPayers", "authorizedTotalMinor", "capturedTotalMinor", "refundedTotalMinor",
]);

export function fieldValue(row: MerchantBookingRow, field: Field): Scalar {
  switch (field) {
    case "status": return row.status;
    // Only deadlines still in the future count as "closing within"
    case "closesWithinHours": return row.closesInMinutes !== null && row.closesInMinutes >= 0 ? row.closesInMinutes / 60 : null;
    case "closesToday": return row.closesToday;
    case "missingRequired": return row.missingRequired;
    case "requiredAccepted": return row.requiredAccepted;
    case "requiredInvited": return row.requiredInvited;
    case "payersAuthorized": return row.payersAuthorized;
    case "minPayers": return row.minPayers;
    case "authorizedTotalMinor": return row.authorizedTotalMinor;
    case "capturedTotalMinor": return row.capturedTotalMinor;
    case "refundedTotalMinor": return row.refundedTotalMinor;
    case "cleanup": return row.recoveryStatus;
    case "isFixture": return row.isFixture;
  }
}

function coerce(field: Field, v: unknown): Scalar {
  if (NUMERIC.has(field)) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (field === "closesToday" || field === "isFixture") {
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    return null;
  }
  return typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
}

function matches(row: MerchantBookingRow, f: DashboardQuery["filters"][number]): boolean {
  const actual = fieldValue(row, f.field);
  if (f.op === "in") {
    const list = Array.isArray(f.value) ? f.value : [f.value];
    return actual !== null && list.some((x) => coerce(f.field, x) === actual);
  }
  const expected = coerce(f.field, Array.isArray(f.value) ? f.value[0] : f.value);
  if (f.op === "eq") return actual === expected;
  if (f.op === "neq") return actual !== expected;
  if (actual === null || expected === null || typeof actual === "boolean" || typeof expected === "boolean") return false;
  if (typeof actual === "string" || typeof expected === "string") return false;
  switch (f.op) {
    case "gt": return actual > expected;
    case "gte": return actual >= expected;
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
  }
  return false;
}

export function applyDashboardQuery(rows: MerchantBookingRow[], q: DashboardQuery | null): MerchantBookingRow[] {
  if (!q) return rows;
  let out = rows.filter((r) => q.filters.every((f) => matches(r, f)));
  if (q.sort) {
    const { field, direction } = q.sort;
    const dir = direction === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = fieldValue(a, field);
      const y = fieldValue(b, field);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }
  return out;
}

/** Re-validate whatever the server returned; throws on anything outside the whitelist. */
export function parseDashboardQuery(raw: unknown): DashboardQuery {
  return DashboardQuerySchema.parse(raw);
}

export const FIELD_LABEL: Record<Field, string> = {
  status: "Status",
  closesWithinHours: "Closes within (hours)",
  closesToday: "Closes today",
  missingRequired: "Missing required",
  requiredAccepted: "Required accepted",
  requiredInvited: "Required invited",
  payersAuthorized: "Payers authorized",
  minPayers: "Minimum payers",
  authorizedTotalMinor: "Authorized holds",
  capturedTotalMinor: "Captured",
  refundedTotalMinor: "Refunded",
  cleanup: "Recovery status",
  isFixture: "Simulated",
};

const OP_LABEL = { eq: "is", neq: "is not", gt: "more than", gte: "at least", lt: "less than", lte: "at most", in: "is one of" } as const;
const MONEY: ReadonlySet<Field> = new Set<Field>(["authorizedTotalMinor", "capturedTotalMinor", "refundedTotalMinor"]);
const YES_NO: ReadonlySet<Field> = new Set<Field>(["closesToday", "isFixture"]);

/** One filter value in the words the dashboard shows, never the stored code ("Collecting", not COLLECTING; "$50.00", not 5000). */
function valueText(field: Field, raw: string | number | boolean): string {
  if (YES_NO.has(field)) return raw === true || raw === "true" ? "yes" : "no";
  if (MONEY.has(field) && Number.isFinite(Number(raw))) return formatMoney(Number(raw));
  const labels: Record<string, string> | null = field === "status" ? OUTING_STATUS_LABEL : field === "cleanup" ? CLEANUP_LABEL : null;
  return labels?.[String(raw)] ?? String(raw);
}

/** A filter as a short phrase for the chips under the question box, e.g. "Closes today: yes" or "Captured at least $50.00". */
export function describeFilter(f: DashboardQuery["filters"][number]): string {
  const values = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => valueText(f.field, v)).join(", ");
  if (YES_NO.has(f.field) && (f.op === "eq" || f.op === "in")) return `${FIELD_LABEL[f.field]}: ${values}`;
  return `${FIELD_LABEL[f.field]} ${OP_LABEL[f.op]} ${values}`;
}
