/** Turns any thrown value into the three-part error people see: what happened, what next, what about money. */
import { ApiError } from "@/components/outing/api";
import { CLIENT_ERROR_CODES, ERROR_COPY, NO_BODY_SERVER_COPY, UNMAPPED_COPY, type ErrorCopy, type ErrorTone, type NextStep } from "./errorCopy";
import { moneyContextForAction, moneyNoteFor } from "./moneyNote";

export interface FriendlyError {
  /** The API's stable code (or NETWORK / UNKNOWN for client-side failures). Logic keys on this. */
  readonly code: string;
  readonly title: string;
  readonly explanation: string;
  readonly nextStep?: string;
  readonly moneyNote?: string;
  readonly tone: ErrorTone;
}

/** The facts we know about a failure, independent of how it was thrown. */
export interface ErrorFacts {
  readonly code: string;
  readonly serverMessage?: string;
  readonly retryAfterSeconds?: number;
}

const FALLBACK_EXPLANATION = "We couldn't finish that.";

export function errorFacts(error: unknown): ErrorFacts {
  if (!(error instanceof ApiError)) return { code: CLIENT_ERROR_CODES.unknown };
  return { code: error.code, serverMessage: error.message, retryAfterSeconds: error.retryAfterSeconds };
}

/** `request()` invents HTTP_<status> codes when a response had no JSON error body. */
function copyFor(code: string): ErrorCopy {
  return ERROR_COPY[code] ?? (code.startsWith("HTTP_") ? NO_BODY_SERVER_COPY : UNMAPPED_COPY);
}

function resolveNextStep(step: NextStep | undefined, retryAfterSeconds: number | undefined): string | undefined {
  return typeof step === "function" ? step(retryAfterSeconds) : step;
}

/** `null` in the copy hides the note; a string replaces the action's general note. */
function resolveMoneyNote(copy: ErrorCopy, actionKey: string | undefined): string | undefined {
  if (copy.moneyNote === null) return undefined;
  return copy.moneyNote ?? moneyNoteFor(moneyContextForAction(actionKey));
}

/** For callers that only have a code, e.g. the `?reason=` of a failed payment redirect. */
export function describeErrorFacts(facts: ErrorFacts, actionKey?: string): FriendlyError {
  const copy = copyFor(facts.code);
  return {
    code: facts.code,
    title: copy.title,
    explanation: copy.explanation ?? (facts.serverMessage?.trim() || FALLBACK_EXPLANATION),
    nextStep: resolveNextStep(copy.nextStep, facts.retryAfterSeconds),
    moneyNote: resolveMoneyNote(copy, actionKey),
    tone: copy.tone ?? "warning",
  };
}

/**
 * @param actionKey the `useAction` key (e.g. "authorize", "vote", "scenario:holdout"); it decides the
 *   money reassurance, because only the action tells us what is true about money.
 */
export function describeError(error: unknown, actionKey?: string): FriendlyError {
  return describeErrorFacts(errorFacts(error), actionKey);
}

/** Single-line form for compact lists, e.g. "Not applied" items in the plan draft. */
export function errorSummary(error: FriendlyError): string {
  return `${error.title}. ${error.explanation}`;
}
