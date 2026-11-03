import { describe, expect, it } from "vitest";
import {
  equalSplit,
  estimatedShare,
  formatMoney,
  minorToDecimalString,
  MoneyError,
  parseMajorToMinor,
  perPayerCap,
} from "@/lib/domain/money";

const sum = (xs: { amountMinor: number }[]) => xs.reduce((a, x) => a + x.amountMinor, 0);

describe("equalSplit (brief §2 examples)", () => {
  it("$100 / 5 payers = $20 each", () => {
    const s = equalSplit(10_000, ["a", "b", "c", "d", "e"]);
    expect(s.map((x) => x.amountMinor)).toEqual([2000, 2000, 2000, 2000, 2000]);
  });

  it("$100 / 10 payers = $10 each", () => {
    const s = equalSplit(10_000, Array.from({ length: 10 }, (_, i) => `p${i}`));
    expect(new Set(s.map((x) => x.amountMinor))).toEqual(new Set([1000]));
    expect(sum(s)).toBe(10_000);
  });

  it("$100 / 3 payers = $33.34, $33.33, $33.33 in stable order", () => {
    const s = equalSplit(10_000, ["first", "second", "third"]);
    expect(s).toEqual([
      { key: "first", amountMinor: 3334 },
      { key: "second", amountMinor: 3333 },
      { key: "third", amountMinor: 3333 },
    ]);
  });

  it("always sums exactly to the total and differs by at most one cent", () => {
    for (let total = 1; total <= 2_000; total += 37) {
      for (let n = 1; n <= 12; n++) {
        const keys = Array.from({ length: n }, (_, i) => `k${i}`);
        if (total < 1) continue;
        const s = equalSplit(total, keys);
        expect(sum(s)).toBe(total);
        const amounts = s.map((x) => x.amountMinor);
        expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
        // Extra cents go to the FIRST payers in order.
        for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeLessThanOrEqual(amounts[i - 1]);
      }
    }
  });

  it("is deterministic for the same ordering", () => {
    const keys = ["x", "y", "z"];
    expect(equalSplit(101, keys)).toEqual(equalSplit(101, keys));
  });

  it("rejects zero payers, duplicates and invalid money", () => {
    expect(() => equalSplit(10_000, [])).toThrow(MoneyError);
    expect(() => equalSplit(10_000, ["a", "a"])).toThrow(MoneyError);
    expect(() => equalSplit(0, ["a"])).toThrow(MoneyError);
    expect(() => equalSplit(-5, ["a"])).toThrow(MoneyError);
    expect(() => equalSplit(10.5, ["a"])).toThrow(MoneyError);
    expect(() => equalSplit(Number.NaN, ["a"])).toThrow(MoneyError);
  });
});

describe("caps and estimates", () => {
  it("$100 with min 5 payers -> $20 cap", () => {
    expect(perPayerCap(10_000, 5)).toBe(2000);
  });
  it("cap is ceil so the largest penny share never exceeds it", () => {
    expect(perPayerCap(10_000, 3)).toBe(3334);
    for (let minPayers = 1; minPayers <= 10; minPayers++) {
      const cap = perPayerCap(10_001, minPayers);
      for (let n = minPayers; n <= 12; n++) {
        const s = equalSplit(10_001, Array.from({ length: n }, (_, i) => `k${i}`));
        expect(Math.max(...s.map((x) => x.amountMinor))).toBeLessThanOrEqual(cap);
      }
    }
  });
  it("estimate falls as payers join but never below total/minPayers until enough join", () => {
    expect(estimatedShare(10_000, 5, 1)).toBe(2000);
    expect(estimatedShare(10_000, 5, 5)).toBe(2000);
    expect(estimatedShare(10_000, 5, 10)).toBe(1000);
  });
});

describe("parsing and formatting without floats", () => {
  it("parses decimal strings exactly", () => {
    expect(parseMajorToMinor("20")).toBe(2000);
    expect(parseMajorToMinor("20.5")).toBe(2050);
    expect(parseMajorToMinor("0.1")).toBe(10);
    expect(parseMajorToMinor("33.33")).toBe(3333);
  });
  it("rejects malformed amounts", () => {
    for (const bad of ["", "-1", "1e3", "1.234", "$5", "1,000", "abc", "1."]) {
      expect(() => parseMajorToMinor(bad)).toThrow(MoneyError);
    }
  });
  it("formats provider decimal strings", () => {
    expect(minorToDecimalString(2000)).toBe("20.00");
    expect(minorToDecimalString(5)).toBe("0.05");
    expect(minorToDecimalString(3334)).toBe("33.34");
  });
  it("formats display money", () => {
    expect(formatMoney(2000)).toBe("$20");
    expect(formatMoney(3334)).toBe("$33.34");
    expect(formatMoney(2000, "USD", { alwaysShowCents: true })).toBe("$20.00");
    expect(formatMoney(123_456_78)).toBe("$123,456.78");
  });
});
