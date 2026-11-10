import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_OPTIONS_MINOR,
  LEGACY_TOTAL_OPTIONS_MINOR,
  MAX_BUDGET_MINOR,
  categoryMedianMinor,
  chooseBudgetOptions,
  expectedPayers,
  fallbackLadder,
  perPersonCostMinor,
  statedPerPersonMinor,
  validateBudgetOptions,
  type BudgetOptionsInput,
  type PricedOffering,
} from "@/lib/domain/budget-options";

const catalogue: PricedOffering[] = [
  { category: "karaoke", pricingModel: "FIXED_TOTAL", priceMinor: 10_000 },
  { category: "karaoke", pricingModel: "FIXED_TOTAL", priceMinor: 18_000 },
  { category: "wine-tasting", pricingModel: "FIXED_TOTAL", priceMinor: 24_000 },
  { category: "pottery", pricingModel: "PER_ATTENDEE", priceMinor: 2_500 },
];

const input = (over: Partial<BudgetOptionsInput> = {}): BudgetOptionsInput => ({
  suggestionMinor: null,
  stated: { amountMinor: null, unit: "UNKNOWN" },
  groupSize: null,
  coversGuest: false,
  categories: [],
  catalogue,
  ...over,
});

/** What a model would return if it answered with whole-group totals instead of per-person amounts. */
const GROUP_TOTALS = [5_000, 7_500, 10_000, 15_000, 20_000];

describe("validateBudgetOptions", () => {
  it("accepts five whole-dollar, strictly increasing amounts within the spread", () => {
    expect(validateBudgetOptions([1_000, 1_500, 2_000, 3_000, 4_000])).toEqual({ ok: true, optionsMinor: [1_000, 1_500, 2_000, 3_000, 4_000] });
    expect(validateBudgetOptions([100, 200, 300, 400, 500]).ok).toBe(true);
  });

  it("still accepts the total amounts stored on outings created before per-person voting", () => {
    expect(validateBudgetOptions([...LEGACY_TOTAL_OPTIONS_MINOR]).ok).toBe(true);
  });

  it.each([
    ["four amounts", [1_000, 1_500, 2_000, 3_000]],
    ["six amounts", [1_000, 1_500, 2_000, 3_000, 4_000, 5_000]],
    ["not an array", "1000,1500"],
    ["a float", [1_000, 1_500, 2_000.5, 3_000, 4_000]],
    ["not a whole dollar", [1_000, 1_550, 2_000, 3_000, 4_000]],
    ["not increasing", [1_000, 1_500, 1_500, 3_000, 4_000]],
    ["descending", [4_000, 3_000, 2_000, 1_500, 1_000]],
    ["below $1", [0, 100, 200, 300, 400]],
    ["above the maximum", [MAX_BUDGET_MINOR - 400, MAX_BUDGET_MINOR - 300, MAX_BUDGET_MINOR - 200, MAX_BUDGET_MINOR - 100, MAX_BUDGET_MINOR + 100]],
    ["spread above 10x", [100, 200, 500, 800, 1_100]],
  ])("rejects %s", (_label, values) => {
    expect(validateBudgetOptions(values).ok).toBe(false);
  });
});

describe("fallbackLadder", () => {
  it("gives $10, $15, $20, $30, $40 for the default $20 anchor", () => {
    expect(fallbackLadder(2_000)).toEqual([...DEFAULT_BUDGET_OPTIONS_MINOR]);
    expect(DEFAULT_BUDGET_OPTIONS_MINOR).toEqual([1_000, 1_500, 2_000, 3_000, 4_000]);
  });

  it("rounds each rung to the nearest whole dollar (half up) with integer maths, keeping the anchor in the middle", () => {
    // $15: 7.50 -> 8, 11.25 -> 11, 15, 22.50 -> 23, 30
    expect(fallbackLadder(1_500)).toEqual([800, 1_100, 1_500, 2_300, 3_000]);
    // $18: 9, 13.50 -> 14, 18, 27, 36
    expect(fallbackLadder(1_800)).toEqual([900, 1_400, 1_800, 2_700, 3_600]);
    // $16.67: 8.335 -> 8, 12.5025 -> 13, 16.67 -> 17, 25.005 -> 25, 33.34 -> 33
    expect(fallbackLadder(1_667)).toEqual([800, 1_300, 1_700, 2_500, 3_300]);
  });

  it("stays strictly increasing and at least $1 for tiny anchors", () => {
    expect(fallbackLadder(0)).toEqual([100, 200, 300, 400, 500]);
    expect(fallbackLadder(150)).toEqual([100, 200, 300, 400, 500]);
  });

  it("caps huge anchors so the top rung stays within the maximum", () => {
    const ladder = fallbackLadder(MAX_BUDGET_MINOR);
    expect(ladder[4]).toBe(MAX_BUDGET_MINOR);
    expect(validateBudgetOptions(ladder).ok).toBe(true);
  });

  it("always produces a valid set", () => {
    for (let anchor = 0; anchor <= 400_000; anchor += 137) expect(validateBudgetOptions(fallbackLadder(anchor)).ok, `anchor ${anchor}`).toBe(true);
  });
});

