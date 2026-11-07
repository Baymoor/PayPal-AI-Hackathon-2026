/**
 * The error copy layer: only the cases where a wrong mapping would mislead people about what happened or
 * about their money. Copy wording itself is not asserted (it is meant to be tuned freely).
 */
import { describe, expect, it } from "vitest";
import { describeError, describeErrorFacts } from "@/components/errors/friendlyError";
import { describeWait } from "@/components/errors/errorCopy";
import { CONSERVATIVE_MONEY_NOTE, moneyContextForAction } from "@/components/errors/moneyNote";
import { ApiError } from "@/components/outing/api";

describe("describeError", () => {
  it("keeps the server's message for codes without copy, so specifics are never lost", () => {
    const e = describeError(new ApiError("SOMETHING_NEW", 409, "The venue closes at 23:00"), "select");
    expect(e.code).toBe("SOMETHING_NEW");
    expect(e.explanation).toBe("The venue closes at 23:00");
  });

  it("never shows developer validation text", () => {
    const zodText = "organizerName: Invalid input: expected string, received number";
    const e = describeError(new ApiError("INVALID_INPUT", 400, zodText), "create");
    expect(e.explanation).not.toContain("organizerName");
  });

  it("does not echo the useless 'Request failed (502)' of a response without a JSON body", () => {
    const e = describeError(new ApiError("HTTP_502", 502, "Request failed (502)"), "vote");
    expect(e.explanation).not.toContain("Request failed");
  });

  it("tells people how long to wait when the server sent Retry-After", () => {
    const e = describeError(new ApiError("TEMPORARILY_UNAVAILABLE", 503, "down", 30), "vote");
    expect(e.nextStep).toContain("30 seconds");
  });

  it("treats non-API failures (client bugs) as UNKNOWN", () => {
    expect(describeError(new TypeError("x is undefined")).code).toBe("UNKNOWN");
  });

  it("says a dropped write has an unknown outcome, but a dropped read does not", () => {
    const write = describeError(new ApiError("NETWORK", 0, ""), "withdraw");
    const read = describeError(new ApiError("NETWORK_READ", 0, ""));
    expect(write.explanation).toMatch(/can't tell whether/);
    expect(read.explanation).not.toMatch(/can't tell whether/);
  });
});

describe("money notes", () => {
  it("falls back to the conservative note for unclassified actions", () => {
    expect(describeErrorFacts({ code: "INTERNAL" }, "something-new").moneyNote).toBe(CONSERVATIVE_MONEY_NOTE);
  });

  it("lets a code hide the note or state its own money fact", () => {
    expect(describeErrorFacts({ code: "UNAUTHORIZED" }, "vote").moneyNote).toBeUndefined();
    expect(describeErrorFacts({ code: "ALREADY_AUTHORIZED" }, "authorize").moneyNote).toBe("No second hold was created.");
  });

  it("never says 'nothing was charged' for demo actions, which can move simulated money", () => {
    expect(describeErrorFacts({ code: "INTERNAL" }, "tick").moneyNote).not.toBe(CONSERVATIVE_MONEY_NOTE);
  });

  it("classifies prefixed action keys by their prefix", () => {
    expect(moneyContextForAction("scenario:holdout")).toBe("demo");
    expect(moneyContextForAction("persona:123")).toBe("demo");
    expect(moneyContextForAction(undefined)).toBe("unknown");
  });
});

describe("describeWait", () => {
  it("rounds up and never suggests retrying sooner than asked", () => {
    expect(describeWait(30)).toBe("30 seconds");
    expect(describeWait(61)).toBe("2 minutes");
    expect(describeWait(undefined)).toBe("a minute");
  });
});
