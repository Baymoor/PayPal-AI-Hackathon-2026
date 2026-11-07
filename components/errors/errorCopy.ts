/**
 * Plain-language copy for every error code a person can reach through the UI.
 *
 * Why client-side: error `code`s are the stable API contract (client logic and tests key on them), while
 * the server's `message` is written for many audiences. Keeping the human copy here means one place to
 * tune the voice, no churn in the ~70 server throw sites, and the money reassurance can depend on what the
 * person was doing (see moneyNote.ts), which the server cannot know.
 *
 * Rules for writing entries:
 * - Say what happened, then what to do next. No blame, no jargon ("roster", "minPayers", "fixture").
 * - Never claim anything about money that the code alone doesn't guarantee. Code-specific money facts go
 *   in `moneyNote`; the general reassurance comes from the action (moneyNote.ts).
 * - Omit `explanation` when the server message carries specifics the client can't know (names, numbers,
 *   availability reasons). The server's text is then shown under our title.
 * - Never name PayPal: the same codes come from the labelled payment simulator.
 */

/** Visual weight of an error; maps onto StatusBanner tones. */
export type ErrorTone = "danger" | "warning" | "pending" | "info";

/** Text for "what to do next". A function receives the server's Retry-After (seconds), when it sent one. */
export type NextStep = string | ((retryAfterSeconds: number | undefined) => string);

export interface ErrorCopy {
  readonly title: string;
  /** What happened and why. Omit to show the server's message instead (it has the specifics). */
  readonly explanation?: string;
  readonly nextStep?: NextStep;
  /** Defaults to "warning": most errors are a "not like that" rather than a failure. */
  readonly tone?: ErrorTone;
  /**
   * A money fact implied by this code. A string replaces the action's general note; `null` hides the
   * money note because the explanation already covers money (or there is nothing to reassure about).
   */
  readonly moneyNote?: string | null;
}