describe("expectedPayers", () => {
  it("is everyone the brief counts, minus a covered guest, and never below one", () => {
    expect(expectedPayers(6, false)).toBe(6);
    expect(expectedPayers(6, true)).toBe(5);
    expect(expectedPayers(1, true)).toBe(1);
    expect(expectedPayers(null, true)).toBeNull();
  });
});

describe("statedPerPersonMinor", () => {
  it("takes a per-person amount as stated", () => {
    expect(statedPerPersonMinor({ amountMinor: 5_000, unit: "PER_PERSON" }, null)).toBe(5_000);
  });

  it("divides a stated total by the people paying, rounding up", () => {
    expect(statedPerPersonMinor({ amountMinor: 10_000, unit: "TOTAL" }, 5)).toBe(2_000);
    expect(statedPerPersonMinor({ amountMinor: 10_000, unit: "TOTAL" }, 6)).toBe(1_667);
  });

  it("is unknown for a total without a group size, an unclear unit or no amount", () => {
    expect(statedPerPersonMinor({ amountMinor: 10_000, unit: "TOTAL" }, null)).toBeNull();
    expect(statedPerPersonMinor({ amountMinor: 10_000, unit: "UNKNOWN" }, 5)).toBeNull();
    expect(statedPerPersonMinor({ amountMinor: null, unit: "UNKNOWN" }, 5)).toBeNull();
  });
});

describe("perPersonCostMinor", () => {
  const [room, , , pottery] = catalogue;

  it("needs the people paying to turn a fixed total into a share", () => {
    expect(perPersonCostMinor(room, 6, 5)).toBe(2_000);
    expect(perPersonCostMinor(room, null, null)).toBeNull();
  });

  it("is the per-attendee price itself, raised only when a guest is covered", () => {
    expect(perPersonCostMinor(pottery, null, null)).toBe(2_500);
    expect(perPersonCostMinor(pottery, 8, 8)).toBe(2_500);
    expect(perPersonCostMinor(pottery, 6, 5)).toBe(3_000); // $150 / 5
  });
});

describe("categoryMedianMinor", () => {
  it("uses the lower median of per-person shares in the brief's categories", () => {
    expect(categoryMedianMinor(catalogue, ["karaoke"], 6, 5)).toBe(2_000); // $100 and $180 over 5 payers: $20, $36
    expect(categoryMedianMinor(catalogue, ["Karaoke"], 6, 6)).toBe(1_667);
  });

  it("skips fixed totals when the group size is unknown, and unknown categories", () => {
    expect(categoryMedianMinor(catalogue, ["wine-tasting"], null, null)).toBeNull();
    expect(categoryMedianMinor(catalogue, ["pottery"], null, null)).toBe(2_500);
    expect(categoryMedianMinor(catalogue, ["padel"], 4, 4)).toBeNull();
  });
});

