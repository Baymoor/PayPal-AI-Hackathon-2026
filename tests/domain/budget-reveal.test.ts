import { describe, expect, it } from "vitest";
import { InvalidPartySizeError, canRevealVotes, votesNeededToReveal } from "@/lib/domain/budget-reveal";

describe("votesNeededToReveal: 75% of the party, never below the privacy floor of 3", () => {
  it.each([
    [0, 3],
    [2, 3], // a pair can never reveal: one vote would be exposed
    [3, 3], // everyone
    [4, 3],
    [5, 4], // 3.75 rounds up
    [6, 5], // 4.5 rounds up
    [8, 6], // exactly 75%
    [10, 8],
    [11, 9], // 8.25 rounds up
  ])("party of %i needs %i votes", (party, needed) => {
    expect(votesNeededToReveal(party)).toBe(needed);
  });

  it("rejects a party size that is not a whole number of people", () => {
    expect(() => votesNeededToReveal(-1)).toThrow(InvalidPartySizeError);
    expect(() => votesNeededToReveal(2.5)).toThrow(InvalidPartySizeError);
  });

  it("canRevealVotes compares the vote count with the threshold", () => {
    expect(canRevealVotes(4, 6)).toBe(false);
    expect(canRevealVotes(5, 6)).toBe(true);
    expect(canRevealVotes(3, 3)).toBe(true);
  });
});
