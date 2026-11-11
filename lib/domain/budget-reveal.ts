/**
 * When the organizer may reveal budget poker.
 *
 * Owner rule (11 Nov 2026): the reveal waits until 75% of the party has voted, so the spread reflects
 * most of the group, but one person who never votes cannot block the outing. The privacy floor of
 * MIN_VOTES_FOR_REVEAL still applies on top, so no single vote can ever be singled out.
 *
 * "Party" is everyone invited who has not declined: the same number as the "4 of 6 voted" counter.
 */
import { MIN_VOTES_FOR_REVEAL } from "./types";

/** The share of the party that must vote, as a fraction: 3 of every 4 people. */
const QUORUM_NUMERATOR = 3;
const QUORUM_DENOMINATOR = 4;

export class InvalidPartySizeError extends RangeError {
  constructor(partySize: number) {
    super(`Party size must be a whole number of people, got ${partySize}`);
    this.name = "InvalidPartySizeError";
  }
}

/** Votes needed before the reveal unlocks: 75% of the party rounded up, and never fewer than the privacy floor. */
export function votesNeededToReveal(partySize: number): number {
  if (!Number.isInteger(partySize) || partySize < 0) throw new InvalidPartySizeError(partySize);
  // Integer ceiling of 3n/4, so the threshold never depends on floating-point rounding.
  const quorum = Math.floor((partySize * QUORUM_NUMERATOR + QUORUM_DENOMINATOR - 1) / QUORUM_DENOMINATOR);
  return Math.max(MIN_VOTES_FOR_REVEAL, quorum);
}

/** True when enough of the party has voted for the organizer to reveal the spread. */
export function canRevealVotes(voteCount: number, partySize: number): boolean {
  return voteCount >= votesNeededToReveal(partySize);
}