describe("chooseBudgetOptions", () => {
  it("uses a valid AI suggestion that includes the brief's per-person equivalent", () => {
    const d = chooseBudgetOptions(
      input({ suggestionMinor: [1_000, 1_500, 2_000, 2_500, 3_000], stated: { amountMinor: 10_000, unit: "TOTAL" }, groupSize: 6, coversGuest: true }),
    );
    expect(d).toMatchObject({ basis: "AI_SUGGESTION", optionsMinor: [1_000, 1_500, 2_000, 2_500, 3_000], statedPerPersonMinor: 2_000, anchorMinor: null, notes: [] });
  });

  it("drops an invalid AI suggestion with a note and falls back to the ladder", () => {
    const d = chooseBudgetOptions(input({ suggestionMinor: [150, 250, 350, 450, 550], stated: { amountMinor: 9_000, unit: "TOTAL" }, groupSize: 5 }));
    expect(d.basis).toBe("BRIEF_TOTAL");
    expect(d.optionsMinor).toEqual([900, 1_400, 1_800, 2_700, 3_600]);
    expect(d.notes[0]).toMatch(/not used: every amount must be a whole dollar amount/);
  });

  it("drops a suggestion of whole-group totals: it leaves out what the brief means per person", () => {
    const d = chooseBudgetOptions(input({ suggestionMinor: GROUP_TOTALS, stated: { amountMinor: 10_000, unit: "TOTAL" }, groupSize: 6, coversGuest: true }));
    expect(d).toMatchObject({ basis: "BRIEF_TOTAL", anchorMinor: 2_000, optionsMinor: [1_000, 1_500, 2_000, 3_000, 4_000] });
    expect(d.notes[0]).toMatch(/do not include the budget stated/);
  });

  it("drops a suggestion that leaves out what the matching venues cost per person", () => {
    const d = chooseBudgetOptions(input({ suggestionMinor: GROUP_TOTALS, categories: ["karaoke"], groupSize: 6 }));
    expect(d).toMatchObject({ basis: "CATEGORY_MEDIAN", anchorMinor: 1_667, optionsMinor: [800, 1_300, 1_700, 2_500, 3_300] });
    expect(d.notes[0]).toMatch(/do not include what matching venues cost per person/);
  });

  it("cannot judge a suggestion when nothing anchors it, so a valid one is used", () => {
    expect(chooseBudgetOptions(input({ suggestionMinor: GROUP_TOTALS }))).toMatchObject({ basis: "AI_SUGGESTION", notes: [] });
  });

  it("anchors on a per-person amount exactly as the brief states it", () => {
    const d = chooseBudgetOptions(input({ stated: { amountMinor: 5_000, unit: "PER_PERSON" }, groupSize: 6 }));
    expect(d).toMatchObject({ basis: "BRIEF_PER_PERSON", anchorMinor: 5_000, statedPerPersonMinor: 5_000, optionsMinor: [2_500, 3_800, 5_000, 7_500, 10_000] });
  });

  it("anchors on a stated total divided by the people paying", () => {
    const covered = chooseBudgetOptions(input({ stated: { amountMinor: 10_000, unit: "TOTAL" }, groupSize: 6, coversGuest: true }));
    expect(covered).toMatchObject({ basis: "BRIEF_TOTAL", anchorMinor: 2_000, optionsMinor: [...DEFAULT_BUDGET_OPTIONS_MINOR] });
    const everyonePays = chooseBudgetOptions(input({ stated: { amountMinor: 12_000, unit: "TOTAL" }, groupSize: 8 }));
    expect(everyonePays).toMatchObject({ basis: "BRIEF_TOTAL", anchorMinor: 1_500, optionsMinor: [800, 1_100, 1_500, 2_300, 3_000] });
  });

  it("falls back to the category median, then to the $20 default", () => {
    // A total without a group size says nothing per person, so the catalogue decides.
    expect(chooseBudgetOptions(input({ stated: { amountMinor: 30_000, unit: "TOTAL" }, categories: ["pottery"] }))).toMatchObject({
      basis: "CATEGORY_MEDIAN",
      anchorMinor: 2_500,
      statedPerPersonMinor: null,
      optionsMinor: [1_300, 1_900, 2_500, 3_800, 5_000],
    });
    expect(chooseBudgetOptions(input({ stated: { amountMinor: 9_000, unit: "UNKNOWN" } }))).toMatchObject({
      basis: "DEFAULT",
      optionsMinor: [...DEFAULT_BUDGET_OPTIONS_MINOR],
    });
  });
});
