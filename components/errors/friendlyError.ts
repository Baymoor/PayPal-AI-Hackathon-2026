/** Turns any thrown value into the three-part error people see: what happened, what next, what about money. */
import { ApiError } from "./apiError";
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

/** Own-property check, so a code can never resolve to an Object.prototype member. */
function knownCopy(code: string, overrides?: CopyOverrides): ErrorCopy | undefined {
  if (overrides && Object.hasOwn(overrides, code)) return overrides[code];
  return Object.hasOwn(ERROR_COPY, code) ? ERROR_COPY[code] : undefined;
}

/** `request()` invents HTTP_<status> codes when a response had no JSON error body. */
function copyFor(code: string, overrides?: CopyOverrides): ErrorCopy {
  return knownCopy(code, overrides) ?? (code.startsWith("HTTP_") ? NO_BODY_SERVER_COPY : UNMAPPED_COPY);
}

function resolveNextStep(step: NextStep | undefined, retryAfterSeconds: number | undefined): string | undefined {
  return typeof step === "function" ? step(retryAfterSeconds) : step;
}

/** `null` in the copy hides the note; a string replaces the action's general note. */
function resolveMoneyNote(copy: ErrorCopy, actionKey: string | undefined): string | undefined {
  if (copy.moneyNote === null) return undefined;
  return copy.moneyNote ?? moneyNoteFor(moneyContextForAction(actionKey));
}

/** Audience-specific copy for codes whose meaning differs by screen (e.g. UNAUTHORIZED for merchants). */
export type CopyOverrides = Readonly<Record<string, ErrorCopy>>;

/** For callers that only have a code rather than a thrown error. */
export function describeErrorFacts(facts: ErrorFacts, actionKey?: string, overrides?: CopyOverrides): FriendlyError {
  const copy = copyFor(facts.code, overrides);
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
export function describeError(error: unknown, actionKey?: string, overrides?: CopyOverrides): FriendlyError {
  return describeErrorFacts(errorFacts(error), actionKey, overrides);
}

/**
 * Explains the `?reason=` of a failed payment redirect (lower-cased error code), or null. The URL is
 * editable by anyone, so only codes we have a full explanation for are shown; nothing from the URL is
 * ever echoed. The server's message isn't in the URL, so codes that rely on it are skipped too.
 */
export function describePaymentFailureReason(reason: string | undefined): FriendlyError | null {
  if (!reason) return null;
  const copy = knownCopy(reason.toUpperCase());
  if (!copy?.explanation) return null;
  return describeErrorFacts({ code: reason.toUpperCase() }, "authorize");
}

/** Server messages don't always end in punctuation; joining sentences needs them to. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Single-line form for compact lists, e.g. "Not applied" items in the plan draft. */
export function errorSummary(error: FriendlyError): string {
  return `${error.title}. ${asSentence(error.explanation)}`;
}

/** Title, explanation and next step as one plain string, for places that only take text. */
export function errorSentence(error: FriendlyError): string {
  return error.nextStep ? `${errorSummary(error)} ${error.nextStep}` : errorSummary(error);
}