/** "30 seconds", "a minute", "2 minutes": rounded up so we never tell people to retry too early. */
export function describeWait(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "a minute";
  if (seconds < 60) return `${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

const WAIT_FOR_RESULT = "This page will show whether the booking is confirmed or every hold is released.";
const REFRESH_TO_SEE = "Refresh the page to see where the outing is now.";
const ASK_TO_REINVITE = "If that's a mistake, ask the organizer to invite you again.";

/** Codes the client creates itself (components/outing/api.ts); never sent by the server. */
export const CLIENT_ERROR_CODES = { network: "NETWORK", networkRead: "NETWORK_READ", unknown: "UNKNOWN" } as const;

export const ERROR_COPY: Readonly<Record<string, ErrorCopy>> = {
  // --- Connection and server trouble ------------------------------------------------------------
  // The request may have reached the server before the connection dropped, so the honest answer is
  // "we can't tell", never "it failed" (same idea as the UNKNOWN payment outcomes on the server).
  NETWORK: {
    title: "We couldn't confirm that",
    explanation: "The connection dropped before the server answered, so we can't tell whether it went through.",
    nextStep: "Refresh the page to see where things stand before trying again.",
  },
  // A failed read (loading a page) can't have changed anything, so no uncertainty to explain.
  NETWORK_READ: {
    title: "We couldn't reach the server",
    explanation: "Your connection may have dropped, or the server didn't answer.",
    nextStep: "Check your connection, then try again.",
    tone: "pending",
  },
  TEMPORARILY_UNAVAILABLE: {
    title: "We're having trouble on our side",
    explanation: "A service we rely on didn't respond. This usually clears up within a minute.",
    nextStep: (s) => `Try again in ${describeWait(s)}.`,
    tone: "pending",
  },
  RATE_LIMITED: {
    title: "Too many tries in a short time",
    explanation: "To keep things fair and safe, we limit how quickly the same thing can be repeated.",
    nextStep: (s) => `Wait ${describeWait(s)}, then try again.`,
    tone: "pending",
  },
  CONCURRENT_UPDATE: {
    title: "Something else changed at the same moment",
    explanation: "Another change to this outing arrived at the same time, so we stopped yours rather than mix them up.",
    nextStep: "Check the page, then try again.",
  },
  INTERNAL: {
    title: "Something went wrong on our side",
    explanation: "The server hit an unexpected problem and stopped before finishing.",
    nextStep: "Try again. If it keeps happening, refresh the page.",
    tone: "danger",
  },
  UNKNOWN: {
    title: "Something went wrong on this page",
    explanation: "This screen hit an unexpected problem before it could finish.",
    nextStep: "Refresh the page and try again.",
    tone: "danger",
  },
  // The server's message is human for both kinds (lib/http.ts): schema failures say "Some of the details
  // sent weren't in the expected format. Check what you entered and try again."; service checks say what
  // to fix ("Add at least one name"). So show it as is, with no next step that would repeat it.
  INVALID_INPUT: { title: "Some details didn't look right" },

  // --- Access ---------------------------------------------------------------------------------------
  UNAUTHORIZED: {
    title: "Open your invitation link",
    explanation: "This outing is private to the people invited, and this browser isn't signed in to it yet.",
    nextStep: "Open the personal link the organizer sent you. It signs you in on this device.",
    tone: "info",
    moneyNote: null,
  },
  FORBIDDEN: {
    title: "That isn't available to you",
    nextStep: "If you think it should be, ask the organizer.",
  },
  NOT_FOUND: {
    title: "We can't find that",
    explanation: "It may have been removed, or the page is out of date.",
    nextStep: "Refresh the page to see the latest.",
  },

  // --- Deadline and outing state --------------------------------------------------------------------
  DEADLINE_PASSED: {
    title: "The commitment deadline has passed",
    explanation: "Once the deadline arrives, the group is locked in and nothing new can be added or changed.",
    nextStep: WAIT_FOR_RESULT,
    tone: "info",
  },
  ROSTER_FROZEN: {
    title: "Commitments just closed",
    explanation: "The deadline arrived and the group is now locked in, so new commitments can't be added.",
    nextStep: WAIT_FOR_RESULT,
    tone: "info",
  },
  WITHDRAW_CLOSED: {
    title: "Withdrawals are closed",
    explanation:
      "You can't withdraw after the commitment deadline. The deadline decision now either collects each person's share or releases every hold.",
    nextStep: WAIT_FOR_RESULT,
    tone: "info",
  },
  INVALID_STATE: {
    title: "That step isn't available right now",
    nextStep: REFRESH_TO_SEE,
  },
  OUTING_NOT_COLLECTING: {
    title: "This outing isn't taking commitments",
    explanation: "Payment holds can only be set up while the group is collecting commitments.",
    nextStep: REFRESH_TO_SEE,
    tone: "info",
  },

  // --- Terms and consent ----------------------------------------------------------------------------
  TERMS_CHANGED: {
    title: "The plan changed since you looked",
    explanation:
      "Something that affects what you'd pay changed, such as the price, date, place or who's covered. You need to see the new terms before agreeing.",
    nextStep: "Review the updated terms, then decide again.",
  },
  CONSENT_REQUIRED: {
    title: "Review the terms first",
    explanation: "Before a payment hold is set up, you agree to the exact terms: the total, your maximum share and the deadline.",
    nextStep: "Read the terms and tick the box to continue.",
  },
  CONSENT_LATE: {
    title: "Your agreement arrived after the deadline",
    explanation: "Agreements recorded after the commitment deadline can't be counted.",
    nextStep: WAIT_FOR_RESULT,
    tone: "info",
  },
  NO_QUOTE: {
    title: "There's nothing to agree to yet",
    explanation: "The organizer hasn't confirmed a booking and price for this outing.",
    nextStep: "Check back once the organizer opens commitments.",
    tone: "info",
  },
  NO_ACTIVE_QUOTE: {
    title: "There's nothing to agree to yet",
    explanation: "The organizer hasn't confirmed a booking and price for this outing.",
    nextStep: "Check back once the organizer opens commitments.",
    tone: "info",
  },

  // --- Payment holds ----------------------------------------------------------------------------------
  ALREADY_AUTHORIZED: {
    title: "You're already in",
    explanation: "You already authorized your maximum share for these exact terms, so there's nothing more to do.",
    nextStep: "Refresh the page to see your hold.",
    tone: "info",
    moneyNote: "No second hold was created.",
  },
  PAYMENT_BEING_CONFIRMED: {
    title: "We're still confirming your last attempt",
    explanation: "Your previous payment attempt hasn't been confirmed yet, and we won't start a second one until it is.",
    nextStep: "Check back in a minute. This page updates on its own.",
    tone: "pending",
    moneyNote: "No second hold was created.",
  },
  PAYMENT_IN_PROGRESS: {
    title: "Your payment hold is already being set up",
    explanation: "Another attempt to set up your hold is under way.",
    nextStep: "Wait a moment, then refresh the page.",
    tone: "pending",
    moneyNote: "No second hold was created.",
  },
  PAYMENTS_DISABLED: {
    title: "Payments are switched off here",
    explanation: "This deployment isn't set up to take payment holds for this outing.",
    nextStep: "To try the full flow, use the outings on the Try the demo page.",
  },
  PROVIDER_UNAVAILABLE: {
    title: "We couldn't reach the payment provider",
    explanation: "The payment service didn't answer in time.",
    nextStep: "Try again in a minute.",
    tone: "pending",
  },
  PROVIDER_REJECTED: {
    title: "The payment provider couldn't set up your hold",
    explanation: "It declined to create the payment hold.",
    nextStep: "Try again in a few minutes.",
    tone: "danger",
  },
  PROVIDER_ERROR: {
    title: "The payment provider didn't respond as expected",
    explanation: "It didn't send back the approval page we need to continue.",
    nextStep: "Try again in a few minutes.",
    tone: "danger",
  },
  // Coming back from the payment page with a reply that doesn't match the attempt (?payment=failed&reason=…).
  MISSING_TOKEN: {
    title: "The payment page's reply didn't match",
    explanation: "What came back from the payment page was incomplete, so we didn't use it.",
    nextStep: "Start again from Review & authorize.",
    tone: "danger",
  },
  ORDER_MISMATCH: {
    title: "The payment page's reply didn't match",
    explanation: "What came back from the payment page belongs to a different attempt, so we didn't use it.",
    nextStep: "Start again from Review & authorize.",
    tone: "danger",
  },
  NO_ORDER: {
    title: "This attempt never reached the payment provider",
    explanation: "The payment attempt was created but never sent on, so there is nothing to confirm.",
    nextStep: "Start again from Review & authorize.",
  },
  NOT_A_PAYER: {
    title: "Your share is covered",
    explanation: "The group is paying for you, so there's nothing for you to authorize.",
    nextStep: "Just accept the invitation so everyone knows you're coming.",
    tone: "info",
    moneyNote: null,
  },

  // --- Attendance -----------------------------------------------------------------------------------
  NOT_ATTENDING: {
    title: "You're not attending this outing",
    explanation: "You declined or withdrew, so you can't vote or commit for this one.",
    nextStep: ASK_TO_REINVITE,
    tone: "info",
  },
  ALREADY_DECLINED: {
    title: "You already declined",
    explanation: "You told the organizer you can't make it.",
    nextStep: ASK_TO_REINVITE,
    tone: "info",
  },
  ALREADY_WITHDRAWN: {
    title: "You already withdrew",
    explanation: "You left this outing earlier.",
    nextStep: ASK_TO_REINVITE,
    tone: "info",
  },
  ORGANIZER_RESPONSE: {
    title: "You're the organizer",
    explanation: "Organizers are always part of their own outing, so there's no invitation to answer.",
    nextStep: "To call the outing off, use Cancel outing instead.",
    tone: "info",
  },
  USE_CONSENT: {
    title: "Paying guests join by authorizing",
    explanation: "Because you're paying a share, you join by reviewing the terms and authorizing your maximum.",
    nextStep: "Use Review & authorize instead.",
    tone: "info",
  },
  USE_WITHDRAW: {
    title: "Use Withdraw instead",
    explanation: "You've agreed to pay a share, so leaving also has to release your payment hold.",
    nextStep: "Use Withdraw to leave the outing.",
    tone: "info",
  },

  // --- Budget poker ---------------------------------------------------------------------------------
  ALREADY_REVEALED: {
    title: "This round is already revealed",
    explanation: "Once the organizer reveals a round, its votes can't change.",
    nextStep: "The organizer can start a new round if the group wants to vote again.",
    tone: "info",
  },
  // Server text states the minimum and why ("so no single vote is exposed").
  NOT_ENOUGH_VOTES: {
    title: "Not enough votes to reveal yet",
    nextStep: "Wait for more people to vote, then reveal.",
    tone: "info",
  },
  INVALID_UNIT: {
    title: "Votes are for the group's total",
    explanation: "Suggest what the whole outing should cost in total, not a per-person amount.",
    nextStep: "Pick a total budget and vote again.",
  },
  INVALID_AMOUNT: {
    title: "That amount doesn't work",
    explanation: "Budgets need to be more than $0, in dollars and cents, and not unrealistically large.",
    nextStep: "Enter a different amount.",
  },

  // --- Organizer setup ------------------------------------------------------------------------------
  INVALID_NAME: { title: "Check the name" },
  INVALID_BRIEF: {
    title: "Add a few words about the plan",
    explanation: "What you want to do, who's coming and roughly when is enough.",
  },
  BRIEF_TOO_LONG: {
    title: "That plan is a bit long",
    nextStep: "Keep it to the essentials: what, who and when.",
  },
  NO_OFFERING: {
    title: "Pick a booking first",
    explanation: "Choose one of the venue's offers before opening commitments.",
  },
  OFFERING_UNAVAILABLE: {
    title: "That offer isn't available any more",
    nextStep: "Choose another option, or try again later.",
  },
  MERCHANT_UNAVAILABLE: {
    title: "The venue isn't available then",
    nextStep: "Try a different date or time.",
  },
  REQUIRED_DECLINED: { title: "A required guest declined" },
  NO_PAYERS: {
    title: "Someone has to pay",
    explanation: "At least one person must pay a share. Not everyone can be covered.",
  },
  SPONSOR_LIMIT: {
    title: "Only one guest can be covered",
    nextStep: "To cover someone else, switch off the current covered guest first.",
  },
  CAPACITY_EXCEEDED: {
    title: "Too many people for this booking",
    nextStep: "Choose a larger option, or invite fewer people.",
  },
  TOO_MANY_PARTICIPANTS: { title: "That's the largest group we support" },
  ONLY_OPTIONAL_DURING_COLLECTION: { title: "Only optional guests can be added now", tone: "info" },
  // Server variants include "minPayers must be a positive integer"; this explanation covers all of them.
  INVALID_MIN_PAYERS: {
    title: "Check the minimum number of payers",
    explanation:
      "The minimum number of payers sets each person's maximum share. It must be at least 1 and no more than the number of people paying.",
  },
  INVALID_DATE: {
    title: "Check the date and time",
    explanation: "We couldn't read one of the dates.",
    nextStep: "Pick it again from the date picker.",
  },
  DEADLINE_TOO_SOON: { title: "Check the commitment deadline" },
  DEADLINE_AFTER_ACTIVITY: { title: "Check the commitment deadline" },
  QUOTE_EXPIRES_TOO_SOON: { title: "Check the commitment deadline" },
  ORGANIZER_IS_PAYER: { title: "The organizer always pays a share", tone: "info" },
  ORGANIZER_IS_REQUIRED: { title: "The organizer is always required", tone: "info" },
  NO_CANDIDATES: { title: "No options fit yet", tone: "info" },

  // --- Planning assistant ---------------------------------------------------------------------------
  // Server text already says "Nothing changed; you can fill in the form yourself."
  AI_UNAVAILABLE: { title: "The assistant couldn't help just now", tone: "pending" },
  AI_OUTPUT_INVALID: { title: "The assistant's suggestion couldn't be used" },
};

/** Merchant dashboard codes. Money notes are hidden there: merchants aren't the ones being charged. */
export const MERCHANT_ERROR_COPY: Readonly<Record<string, ErrorCopy>> = {
  LOGIN_DISABLED: {
    title: "Password sign-in isn't set up here",
    explanation: "This deployment doesn't have a dashboard password.",
    nextStep: "Ask whoever runs it to set one.",
    tone: "info",
  },
  INVALID_PASSWORD: {
    title: "That password didn't work",
    explanation: "It doesn't match this dashboard's password.",
    nextStep: "Check it and try again.",
  },
  MERCHANT_NOT_SEEDED: {
    title: "The merchant isn't set up yet",
    explanation: "There's no merchant account in the database yet.",
    nextStep: "Whoever runs this deployment needs to run the seed script (npm run db:seed).",
    tone: "danger",
  },
  NOT_RETRYABLE: { title: "This operation can't be retried", tone: "info" },
  INVALID_QUESTION: { title: "Type a question first" },
  // Client-side: the assistant's answer didn't parse into one of the dashboard's read-only filters.
  UNSAFE_FILTER: {
    title: "We couldn't turn that into a filter",
    explanation: "The answer didn't match the filters this dashboard supports, so nothing was applied.",
    nextStep: "Try rephrasing it, or use the example.",
  },
  // Same code as for participants, different situation: an expired merchant session, not a missing invite.
  UNAUTHORIZED: {
    title: "Your dashboard session has ended",
    explanation: "Merchant sign-ins expire after a while, for security.",
    nextStep: "Sign in again to continue.",
    tone: "info",
  },
};

/** Used for codes not in the map: keeps the server's message, which is better than a vague guess. */
export const UNMAPPED_COPY: ErrorCopy = { title: "That didn't work" };

/** For responses without a JSON error body (e.g. a proxy's HTML 502 page), where the message is useless. */
export const NO_BODY_SERVER_COPY: ErrorCopy = {
  title: "The server didn't respond properly",
  explanation: "We got an unexpected reply, which usually means a brief hiccup on our side.",
  nextStep: "Try again in a minute.",
  tone: "pending",
};
