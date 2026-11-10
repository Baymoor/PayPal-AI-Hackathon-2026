/**
 * The chips under the merchant dashboard's question box describe each applied filter. They are read by
 * venue staff, so they use the dashboard's own words, never stored codes or cents. Pure unit tests.
 */
import { describe, expect, it } from "vitest";
import { describeFilter } from "@/components/merchant/query";

describe("describeFilter", () => {
  it("says yes or no instead of true or false", () => {
    expect(describeFilter({ field: "closesToday", op: "eq", value: true })).toBe("Closes today: yes");
    expect(describeFilter({ field: "isFixture", op: "eq", value: "false" })).toBe("Simulated (Fixture): no");
  });

  it("shows money as money, not as a count of cents", () => {
    expect(describeFilter({ field: "capturedTotalMinor", op: "gte", value: 5000 })).toBe("Captured at least $50.00");
    expect(describeFilter({ field: "authorizedTotalMinor", op: "gt", value: 0 })).toBe("Authorized holds more than $0.00");
  });

  it("uses the status names the table shows", () => {
    expect(describeFilter({ field: "status", op: "eq", value: "COLLECTING" })).toBe("Status is Collecting");
    expect(describeFilter({ field: "cleanup", op: "in", value: ["REFUND_PENDING", "VOID_PENDING"] })).toBe(
      "Recovery status is one of Refund pending, Hold release pending",
    );
  });

  it("keeps plain numbers and unknown values as they are", () => {
    expect(describeFilter({ field: "missingRequired", op: "gt", value: 0 })).toBe("Missing required more than 0");
    expect(describeFilter({ field: "closesWithinHours", op: "lte", value: 6 })).toBe("Closes within (hours) at most 6");
    expect(describeFilter({ field: "status", op: "neq", value: "SOMETHING_NEW" })).toBe("Status is not SOMETHING_NEW");
  });
});
