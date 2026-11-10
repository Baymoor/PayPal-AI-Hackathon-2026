/**
 * Regression: the merchant assistant's chat was wiped about once a minute.
 *
 * The AG Studio instance was keyed on a hash of every booking row, and each row carries fields that
 * change with the clock alone (minutes to the deadline). The dashboard re-fetches its rows every 30 s,
 * so the key changed, React rebuilt Studio, and the assistant's in-memory conversation was gone.
 * These tests pin the rule: a refresh may change the rows, never the instance key. Pure unit tests.
 */
import { describe, expect, it } from "vitest";
import { makeFixtureBookings } from "@/components/merchant/__fixtures__/bookings";
import { studioInstanceKey, studioRowsSignature } from "@/components/merchant/studioInstance";
import type { MerchantBookingRow } from "@/lib/contracts/views";

const NOW = Date.parse("2027-01-14T20:00:00Z");
const base = { segment: "FIXTURE", appliedQueryId: 0, currency: "USD" };

/** What the server sends one minute later when no booking changed: only the countdown moved. */
function oneMinuteLater(rows: MerchantBookingRow[]): MerchantBookingRow[] {
  return rows.map((r) => ({ ...r, closesInMinutes: r.closesInMinutes === null ? null : r.closesInMinutes - 1 }));
}

describe("studioInstanceKey", () => {
  it("stays the same when a refresh only moves the countdowns", () => {
    const first = makeFixtureBookings(NOW);
    const second = oneMinuteLater(first);
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first)); // the rows really did change
    expect(studioInstanceKey({ ...base, rows: second })).toBe(studioInstanceKey({ ...base, rows: first }));
  });

  it("stays the same when bookings change, appear or disappear", () => {
    const first = makeFixtureBookings(NOW);
    const changed = first.map((r, i) => (i === 0 ? { ...r, status: "CONFIRMED" as const, capturedTotalMinor: 10_000, updatedAt: new Date(NOW).toISOString() } : r));
    const key = studioInstanceKey({ ...base, rows: first });
    expect(studioInstanceKey({ ...base, rows: changed })).toBe(key);
    expect(studioInstanceKey({ ...base, rows: first.slice(1) })).toBe(key);
    expect(studioInstanceKey({ ...base, rows: [...first].reverse() })).toBe(key);
  });

  it("changes only for what Studio reads once at creation or the merchant switches on purpose", () => {
    const rows = makeFixtureBookings(NOW);
    const key = studioInstanceKey({ ...base, rows });
    expect(studioInstanceKey({ ...base, rows, segment: "SANDBOX" })).not.toBe(key);
    expect(studioInstanceKey({ ...base, rows, appliedQueryId: 1 })).not.toBe(key);
    expect(studioInstanceKey({ ...base, rows, currency: "EUR" })).not.toBe(key);
    expect(studioInstanceKey({ ...base, rows: rows.map((r) => ({ ...r, merchantTimezone: "America/Los_Angeles" })) })).not.toBe(key);
  });
});

describe("studioRowsSignature", () => {
  it("ignores fields that change with the clock alone, so an uneventful refresh leaves Studio untouched", () => {
    const first = makeFixtureBookings(NOW);
    expect(studioRowsSignature(oneMinuteLater(first))).toBe(studioRowsSignature(first));
  });

  it("changes when something the dashboard shows changes", () => {
    const first = makeFixtureBookings(NOW);
    const signature = studioRowsSignature(first);
    const edit = (patch: Partial<MerchantBookingRow>) => studioRowsSignature(first.map((r, i) => (i === 0 ? { ...r, ...patch } : r)));
    expect(edit({ status: "CANCELLED" })).not.toBe(signature);
    expect(edit({ payersAuthorized: first[0].payersAuthorized + 1 })).not.toBe(signature);
    expect(edit({ authorizedTotalMinor: first[0].authorizedTotalMinor + 2000 })).not.toBe(signature);
    expect(edit({ closesToday: !first[0].closesToday })).not.toBe(signature);
    expect(edit({ isFixture: !first[0].isFixture })).not.toBe(signature);
    expect(studioRowsSignature(first.slice(1))).not.toBe(signature);
  });
});
