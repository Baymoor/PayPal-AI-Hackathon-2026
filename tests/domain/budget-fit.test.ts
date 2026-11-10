import { describe, expect, it } from "vitest";
import {
  InvalidHeadcountError,
  bookingTotalMinor,
  budgetFit,
  comparableCostMinor,
  headcountOf,
  perPersonShareMinor,
  type PricedBooking,
} from "@/lib/domain/budget-fit";
import { equalSplit } from "@/lib/domain/money";

const room: PricedBooking = { pricingModel: "FIXED_TOTAL", priceMinor: 10_000 };
const seat: PricedBooking = { pricingModel: "PER_ATTENDEE", priceMinor: 1_400 };

describe("headcountOf", () => {
  it("counts a covered guest as coming but not paying", () => {
    expect(headcountOf(6, 0)).toEqual({ attendees: 6, payers: 6 });
    expect(headcountOf(6, 1)).toEqual({ attendees: 6, payers: 5 });
  });

  it("always leaves at least one payer", () => {
    expect(headcountOf(1, 1)).toEqual({ attendees: 1, payers: 1 });
  });

  it.each([
    ["nobody attending", 0, 0],
    ["a fractional group", 2.5, 0],
    ["a negative covered count", 4, -1],
  ])("rejects %s", (_label, attendees, covered) => {
    expect(() => headcountOf(attendees, covered)).toThrow(InvalidHeadcountError);
  });
});

describe("bookingTotalMinor", () => {
  it("keeps a fixed total whoever comes, and multiplies a per-attendee price by the people coming", () => {
    expect(bookingTotalMinor(room, 2)).toBe(10_000);
    expect(bookingTotalMinor(room, 10)).toBe(10_000);
    expect(bookingTotalMinor(seat, 6)).toBe(8_400);
  });
});

describe("perPersonShareMinor", () => {
  it("divides a fixed total by the people paying, so a covered guest raises everyone else's share", () => {
    expect(perPersonShareMinor(room, headcountOf(6, 0))).toBe(1_667); // $100 / 6, rounded up
    expect(perPersonShareMinor(room, headcountOf(6, 1))).toBe(2_000); // $100 / 5
  });

  it("is the seat price for a per-attendee offering until someone is covered", () => {
    expect(perPersonShareMinor(seat, headcountOf(6, 0))).toBe(1_400);
    expect(perPersonShareMinor(seat, headcountOf(6, 1))).toBe(1_680); // $84 / 5
  });

  it("is the largest share the real equal split would give anyone", () => {
    for (const total of [10_000, 9_999, 12_001, 1]) {
      for (let payers = 1; payers <= 12; payers++) {
        const keys = Array.from({ length: payers }, (_, i) => `p${i}`);
        const largest = Math.max(...equalSplit(total, keys).map((a) => a.amountMinor));
        const share = perPersonShareMinor({ pricingModel: "FIXED_TOTAL", priceMinor: total }, { attendees: payers, payers });
        expect(share, `${total} / ${payers}`).toBe(largest);
      }
    }
  });

  it.each([
    ["no payers", { attendees: 3, payers: 0 }],
    ["more payers than attendees", { attendees: 3, payers: 4 }],
    ["a fractional payer count", { attendees: 3, payers: 1.5 }],
  ])("rejects %s", (_label, headcount) => {
    expect(() => perPersonShareMinor(room, headcount)).toThrow(InvalidHeadcountError);
  });
});

describe("comparableCostMinor", () => {
  it("is a share against a per-person budget and the booking total against a total budget", () => {
    const headcount = headcountOf(6, 1);
    expect(comparableCostMinor(room, headcount, "PER_PERSON")).toBe(2_000);
    expect(comparableCostMinor(room, headcount, "TOTAL")).toBe(10_000);
    expect(comparableCostMinor(seat, headcount, "TOTAL")).toBe(8_400);
  });
});

describe("budgetFit", () => {
  it("is within the budget at or under the agreed amount", () => {
    expect(budgetFit(2_000, 2_000)).toEqual({ kind: "WITHIN", costMinor: 2_000, budgetMinor: 2_000, overByMinor: 0 });
    expect(budgetFit(1_667, 2_000).kind).toBe("WITHIN");
  });

  it("says by how much a cost is over", () => {
    expect(budgetFit(2_500, 2_000)).toEqual({ kind: "OVER", costMinor: 2_500, budgetMinor: 2_000, overByMinor: 500 });
    expect(budgetFit(2_001, 2_000).overByMinor).toBe(1);
  });
});
