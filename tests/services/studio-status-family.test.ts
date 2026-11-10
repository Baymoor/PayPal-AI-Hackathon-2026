/**
 * The dashboard's status charts are stacked over one measure per status family, in the palette's order.
 * A status bar gets the right colour only if every outing lands in exactly one family. Pure unit tests.
 */
import { describe, expect, it } from "vitest";
import { statusFamily, statusFamilyMeasures, toStudioRow } from "@/components/merchant/studioData";
import { makeFixtureBookings } from "@/components/merchant/__fixtures__/bookings";
import type { OutingStatus } from "@/lib/domain/types";

const ALL_STATUSES: OutingStatus[] = ["DRAFT", "BUDGETING", "PROPOSED", "COLLECTING", "SETTLING", "CONFIRMED", "CANCELLING", "COMPENSATING", "CANCELLED"];
const COUNT_KEYS = ["countConfirmed", "countRecovering", "countCollecting", "countCancelled"] as const;
const HOLD_KEYS = ["holdConfirmed", "holdRecovering", "holdCollecting", "holdCancelled"] as const;

describe("statusFamily", () => {
  it("maps each status to its colour family", () => {
    expect(statusFamily("CONFIRMED")).toBe("confirmed");
    expect(statusFamily("COMPENSATING")).toBe("recovering");
    expect(statusFamily("CANCELLING")).toBe("cancelled");
    expect(statusFamily("CANCELLED")).toBe("cancelled");
    expect(statusFamily("COLLECTING")).toBe("collecting");
    expect(statusFamily("SETTLING")).toBe("collecting");
  });
});

describe("statusFamilyMeasures", () => {
  it("counts every outing once, in exactly one family", () => {
    for (const status of ALL_STATUSES) {
      const measures = statusFamilyMeasures(status, 80);
      const counts = COUNT_KEYS.map((k) => measures[k]);
      expect(counts.filter((c) => c === 1)).toHaveLength(1);
      expect(counts.filter((c) => c === null)).toHaveLength(3);
    }
  });

  it("puts the outing's holds in the same family as its count, and nowhere else", () => {
    const measures = statusFamilyMeasures("COLLECTING", 80);
    expect(measures.countCollecting).toBe(1);
    expect(measures.holdCollecting).toBe(80);
    expect(HOLD_KEYS.filter((k) => k !== "holdCollecting").map((k) => measures[k])).toEqual([null, null, null]);
  });

  it("uses null, not 0, for the other families: a zero segment would print a stray 0 on the bar", () => {
    const measures = statusFamilyMeasures("CONFIRMED", 0);
    expect(measures.holdConfirmed).toBe(0);
    expect(measures.countCancelled).toBeNull();
  });
});

describe("toStudioRow", () => {
  it("keeps the family totals equal to the plain totals", () => {
    const rows = makeFixtureBookings(Date.parse("2027-01-14T20:00:00Z")).map((r) => toStudioRow(r));
    const sum = (values: (number | null)[]) => values.reduce<number>((total, v) => total + (v ?? 0), 0);
    expect(sum(rows.flatMap((r) => COUNT_KEYS.map((k) => r[k])))).toBe(rows.length);
    expect(sum(rows.flatMap((r) => HOLD_KEYS.map((k) => r[k])))).toBeCloseTo(sum(rows.map((r) => r.authorized)), 6);
  });
});
