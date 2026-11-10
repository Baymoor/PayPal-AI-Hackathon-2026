import type { MerchantBookingRow } from "@/lib/contracts/views";
import { merchantTz } from "./format";
import { toStudioRow } from "./studioData";

export interface StudioInstanceInput {
  /** Data source the merchant is looking at (sandbox, fixture or both). */
  segment: string;
  /** Id of the applied "Filter dashboard" query (0 = none). A query can change the grid's initial sort. */
  appliedQueryId: number;
  currency: string;
  /** The rows Studio shows. Only their time zone is read: it is baked into the date format at creation. */
  rows: readonly Pick<MerchantBookingRow, "merchantTimezone">[];
}

/**
 * React key of the AG Studio instance.
 *
 * A new key destroys the whole Studio instance and builds a fresh one. That also throws away the
 * assistant's conversation, which lives in memory inside the instance. So the key may only contain
 * what Studio reads once at creation (initial sort, currency and date formats) or what the merchant
 * deliberately switches (the data source).
 *
 * It must NOT depend on the row values. The bookings are re-fetched every 30 seconds and every row
 * carries time-derived fields (minutes to the deadline, last update), so a key built from the rows
 * changes about once a minute and resets the chat in the middle of an answer. Fresh rows reach the
 * running instance through its `data` prop instead, which Studio updates in place.
 */
export function studioInstanceKey({ segment, appliedQueryId, currency, rows }: StudioInstanceInput): string {
  return [segment, appliedQueryId, currency, merchantTz(rows[0])].join("|");
}

/**
 * Everything Studio shows about these rows, as one string: two row sets with the same signature draw
 * the same dashboard. Used to leave Studio alone when a refresh brought nothing new.
 *
 * The clock is pinned on purpose. The signature has to change with the bookings, not with the time
 * of day (the "closes in" countdowns tick inside their own widget).
 */
export function studioRowsSignature(rows: readonly MerchantBookingRow[]): string {
  return JSON.stringify(rows.map((r) => toStudioRow(r, 0)));
}
