import { describe, expect, it } from "vitest";
import {
  buildCommitmentTerms,
  decideSettlement,
  hashTerms,
  isInfeasible,
  PolicyError,
  validateCommitmentDeadline,
  type RosterAuthorization,
  type RosterConsent,
  type RosterParticipant,
  type SettlementInput,
} from "@/lib/domain/policy";
import { assertOutingTransition, canTransitionOuting, canTransitionPayment } from "@/lib/domain/state-machine";

const H = 60 * 60 * 1000;
const DEADLINE = new Date("2026-11-06T17:00:00Z");
const AFTER = new Date(DEADLINE.getTime() + 5 * 60 * 1000);
const BEFORE = new Date(DEADLINE.getTime() - H);

function baseTerms(overrides: Partial<Parameters<typeof buildCommitmentTerms>[0]> = {}) {
  return buildCommitmentTerms({
    outingId: "outing-1",
    quoteId: "quote-1",
    quoteVersion: 1,
    merchantId: "m-1",
    merchantName: "The Sound Room",
    offeringId: "off-1",
    offeringName: "Private karaoke room",
    pricingModel: "FIXED_TOTAL",
    totalMinor: 10_000,
    currency: "USD",
    capacity: 10,
    minPayers: 5,
    activityAt: "2026-11-07T18:00:00.000Z",
    deadlineAt: DEADLINE.toISOString(),
    policy: "ALL_REQUIRED",
    sponsoredParticipantIds: [],
    requiredParticipantIds: [],
    ...overrides,
  });
}

interface Person {
  id: string;
  sortKey: number;
  sponsored?: boolean;
  required?: boolean;
  attendance?: RosterParticipant["attendance"];
  acceptedAt?: Date;
  consent?: false | { at?: Date; hash?: string; quoteId?: string; cap?: number };
  auth?: false | { at?: Date; verified?: boolean; status?: RosterAuthorization["status"]; amount?: number; expires?: Date };
}

function scenario(people: Person[], opts: { now?: Date; capMinor?: number; minPayers?: number; termsHash?: string; total?: number; capacity?: number; early?: boolean; merchantAvailable?: boolean } = {}): SettlementInput {
  const capMinor = opts.capMinor ?? 2000;
  const termsHash = opts.termsHash ?? "hash-v1";
  const participants: RosterParticipant[] = [];
  const consents: RosterConsent[] = [];
  const authorizations: RosterAuthorization[] = [];
  for (const p of people) {
    const accepted = p.attendance ?? "ACCEPTED";
    participants.push({
      id: p.id,
      sortKey: p.sortKey,
      payerType: p.sponsored ? "SPONSORED" : "PAYER",
      required: p.required ?? true,
      attendance: accepted,
      attendanceAt: accepted === "PENDING" ? null : (p.acceptedAt ?? BEFORE),
    });
    if (!p.sponsored && p.consent !== false) {
      consents.push({
        id: `consent-${p.id}`,
        participantId: p.id,
        quoteId: p.consent?.quoteId ?? "quote-1",
        termsHash: p.consent?.hash ?? termsHash,
        capMinor: p.consent?.cap ?? capMinor,
        currency: "USD",
        acceptedAt: p.consent?.at ?? BEFORE,
        withdrawnAt: null,
      });
    }
    if (!p.sponsored && p.auth !== false) {
      authorizations.push({
        paymentAttemptId: `pa-${p.id}`,
        participantId: p.id,
        consentId: `consent-${p.id}`,
        status: p.auth?.status ?? "AUTHORIZED",
        verified: p.auth?.verified ?? true,
        authorizedMinor: p.auth?.amount ?? capMinor,
        currency: "USD",
        authorizedAt: p.auth?.at ?? BEFORE,
        expiresAt: p.auth?.expires ?? new Date(DEADLINE.getTime() + 29 * 24 * H),
      });
    }
  }
  return {
    now: opts.now ?? AFTER,
    outingId: "outing-1",
    policy: "ALL_REQUIRED",
    deadlineAt: DEADLINE,
    quote: {
      id: "quote-1",
      termsHash,
      totalMinor: opts.total ?? 10_000,
      currency: "USD",
      capMinor,
      minPayers: opts.minPayers ?? 5,
      capacity: opts.capacity ?? 10,
      expiresAt: new Date(DEADLINE.getTime() + 24 * H),
    },
    participants,
    consents,
    authorizations,
    merchantAvailable: opts.merchantAvailable ?? true,
    early: opts.early,
  };
}

