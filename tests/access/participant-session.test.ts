/**
 * The participant cookie keeps at most MAX_OUTINGS_PER_SESSION outings and evicts the least recently
 * used one. Found in the 12 Nov audit: re-setting a key kept its first position, so a judge's real outing
 * was evicted by later /demo stories even while they kept opening it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_OUTINGS_PER_SESSION, participantCookie, withOuting, type ParticipantSession } from "@/lib/auth/session";

const empty = (): ParticipantSession => ({ v: 1, outings: {} });

describe("withOuting: least recently used eviction", () => {
  it("keeps an outing that is opened again, and evicts the one untouched the longest", () => {
    const real = randomUUID();
    let s = withOuting(empty(), real, randomUUID());
    const demos: string[] = [];
    for (let i = 0; i < MAX_OUTINGS_PER_SESSION - 1; i++) {
      const id = randomUUID();
      demos.push(id);
      s = withOuting(s, id, randomUUID());
    }
    // Opening the real outing again moves it to the back of the queue.
    s = withOuting(s, real, s.outings[real]!);
    s = withOuting(s, randomUUID(), randomUUID());

    expect(Object.keys(s.outings)).toHaveLength(MAX_OUTINGS_PER_SESSION);
    expect(s.outings[real]).toBeDefined();
    expect(s.outings[demos[0]!]).toBeUndefined(); // the oldest untouched story went first
  });

  it("updates the participant for an outing already in the session (persona switch)", () => {
    const outing = randomUUID();
    const s = withOuting(withOuting(empty(), outing, "p-ben"), outing, "p-noor");
    expect(s.outings).toEqual({ [outing]: "p-noor" });
  });

  it("a full session still fits in one browser cookie", () => {
    let s = empty();
    for (let i = 0; i < MAX_OUTINGS_PER_SESSION + 5; i++) s = withOuting(s, randomUUID(), randomUUID());
    expect(participantCookie(s).length).toBeLessThan(4096);
  });
});
