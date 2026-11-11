/**
 * Typed fixture OutingViews for /dev/preview. Dev-only: nothing here is imported by production routes.
 * All times use a frozen "serverNow"; the preview derives a clock offset so countdowns tick.
 */
import type { OutingView, PersonView, CatalogueCandidateView, QuoteView } from "@/lib/contracts/views";

const SERVER_NOW = "2026-11-11T15:00:00.000Z"; // Wed 10:00 New York
const DEADLINE = "2026-11-12T23:00:00.000Z"; // Thu 18:00 New York
const ACTIVITY = "2026-11-14T00:00:00.000Z"; // Fri 19:00 New York... (EST) -> Fri 19:00

const person = (i: number, name: string, over: Partial<PersonView> = {}): PersonView => ({
  participantId: `p${i}`,
  displayName: name,
  role: i === 0 ? "ORGANIZER" : "INVITEE",
  payerType: "PAYER",
  required: true,
  attendance: "PENDING",
  committed: false,
  hasVoted: false,
  ...over,
});

const names = ["Alex", "Maya", "Ben", "Priya", "Sam", "Jo"];
const people = (over: (i: number) => Partial<PersonView> = () => ({})): PersonView[] =>
  names.map((n, i) => person(i, n, over(i)));

const emptyCan = { vote: false, accept: false, decline: false, consent: false, authorize: false, withdraw: false };
const orgCanNone = {
  startBudget: false, addInvitees: false, reveal: false, newRound: false, agreeBudget: false, propose: false,
  selectOffering: false, editRoster: false, openCollection: false, cancel: false,
};

/** Per-person vote amounts: what one person would personally pay. */
const OPTIONS = [1000, 1500, 2000, 3000, 4000];

const candidates: CatalogueCandidateView[] = [
  {
    offeringId: "o-sound", name: "Private karaoke room", merchantName: "The Sound Room", category: "Karaoke", description: "Private room with a stage screen, two mics and a snack menu. Up to 10 guests.",
    location: "Downtown", pricingModel: "FIXED_TOTAL", priceMinor: 10000, currency: "USD", capacity: 10, minAttendees: 3, fit: "GREAT",
    reasons: ["Fixed total — more guests lower everyone’s share", "Private room, as you asked"], concerns: [],
    budget: { costMinor: 2000, payers: 5, within: true, overByMinor: 0 },
  },
  {
    offeringId: "o-pottery", name: "Pottery studio session", merchantName: "Clay & Co", category: "Workshop", description: "Guided wheel session with firing included.",
    location: "Riverside", pricingModel: "PER_ATTENDEE", priceMinor: 3500, currency: "USD", capacity: 8, minAttendees: 2, fit: "GOOD",
    reasons: ["Hands-on and social"], concerns: ["Price grows with each extra guest", "Less of a birthday-party feel"],
    budget: { costMinor: 4200, payers: 5, within: false, overByMinor: 2200 },
  },
  {
    offeringId: "o-escape", name: "Escape room for six", merchantName: "Locked In", category: "Game", description: "60-minute themed room.",
    location: "Midtown", pricingModel: "FIXED_TOTAL", priceMinor: 18000, currency: "USD", capacity: 6, minAttendees: 4, fit: "STRETCH",
    reasons: ["Great for a group of six"], concerns: ["Capacity of six is tight"],
    budget: { costMinor: 3600, payers: 5, within: false, overByMinor: 1600 },
  },
];

const quote = (over: Partial<QuoteView> = {}): QuoteView => ({
  id: "q1", version: 1, merchantName: "The Sound Room", offeringName: "Private karaoke room", category: "karaoke", location: "Downtown", pricingModel: "FIXED_TOTAL",
  totalMinor: 10000, currency: "USD", capMinor: 2000, minPayers: 5, capacity: 10, activityAt: ACTIVITY, deadlineAt: DEADLINE,
  expiresAt: "2026-11-14T00:00:00.000Z", termsHash: "hash-v1", merchantConfirmedAt: "2026-11-11T14:00:00.000Z", availabilitySource: "FIXTURE",
  sponsoredNames: ["Maya"], requiredCount: 5, ...over,
});

const brief = {
  extraction: {
    title: "Maya's birthday karaoke", activityIdeas: ["Karaoke"], categories: ["Karaoke"],
    dateWindow: { description: "Friday evening", dayOfWeek: "FRI" as const, partOfDay: "EVENING" as const },
    groupSize: { count: 6, isEstimate: false }, budget: { amountMinor: null, unit: "UNKNOWN" as const },
    guestOfHonour: { name: "Maya", coverTheirShare: true }, prefersFixedTotal: true, needs: ["Private room"],
    uncertainties: ["Which Friday — this week or next?", "Is everyone definitely coming?"],
    summary: [
      { icon: "activity" as const, text: "Karaoke night with a private room" },
      { icon: "date" as const, text: "Friday evening" },
      { icon: "people" as const, text: "6 people" },
      { icon: "gift" as const, text: "Guest of honour: Maya — group covers her share" },
      { icon: "budget" as const, text: "Budget: not set yet" },
    ],
  },
  source: "FIXTURE" as const,
  model: null,
};