const five = (extra: Partial<Person> = {}): Person[] =>
  ["a", "b", "c", "d", "e"].map((id, i) => ({ id, sortKey: i + 1, ...extra }));

describe("decideSettlement — brief §2 canonical examples", () => {
  it("$100 / 5 payers -> SETTLE $20 each", () => {
    const d = decideSettlement(scenario(five()));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.allocations.map((a) => a.allocationMinor)).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(d.voidPaymentAttemptIds).toEqual([]);
  });

  it("$100 / 10 payers -> $10 each, captured below the $20 hold", () => {
    const people = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, sortKey: i + 1 }));
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.allocations.every((a) => a.allocationMinor === 1000 && a.authorizedMinor === 2000)).toBe(true);
  });

  it("6 attendees incl. 1 sponsored guest -> 5 payers at $20, guest $0", () => {
    const people: Person[] = [...five(), { id: "maya", sortKey: 6, sponsored: true }];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.payerCount).toBe(5);
    expect(d.allocations.find((a) => a.participantId === "maya")).toBeUndefined();
    expect(d.sponsoredParticipantIds).toEqual(["maya"]);
    expect(d.allocations.every((a) => a.allocationMinor === 2000)).toBe(true);
  });

  it("$100 / 3 payers (min 3, cap $33.34) -> 3334, 3333, 3333 by stable sortKey", () => {
    const people: Person[] = [
      { id: "zed", sortKey: 3 },
      { id: "amy", sortKey: 1 },
      { id: "bob", sortKey: 2 },
    ];
    const d = decideSettlement(scenario(people, { minPayers: 3, capMinor: 3334 }));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.allocations.map((a) => [a.participantId, a.allocationMinor])).toEqual([
      ["amy", 3334],
      ["bob", 3333],
      ["zed", 3333],
    ]);
  });
});

