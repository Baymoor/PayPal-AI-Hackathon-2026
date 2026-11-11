/**
 * Judge-mode to-dos and the "Next:" hint are derived from an OutingView only.
 * Pure logic with many branches, hence unit tests.
 */
import { describe, expect, it } from "vitest";
import type { OutingView, PersonView } from "@/lib/contracts/views";
import type { OutingStatus } from "@/lib/domain/types";
import { describeTodo, judgeBoard, todoFor } from "@/lib/demo/judge";
import { votesNeededToReveal } from "@/lib/domain/budget-reveal";

type PersonOverride = Partial<PersonView> & { displayName: string };

function person(o: PersonOverride, index: number): PersonView {
  return {
    participantId: `p${index}`,
    role: index === 0 ? "ORGANIZER" : "INVITEE",
    payerType: "PAYER",
    required: true,
    attendance: "PENDING",
    committed: false,
    hasVoted: false,
    ...o,
  };
}

function view(input: { status: OutingStatus; people: PersonOverride[]; viewer?: number; revealed?: boolean }): OutingView {
  const people = input.people.map(person);
  const viewer = people[input.viewer ?? 0];
  const budgeting = input.status === "BUDGETING";
  // Only the fields judgeBoard reads are meaningful; the rest satisfies the DTO.
  return {
    outing: {
      id: "o1",
      title: "t",
      brief: "",
      status: input.status,
      stage: "BUDGET",
      isFixture: false,
      currency: "USD",
      displayTimezone: "UTC",
      activityAt: null,
      deadlineAt: null,
      serverNow: "2026-11-08T00:00:00.000Z",
      cancelReasons: [],
      cleanup: "NONE",
      paymentMode: "FIXTURE",
      aiMode: "FIXTURE",
      demoMode: true,
    },
    viewer: {
      participantId: viewer.participantId,
      displayName: viewer.displayName,
      role: viewer.role,
      payerType: viewer.payerType,
      required: viewer.required,
      attendance: viewer.attendance,
      isOrganizer: viewer.role === "ORGANIZER",
    },
    brief: { extraction: null, source: null, model: null },
    budget: {
      round: 1,
      unit: "TOTAL",
      options: [],
      myVoteMinor: null,
      votedCount: budgeting ? people.filter((p) => p.hasVoted).length : 0,
      invitedCount: people.length,
      revealed: input.revealed ?? false,
      votesNeeded: votesNeededToReveal(people.length),
      canReveal: false,
      aggregate: null,
      aiSummary: null,
      proposedBudgetMinor: null,
    },
    proposal: null,
    quote: null,
    roster: { people, capacity: null, minPayers: null, invitedPayers: 0, sponsoredCount: 0, attendeeCount: people.length, requiredInvited: 0, requiredAccepted: 0, payersAuthorized: 0 },
    estimates: { capMinor: null, projectedPayers: 0, estimatedShareMinor: null },
    me: { consent: null, payment: null, finalShareMinor: null, can: { vote: false, accept: false, decline: false, consent: false, authorize: false, withdraw: false } },
    organizer: null,
    settlement: null,
  };
}

const CAST: PersonOverride[] = [{ displayName: "Alex" }, { displayName: "Ben" }, { displayName: "Freya" }, { displayName: "Maya", payerType: "SPONSORED" }];