function base(over: DeepPartial<OutingView> = {}): OutingView {
  const v: OutingView = {
    outing: {
      id: "11111111-1111-4111-8111-111111111111", title: "Maya's birthday karaoke",
      brief: "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share.",
      status: "BUDGETING", stage: "BUDGET", isFixture: true, currency: "USD", displayTimezone: "America/New_York",
      activityAt: null, deadlineAt: null, serverNow: SERVER_NOW, cancelReasons: [], cleanup: "NONE", paymentMode: "FIXTURE", aiMode: "FIXTURE", demoMode: true,
    },
    viewer: { participantId: "p2", displayName: "Ben", role: "INVITEE", payerType: "PAYER", required: true, attendance: "PENDING", isOrganizer: false },
    brief,
    budget: {
      round: 1, unit: "PER_PERSON", options: OPTIONS, myVoteMinor: null, votedCount: 3, invitedCount: 6, revealed: false, canReveal: false,
      aggregate: null, aiSummary: null, proposedBudgetMinor: null,
    },
    proposal: null,
    quote: null,
    roster: { people: people((i) => ({ hasVoted: i < 3 })), capacity: null, minPayers: null, invitedPayers: 5, sponsoredCount: 0, attendeeCount: 6, requiredInvited: 5, requiredAccepted: 0, payersAuthorized: 0 },
    estimates: { capMinor: null, projectedPayers: 6, estimatedShareMinor: null },
    me: { consent: null, payment: null, finalShareMinor: null, can: { ...emptyCan, vote: true } },
    organizer: null,
    settlement: null,
  };
  return merge(v, over);
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> | T[K] : T[K] };
function merge<T>(a: T, b: unknown): T {
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return (b === undefined ? a : (b as T));
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, val] of Object.entries(b as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = val && typeof val === "object" && !Array.isArray(val) && cur && typeof cur === "object" && !Array.isArray(cur) ? merge(cur, val) : val;
  }
  return out as T;
}

const organizer = { participantId: "p0", displayName: "Alex", role: "ORGANIZER" as const, payerType: "PAYER" as const, required: true, attendance: "ACCEPTED" as const, isOrganizer: true };

/* Organizer collecting state shared by commit/waiting/result fixtures. */
const collecting = (over: DeepPartial<OutingView> = {}): OutingView =>
  base({
    outing: { status: "COLLECTING", stage: "COMMIT", activityAt: ACTIVITY, deadlineAt: DEADLINE },
    budget: { revealed: true, proposedBudgetMinor: 2000, votedCount: 6 },
    proposal: { candidates, note: null, source: "FIXTURE", selectedOfferingId: "o-sound" },
    quote: quote(),
    roster: {
      people: people((i) => ({
        hasVoted: true,
        payerType: i === 1 ? "SPONSORED" : "PAYER",
        attendance: i <= 3 ? "ACCEPTED" : "PENDING",
        committed: i === 0 || i === 3 || i === 4 || i === 1,
        required: i < 5,
      })),
      capacity: 10, minPayers: 5, invitedPayers: 5, sponsoredCount: 1, attendeeCount: 6, requiredInvited: 5, requiredAccepted: 4, payersAuthorized: 4,
    },
    estimates: { capMinor: 2000, projectedPayers: 5, estimatedShareMinor: 2000 },
    me: { can: { ...emptyCan, consent: true, authorize: true, decline: true } },
    ...over,
  });

const authorizedPayment = {
  paymentAttemptId: "pa1", status: "AUTHORIZED" as const, provider: "FIXTURE" as const, providerLabel: "Fixture · not real PayPal",
  authorizedMinor: 2000, capturedMinor: 0, refundedMinor: 0, late: false, verified: true, authorizationRef: "…4F2A",
};