describe("decideSettlement — ALL_REQUIRED and fail-closed rules", () => {
  it("a single required holdout cancels even when enough others authorized", () => {
    const people: Person[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, sortKey: i + 1 })),
      { id: "holdout", sortKey: 8, attendance: "PENDING", consent: false, auth: false },
    ];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.reasons).toContain("REQUIRED_MISSING");
    // Every existing hold is voided.
    expect(d.voidPaymentAttemptIds).toHaveLength(7);
  });

  it("an optional non-responder does not block and does not become a payer", () => {
    const people: Person[] = [...five(), { id: "opt", sortKey: 6, required: false, attendance: "PENDING", consent: false, auth: false }];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.payerCount).toBe(5);
  });

  it("an optional payer who authorized lowers everyone's share", () => {
    const people: Person[] = [...five(), { id: "opt", sortKey: 6, required: false }];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.allocations.map((a) => a.allocationMinor)).toEqual([1667, 1667, 1667, 1667, 1666, 1666]);
  });

  it("sponsored guest who never accepted attendance blocks a required outing", () => {
    const people: Person[] = [...five(), { id: "maya", sortKey: 6, sponsored: true, attendance: "PENDING" }];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
  });

  it("late authorization (provider create_time after deadline) is not admitted", () => {
    const people = five();
    people[4].auth = { at: new Date(DEADLINE.getTime() + 1000) };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.ineligible).toContainEqual({ participantId: "e", required: true, reason: "LATE_AUTHORIZATION" });
    expect(d.voidPaymentAttemptIds).toContain("pa-e");
  });

  it("a late optional authorization is voided while the rest settle", () => {
    const people: Person[] = [...five(), { id: "late", sortKey: 6, required: false, auth: { at: new Date(DEADLINE.getTime() + 1000) } }];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("SETTLE");
    if (d.kind !== "SETTLE") return;
    expect(d.payerCount).toBe(5);
    expect(d.voidPaymentAttemptIds).toEqual(["pa-late"]);
  });

  it("unverified authorization for a required payer fails closed (UNVERIFIABLE)", () => {
    const people = five();
    people[0].auth = { verified: false };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.reasons).toContain("UNVERIFIABLE");
  });

  it("UNKNOWN payment state for a required payer cancels and is queued for void", () => {
    const people = five();
    people[2].auth = { status: "UNKNOWN", verified: false };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.voidPaymentAttemptIds).toContain("pa-c");
  });

  it("stale consent (terms changed) is not silently reused", () => {
    const people = five();
    people[1].consent = { hash: "hash-v0" };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.ineligible).toContainEqual({ participantId: "b", required: true, reason: "STALE_CONSENT" });
  });

  it("authorization amount different from consented cap is rejected", () => {
    const people = five();
    people[3].auth = { amount: 1500 };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
  });

  it("expired authorization cancels safely", () => {
    const people = five();
    people[0].auth = { expires: new Date(AFTER.getTime() - 1) };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
  });

  it("fewer eligible payers than minPayers cancels (shares would exceed caps)", () => {
    const people: Person[] = [
      ...five().slice(0, 4),
      { id: "e", sortKey: 5, required: false, attendance: "DECLINED", consent: false, auth: false },
    ];
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.reasons).toContain("BELOW_MIN_PAYERS");
  });

  it("a required decline cancels with REQUIRED_DECLINED", () => {
    const people = five();
    people[0] = { ...people[0], attendance: "DECLINED", consent: false, auth: false };
    const d = decideSettlement(scenario(people));
    expect(d.kind).toBe("CANCEL");
    if (d.kind !== "CANCEL") return;
    expect(d.reasons).toContain("REQUIRED_DECLINED");
  });

  it("merchant unavailable or expired quote cancels", () => {
    expect(decideSettlement(scenario(five(), { merchantAvailable: false })).kind).toBe("CANCEL");
    const s = scenario(five());
    s.quote.expiresAt = new Date(AFTER.getTime() - 1);
    expect(decideSettlement(s).kind).toBe("CANCEL");
  });

  it("capacity overflow cancels", () => {
    expect(decideSettlement(scenario(five(), { capacity: 4, minPayers: 4, capMinor: 2500 })).kind).toBe("CANCEL");
  });

  it("refuses to evaluate before the deadline (no premature capture)", () => {
    expect(() => decideSettlement(scenario(five(), { now: BEFORE }))).toThrow(PolicyError);
  });

  it("early evaluation can cancel an infeasible outing but never settle", () => {
    const people = five();
    people[0] = { ...people[0], attendance: "WITHDRAWN" };
    const d = decideSettlement(scenario(people, { now: BEFORE, early: true }));
    expect(d.kind).toBe("CANCEL");
    expect(() => decideSettlement(scenario(five(), { now: BEFORE, early: true }))).toThrow(PolicyError);
  });

  it("isInfeasible detects required declines/withdrawals only", () => {
    const base: RosterParticipant = { id: "x", sortKey: 1, payerType: "PAYER", required: true, attendance: "PENDING", attendanceAt: null };
    expect(isInfeasible([base])).toBe(false);
    expect(isInfeasible([{ ...base, attendance: "DECLINED" }])).toBe(true);
    expect(isInfeasible([{ ...base, required: false, attendance: "DECLINED" }])).toBe(false);
  });

  it("never allocates above the consented cap", () => {
    for (let n = 5; n <= 10; n++) {
      const people = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, sortKey: i + 1 }));
      const d = decideSettlement(scenario(people, { total: 10_003, capMinor: 2001 }));
      expect(d.kind).toBe("SETTLE");
      if (d.kind === "SETTLE") {
        expect(d.allocations.every((a) => a.allocationMinor <= a.capMinor)).toBe(true);
        expect(d.allocations.reduce((s, a) => s + a.allocationMinor, 0)).toBe(10_003);
      }
    }
  });
});

