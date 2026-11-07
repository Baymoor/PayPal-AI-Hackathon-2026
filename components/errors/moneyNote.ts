/**
 * The "what does this mean for my money?" line under an error.
 *
 * Why it depends on the action, not the error code: the same code (e.g. DEADLINE_PASSED) can come back
 * from a budget vote or from an authorization, and only the action tells us which money statement is
 * true. Each line must be true for EVERY failure of that action, including a dropped connection where the
 * server may in fact have finished the request.
 */

/** What kind of thing the person was doing when the error happened. */
export type MoneyContext =
  /** Brief, budget votes, reveal, picking an offer, inviting, opening commitments. Never moves money. */
  | "planning"
  /** Accepting or declining an invitation as a non-paying or not-yet-paying guest. */
  | "attendance"
  /** Agreeing to the terms and starting a payment hold. */
  | "authorize"
  /** Leaving after agreeing to pay; on success the hold is released. */
  | "withdraw"
  /** The organizer calling the whole outing off; on success every hold is released. */
  | "cancelOuting"
  /** Demo hub buttons (scenarios, "Process due work now"): these DO move test money (fixture or sandbox). */
  | "demo"
  /** Merchant dashboard (sign-in, loading, questions, operation retries). Merchants aren't being charged. */
  | "dashboard"
  /** An action we haven't classified: fall back to the most conservative statement. */
  | "unknown";

/** `useAction` keys (and their prefixes before ":") mapped to the money context they belong to. */
const CONTEXT_BY_ACTION: Readonly<Record<string, MoneyContext>> = {
  create: "planning",
  start: "planning",
  vote: "planning",
  reveal: "planning",
  round: "planning",
  agree: "planning",
  draft: "planning",
  select: "planning",
  sponsor: "planning",
  req: "planning",
  move: "planning",
  invite: "planning",
  open: "planning",
  accept: "attendance",
  decline: "attendance",
  authorize: "authorize",
  withdraw: "withdraw",
  cancel: "cancelOuting",
  reset: "demo",
  persona: "demo",
  scenario: "demo",
  tick: "demo",
  merchant: "demo",
  dashboard: "dashboard",
};

export function moneyContextForAction(actionKey: string | undefined): MoneyContext {
  if (!actionKey) return "unknown";
  const base = actionKey.split(":")[0] ?? actionKey;
  return CONTEXT_BY_ACTION[base] ?? "unknown";
}

/** Today's line. True for any single request that failed, so it is the safe fallback. */
export const CONSERVATIVE_MONEY_NOTE = "Nothing was charged by this request.";

/**
 * The reassurance shown under an error for this kind of action, or `undefined` to show none.
 *
 * Why each line is true even when the request secretly succeeded (dropped connection):
 * - "planning" / "attendance": these endpoints never touch payments at all (payers can't answer an
 *   invitation without authorizing or withdrawing), so we can make the stronger, friendlier claim.
 * - "authorize": a hold only exists after the person approves on the payment page, which happens after
 *   this request, so a failed attempt never authorized or charged anything.
 * - "withdraw" / "cancelOuting": success releases holds and never captures. We don't say whether the
 *   hold was released, because after a dropped connection it might have been.
 * - "demo": "Process due work now" runs ALL due settlement work (it can capture and refund before
 *   failing), and that work may include PayPal-sandbox outings, so neither "nothing was charged" nor
 *   "only simulated money" is safe. Both fixture and sandbox use test money only.
 */
export function moneyNoteFor(context: MoneyContext): string | undefined {
  switch (context) {
    case "planning":
      return "Votes and planning steps never move money.";
    case "attendance":
      return "Answering an invitation never moves money.";
    case "authorize":
      return "Nothing was authorized or charged by this attempt.";
    case "withdraw":
      return "Withdrawing never charges you. This page shows where your hold stands.";
    case "cancelOuting":
      return "Cancelling never charges anyone.";
    case "demo":
      return "Demo actions use test money only. No real money moves.";
    case "dashboard":
      // A "nothing was charged" line means nothing to a merchant, and a dropped operation retry may in
      // fact have been queued; the drill-down shows each operation's real state instead.
      return undefined;
    case "unknown":
      return CONSERVATIVE_MONEY_NOTE;
    default: {
      // Compile-time guard: adding a MoneyContext without a line here fails the type check.
      const unhandled: never = context;
      return unhandled;
    }
  }
}
