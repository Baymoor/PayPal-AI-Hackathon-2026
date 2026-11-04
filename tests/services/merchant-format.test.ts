/** Merchant dashboard display helpers prefer the row's merchantTimezone over the env fallback. Pure unit tests. */
import { describe, expect, it } from "vitest";
import { dayKey, formatInstant, MERCHANT_TIMEZONE, merchantTz } from "@/components/merchant/format";
import { makeFixtureBookings, makeFixtureDetail } from "@/components/merchant/__fixtures__/bookings";

describe("merchantTz", () => {
  it("uses the row's own merchant time zone", () => {
    expect(merchantTz({ merchantTimezone: "America/Los_Angeles" })).toBe("America/Los_Angeles");
    expect(merchantTz({ merchantTimezone: " Asia/Tokyo " })).toBe("Asia/Tokyo");
  });

  it("falls back to NEXT_PUBLIC_MERCHANT_TIMEZONE / Europe/Copenhagen when missing or invalid", () => {
    expect(MERCHANT_TIMEZONE).toBe(process.env.NEXT_PUBLIC_MERCHANT_TIMEZONE || "Europe/Copenhagen");
    for (const row of [undefined, null, {}, { merchantTimezone: null }, { merchantTimezone: "" }, { merchantTimezone: "Not/AZone" }]) {
      expect(merchantTz(row)).toBe(MERCHANT_TIMEZONE);
    }
  });

  it("formats instants and calendar days in the merchant's zone", () => {
    const iso = "2027-01-15T07:00:00Z"; // 08:00 Jan 15 in Copenhagen, 23:00 Jan 14 in Los Angeles
    expect(formatInstant(iso, merchantTz({ merchantTimezone: "America/Los_Angeles" }))).toMatch(/^Thu, Jan 14, 11:00\sPM PST$/);
    expect(formatInstant(iso, merchantTz({ merchantTimezone: "Europe/Copenhagen" }))).toMatch(/^Fri, Jan 15, 8:00\sAM /);
    expect(dayKey(new Date(iso), "America/Los_Angeles")).toBe("2027-01-14");
    expect(dayKey(new Date(iso), "Europe/Copenhagen")).toBe("2027-01-15");
  });
});

describe("merchant dashboard fixtures", () => {
  it("every fixture row (and its detail) carries a valid merchantTimezone", () => {
    const rows = makeFixtureBookings(Date.parse("2027-01-14T20:00:00Z"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.merchantTimezone).toBe(MERCHANT_TIMEZONE);
      expect(merchantTz(r)).toBe(r.merchantTimezone);
    }
    expect(makeFixtureDetail(rows[0]).booking.merchantTimezone).toBe(MERCHANT_TIMEZONE);
  });
});