describe("commitment terms", () => {
  it("computes the per-payer cap and a stable hash", () => {
    const t = baseTerms();
    expect(t.capMinor).toBe(2000);
    expect(hashTerms(t)).toBe(hashTerms(baseTerms()));
  });
  it("any material change produces a different hash", () => {
    const h = hashTerms(baseTerms());
    expect(hashTerms(baseTerms({ totalMinor: 12_000 }))).not.toBe(h);
    expect(hashTerms(baseTerms({ deadlineAt: new Date(DEADLINE.getTime() + H).toISOString() }))).not.toBe(h);
    expect(hashTerms(baseTerms({ sponsoredParticipantIds: ["maya"] }))).not.toBe(h);
    expect(hashTerms(baseTerms({ merchantId: "m-2" }))).not.toBe(h);
    expect(hashTerms(baseTerms({ activityAt: "2026-11-08T18:00:00.000Z" }))).not.toBe(h);
  });
  it("participant list order does not change the hash", () => {
    expect(hashTerms(baseTerms({ requiredParticipantIds: ["a", "b"] }))).toBe(hashTerms(baseTerms({ requiredParticipantIds: ["b", "a"] })));
  });
  it("rejects PER_ATTENDEE pricing for shared fixed-total bookings", () => {
    expect(() => baseTerms({ pricingModel: "PER_ATTENDEE" })).toThrow(PolicyError);
  });
});

describe("deadline validation", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const ok = { now, deadlineAt: new Date(now.getTime() + 24 * H), activityAt: new Date(now.getTime() + 72 * H), quoteExpiresAt: new Date(now.getTime() + 30 * H) };
  it("accepts a 24h window", () => expect(() => validateCommitmentDeadline(ok)).not.toThrow());
  it("rejects windows over 48h", () =>
    expect(() => validateCommitmentDeadline({ ...ok, deadlineAt: new Date(now.getTime() + 49 * H), activityAt: new Date(now.getTime() + 96 * H), quoteExpiresAt: new Date(now.getTime() + 60 * H) })).toThrow(/48 hours/));
  it("rejects deadline after activity", () => expect(() => validateCommitmentDeadline({ ...ok, activityAt: new Date(now.getTime() + 2 * H) })).toThrow(PolicyError));
  it("rejects quote expiring before settlement grace", () => expect(() => validateCommitmentDeadline({ ...ok, quoteExpiresAt: ok.deadlineAt })).toThrow(PolicyError));
  it("rejects a deadline in the past", () => expect(() => validateCommitmentDeadline({ ...ok, deadlineAt: new Date(now.getTime() - 1) })).toThrow(PolicyError));
});

describe("state machine", () => {
  it("follows the documented booking lifecycle", () => {
    expect(canTransitionOuting("COLLECTING", "SETTLING")).toBe(true);
    expect(canTransitionOuting("SETTLING", "CONFIRMED")).toBe(true);
    expect(canTransitionOuting("SETTLING", "COMPENSATING")).toBe(true);
    expect(canTransitionOuting("COMPENSATING", "CANCELLED")).toBe(true);
    expect(canTransitionOuting("COMPENSATING", "CONFIRMED")).toBe(false);
    expect(canTransitionOuting("CANCELLED", "COLLECTING")).toBe(false);
    expect(canTransitionOuting("COLLECTING", "CONFIRMED")).toBe(false);
    expect(() => assertOutingTransition("CONFIRMED", "CANCELLED")).toThrow();
  });
  it("payment lifecycle forbids skipping provider confirmation", () => {
    expect(canTransitionPayment("APPROVAL_PENDING", "CAPTURED")).toBe(false);
    expect(canTransitionPayment("AUTHORIZED", "CAPTURE_PENDING")).toBe(true);
    expect(canTransitionPayment("CAPTURED", "VOIDED")).toBe(false);
    expect(canTransitionPayment("CAPTURED", "REFUND_PENDING")).toBe(true);
    expect(canTransitionPayment("UNKNOWN", "CAPTURED")).toBe(true);
    expect(canTransitionPayment("REFUNDED", "CAPTURED")).toBe(false);
  });
});