describe("judgeBoard", () => {
  it("DRAFT: the organizer invites and starts the vote; nobody else has a to-do", () => {
    const alone = judgeBoard(view({ status: "DRAFT", people: [{ displayName: "Alex" }] }));
    expect(alone.acting.todo?.kind).toBe("INVITE_AND_START_BUDGET");
    expect(alone.nextStep).toBe("Next: you (Alex) can invite people and start the budget vote");

    const b = judgeBoard(view({ status: "DRAFT", people: CAST, viewer: 1 }));
    expect(b.acting.todo).toBeNull();
    expect(b.others.find((p) => p.displayName === "Alex")?.todo?.kind).toBe("START_BUDGET");
    expect(b.others.filter((p) => !p.isOrganizer).every((p) => p.todo === null)).toBe(true);
    expect(b.nextStep).toBe("Next: switch to Alex and start the budget vote");
  });

  it("BUDGETING: everyone who has not voted needs to vote, voters are marked, and the viewer comes first", () => {
    const b = judgeBoard(view({ status: "BUDGETING", people: [{ displayName: "Alex", hasVoted: true }, { displayName: "Ben" }, { displayName: "Freya", hasVoted: true }, { displayName: "Maya", payerType: "SPONSORED" }] }));
    expect(b.acting.todo).toBeNull();
    const ben = b.others.find((p) => p.displayName === "Ben")!;
    expect(ben.todo && describeTodo(ben.todo)).toBe("needs to vote");
    expect(b.others.find((p) => p.displayName === "Freya")).toMatchObject({ todo: null, note: "voted" });
    expect(b.others.find((p) => p.displayName === "Maya")?.todo?.kind).toBe("VOTE");
    expect(b.nextStep).toBe("Next: switch to Ben and vote");

    const asBen = judgeBoard(view({ status: "BUDGETING", people: [{ displayName: "Alex", hasVoted: true }, { displayName: "Ben" }], viewer: 1 }));
    expect(asBen.nextStep).toBe("Next: you (Ben) can vote");
  });

  it("BUDGETING: the organizer can reveal at 3 of 4 votes (75%), even while someone still owes a vote", () => {
    const b = judgeBoard(view({ status: "BUDGETING", people: [{ displayName: "Alex", hasVoted: true }, { displayName: "Ben", hasVoted: true }, { displayName: "Freya", hasVoted: true }, { displayName: "Noor" }] }));
    expect(b.acting.todo && describeTodo(b.acting.todo)).toBe("can reveal the votes");
    expect(b.nextStep).toBe("Next: you (Alex) can reveal the votes");
  });

  it("BUDGETING: in a group of 6 the reveal waits for 5 votes (75%), so 4 votes still point at someone who owes one", () => {
    const six = ["Alex", "Ben", "Freya", "Jules", "Noor", "Maya"];
    const b = judgeBoard(view({ status: "BUDGETING", people: six.map((displayName, i) => ({ displayName, hasVoted: i < 4 })) }));
    expect(b.acting.todo).toBeNull();
    expect(b.nextStep).toBe("Next: switch to Noor and vote");

    const five = judgeBoard(view({ status: "BUDGETING", people: six.map((displayName, i) => ({ displayName, hasVoted: i < 5 })) }));
    expect(five.acting.todo && describeTodo(five.acting.todo)).toBe("can reveal the votes");
  });

  it("BUDGETING: below 3 votes with everyone voted, the organizer must invite more people", () => {
    const b = judgeBoard(view({ status: "BUDGETING", people: [{ displayName: "Alex", hasVoted: true }, { displayName: "Ben", hasVoted: true }] }));
    expect(b.acting.todo?.kind).toBe("INVITE_MORE_VOTERS");
    expect(b.nextStep).toContain("3 votes are needed to reveal");
  });

  it("after reveal only the organizer acts: agree a budget; then PROPOSED: pick and open", () => {
    const revealed = judgeBoard(view({ status: "BUDGETING", revealed: true, people: CAST.map((p) => ({ ...p, hasVoted: true })), viewer: 1 }));
    expect(revealed.acting.todo).toBeNull();
    expect(revealed.nextStep).toBe("Next: switch to Alex and agree a budget");

    const proposed = judgeBoard(view({ status: "PROPOSED", people: CAST }));
    expect(proposed.nextStep).toBe("Next: you (Alex) can pick an option and open commitments");
  });

  it("COLLECTING: payers need to commit, sponsored guests need to accept, declined people have nothing to do", () => {
    const b = judgeBoard(
      view({
        status: "COLLECTING",
        people: [
          { displayName: "Alex", committed: true, attendance: "ACCEPTED" },
          { displayName: "Ben" },
          { displayName: "Freya", attendance: "DECLINED" },
          { displayName: "Maya", payerType: "SPONSORED" },
          { displayName: "Noor", payerType: "SPONSORED", attendance: "ACCEPTED", committed: true },
        ],
      }),
    );
    expect(b.acting).toMatchObject({ todo: null, note: "committed" });
    expect(b.others.find((p) => p.displayName === "Ben")?.todo && describeTodo(b.others.find((p) => p.displayName === "Ben")!.todo!)).toBe("needs to commit");
    expect(b.others.find((p) => p.displayName === "Freya")).toMatchObject({ todo: null, note: "declined" });
    expect(b.others.find((p) => p.displayName === "Maya")?.todo?.kind).toBe("ACCEPT");
    expect(b.others.find((p) => p.displayName === "Noor")).toMatchObject({ todo: null, note: "accepted" });
    expect(b.nextStep).toBe("Next: switch to Ben and commit");
  });

  it("COLLECTING with everyone committed: wait for the deadline or process due work", () => {
    const b = judgeBoard(view({ status: "COLLECTING", people: [{ displayName: "Alex", committed: true }, { displayName: "Ben", committed: true }] }));
    expect(b.nextStep).toBe("Next: wait for the deadline, or use Run the deadline now on the demo page");
  });

  it("result states have no to-dos and point at the worker or say it is finished", () => {
    expect(judgeBoard(view({ status: "SETTLING", people: CAST })).nextStep).toContain("Run the deadline now");
    for (const status of ["CONFIRMED", "CANCELLED"] as const) {
      const b = judgeBoard(view({ status, people: CAST }));
      expect([b.acting, ...b.others].every((p) => p.todo === null)).toBe(true);
      expect(b.nextStep).toBe("Next: nothing left to do here");
    }
  });

  it("never mentions amounts: the hint and labels contain no currency", () => {
    for (const status of ["DRAFT", "BUDGETING", "PROPOSED", "COLLECTING"] as const) {
      const b = judgeBoard(view({ status, people: CAST }));
      const text = [b.nextStep, ...[b.acting, ...b.others].map((p) => (p.todo ? describeTodo(p.todo) : p.note ?? ""))].join(" ");
      expect(text).not.toMatch(/[$€£]|\d{2,}/);
    }
  });

  it("todoFor: a withdrawn payer during collection has nothing to do", () => {
    const v = view({ status: "COLLECTING", people: [{ displayName: "Alex" }, { displayName: "Ben", attendance: "WITHDRAWN" }] });
    expect(todoFor(v, v.roster.people[1])).toBeNull();
  });
});