export const FIXTURES: Record<string, { label: string; view: OutingView }> = {
  "brief-organizer": {
    label: "Brief understood (organizer)",
    view: base({
      outing: { status: "DRAFT", stage: "BRIEF" },
      viewer: organizer,
      budget: { votedCount: 0, invitedCount: 0 },
      roster: { people: [person(0, "Alex", { attendance: "ACCEPTED" })], attendeeCount: 1, invitedPayers: 0 },
      me: { can: emptyCan },
      organizer: { can: { ...orgCanNone, startBudget: true } },
    }),
  },
  "budget-not-voted": {
    label: "Budget poker — not voted",
    view: base({ roster: { people: people((i) => ({ hasVoted: i < 3 && i !== 2 })) }, budget: { votedCount: 2 } }),
  },
  "budget-voted": {
    label: "Budget poker — voted, 4 of 6",
    view: base({
      budget: { myVoteMinor: 2000, votedCount: 4 },
      roster: { people: people((i) => ({ hasVoted: i <= 3 })) },
    }),
  },
  "budget-organizer": {
    label: "Budget poker — organizer, can reveal, invite",
    view: base({
      viewer: organizer,
      budget: { myVoteMinor: 2000, votedCount: 4, canReveal: true },
      roster: { people: people((i) => ({ hasVoted: i <= 3 })) },
      organizer: { can: { ...orgCanNone, addInvitees: true, reveal: true } },
    }),
  },
  "budget-reveal": {
    label: "Reveal — aggregate (organizer)",
    view: base({
      viewer: organizer,
      budget: {
        revealed: true, votedCount: 6, myVoteMinor: 2000, proposedBudgetMinor: null,
        aggregate: {
          unit: "PER_PERSON", currency: "USD", voteCount: 6, invitedCount: 6, minMinor: 1000, maxMinor: 3000, medianMinor: 2000,
          buckets: [{ amountMinor: 1000, count: 1 }, { amountMinor: 1500, count: 1 }, { amountMinor: 2000, count: 3 }, { amountMinor: 3000, count: 1 }],
        },
        aiSummary: { headline: "Most of the group is around $20 each", summary: "Three of six said $20 per person and the middle of the range is $20. One person wants to spend less, one a bit more.", suggestedAmountMinor: 2000, source: "FIXTURE", model: null },
      },
      organizer: { can: { ...orgCanNone, agreeBudget: true, newRound: true } },
      me: { can: emptyCan },
    }),
  },
  "budget-reveal-guest": {
    label: "Reveal — aggregate (guest)",
    view: base({
      budget: {
        revealed: true, votedCount: 6, myVoteMinor: 2000,
        aggregate: {
          unit: "PER_PERSON", currency: "USD", voteCount: 6, invitedCount: 6, minMinor: 1000, maxMinor: 3000, medianMinor: 2000,
          buckets: [{ amountMinor: 1000, count: 1 }, { amountMinor: 1500, count: 1 }, { amountMinor: 2000, count: 3 }, { amountMinor: 3000, count: 1 }],
        },
        aiSummary: { headline: "Most of the group is around $20 each", summary: "Three of six said $20 per person.", suggestedAmountMinor: 2000, source: "ANTHROPIC", model: "claude-sonnet-5-5" },
      },
      me: { can: emptyCan },
    }),
  },
  "proposal-organizer": {
    label: "Invite — ranked options, sponsor, open",
    view: base({
      outing: { status: "PROPOSED", stage: "INVITE" },
      viewer: organizer,
      budget: { revealed: true, proposedBudgetMinor: 2000, votedCount: 6 },
      proposal: { candidates, note: "The karaoke room is a fixed price, so every extra guest lowers the share.", source: "FIXTURE", selectedOfferingId: "o-sound" },
      roster: {
        people: people((i) => ({ payerType: i === 1 ? "SPONSORED" : "PAYER", required: i < 5 })),
        sponsoredCount: 1, invitedPayers: 5, attendeeCount: 6,
      },
      estimates: { capMinor: 2000, projectedPayers: 5, estimatedShareMinor: 2000 },
      organizer: { can: { ...orgCanNone, addInvitees: true, selectOffering: true, editRoster: true, openCollection: true, propose: true } },
      me: { can: emptyCan },
    }),
  },
  "proposal-per-attendee": {
    label: "Invite — PER_ATTENDEE option selected",
    view: base({
      outing: { status: "PROPOSED", stage: "INVITE" },
      viewer: organizer,
      budget: { revealed: true, proposedBudgetMinor: 2000 },
      proposal: { candidates, note: null, source: "ANTHROPIC", selectedOfferingId: "o-pottery" },
      estimates: { capMinor: 3500, projectedPayers: 6, estimatedShareMinor: 3500 },
      organizer: { can: { ...orgCanNone, addInvitees: true, selectOffering: true, editRoster: true, openCollection: true } },
      me: { can: emptyCan },
    }),
  },
  "proposal-guest": {
    label: "Invite — guest waits",
    view: base({ outing: { status: "PROPOSED", stage: "INVITE" }, budget: { revealed: true, proposedBudgetMinor: 2000 }, me: { can: emptyCan } }),
  },
  invitation: { label: "Invitation — 4 of 5 payers committed", view: collecting() },
  "invitation-sandbox": {
    label: "Invitation — PayPal sandbox mode, real AI",
    view: collecting({ outing: { paymentMode: "PAYPAL_SANDBOX", aiMode: "ANTHROPIC", isFixture: false }, brief: { source: "ANTHROPIC", model: "claude-sonnet-5-5" } }),
  },
  "invitation-sponsored": {
    label: "Invitation — sponsored guest",
    view: collecting({
      viewer: { participantId: "p1", displayName: "Maya", payerType: "SPONSORED" },
      me: { can: { ...emptyCan, accept: true, decline: true } },
    }),
  },
  "invitation-late": {
    label: "Invitation — ?payment=failed banner",
    view: collecting(),
  },
  // The two ?payment=pending cases: only UNKNOWN resolves by itself; an uncompleted approval holds nothing.
  "invitation-approval-incomplete": {
    label: "Invitation — ?payment=pending, approval not completed (no hold)",
    view: collecting({
      me: {
        payment: { ...authorizedPayment, status: "APPROVAL_PENDING", authorizedMinor: 0, verified: false, authorizationRef: null },
        can: { ...emptyCan, consent: true, authorize: true, decline: true },
      },
    }),
  },
  "invitation-confirming": {
    label: "Invitation — ?payment=pending, still confirming (UNKNOWN)",
    view: collecting({
      me: {
        payment: { ...authorizedPayment, status: "UNKNOWN", authorizedMinor: 0, verified: false, authorizationRef: null },
        can: { ...emptyCan, decline: true },
      },
    }),
  },
  waiting: {
    label: "Waiting — $20 authorized, est. $10",
    view: collecting({
      roster: { payersAuthorized: 10, invitedPayers: 10, attendeeCount: 11 },
      estimates: { projectedPayers: 10, estimatedShareMinor: 1000 },
      me: { payment: authorizedPayment, consent: { acceptedAt: SERVER_NOW, capMinor: 2000, termsHash: "hash-v1", current: true }, can: { ...emptyCan, withdraw: true } },
    }),
  },
  "waiting-organizer": {
    label: "Waiting — organizer with cancel",
    view: collecting({
      viewer: organizer,
      estimates: { estimatedShareMinor: 2000 },
      me: { payment: authorizedPayment, can: { ...emptyCan, withdraw: true } },
      organizer: { can: { ...orgCanNone, addInvitees: true, cancel: true } },
    }),
  },
  confirmed: {
    label: "Result — confirmed",
    view: collecting({
      outing: { status: "CONFIRMED", stage: "RESULT", cleanup: "NONE" },
      me: { finalShareMinor: 1000, payment: { ...authorizedPayment, status: "CAPTURED", capturedMinor: 1000 }, can: emptyCan },
    }),
  },
  "cancelled-void-pending": {
    label: "Result — cancelled, hold release pending",
    view: collecting({
      outing: { status: "CANCELLED", stage: "RESULT", cleanup: "VOID_PENDING", cancelReasons: ["REQUIRED_MISSING"] },
      me: { payment: { ...authorizedPayment, status: "VOID_PENDING" }, can: emptyCan },
    }),
  },
  "cancelled-complete": {
    label: "Result — cancelled, holds released",
    view: collecting({
      outing: { status: "CANCELLED", stage: "RESULT", cleanup: "COMPLETE", cancelReasons: ["BELOW_MIN_PAYERS"] },
      me: { payment: { ...authorizedPayment, status: "VOIDED" }, can: emptyCan },
    }),
  },
  compensating: {
    label: "Result — recovery, refund pending",
    view: collecting({
      outing: { status: "COMPENSATING", stage: "RESULT", cleanup: "REFUND_PENDING", cancelReasons: ["CAPTURE_FAILED"] },
      me: { payment: { ...authorizedPayment, status: "REFUND_PENDING", capturedMinor: 1000 }, can: emptyCan },
    }),
  },
  "recovery-complete": {
    label: "Result — recovery, refunded",
    view: collecting({
      outing: { status: "CANCELLED", stage: "RESULT", cleanup: "COMPLETE", cancelReasons: ["CAPTURE_FAILED"] },
      me: { payment: { ...authorizedPayment, status: "REFUNDED", capturedMinor: 1000, refundedMinor: 1000 }, can: emptyCan },
    }),
  },
};

export const FIXTURE_KEYS = Object.keys(FIXTURES);
export const FIXTURE_FLAGS: Record<string, string> = {
  "invitation-late": "failed",
  "invitation-approval-incomplete": "pending",
  "invitation-confirming": "pending",
  waiting: "authorized",
};
/** `?reason=` that accompanies a failed flag (a lower-cased error code from the PayPal return route). */
export const FIXTURE_REASONS: Record<string, string> = { "invitation-late": "provider_unavailable" };
