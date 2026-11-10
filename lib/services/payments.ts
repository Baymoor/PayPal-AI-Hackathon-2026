/**
 * Payer-side payment service: start an authorization, complete it when the
 * buyer returns from PayPal (or from the FIXTURE approval page), handle a
 * cancelled approval, withdraw before the deadline, and reconcile attempts
 * whose provider outcome is UNKNOWN.
 *
 * Money rules enforced here (docs/PRODUCT_SPEC.md §3-§7, docs/CONTRACTS.md):
 * - The order amount is ALWAYS the consented cap (consent.capMinor) for the
 *   CURRENT terms hash. The client never supplies an amount.
 * - Server time only. At/after the deadline, or once the roster is frozen, no
 *   new authorization is made; a late provider authorization is recorded and
 *   immediately planned for VOID, never admitted.
 * - Recording an authorization locks the outing row (FOR UPDATE) in the same
 *   transaction; if a settlement snapshot exists and the attempt is not
 *   allocated, a VOID is planned (race rule with the settlement engine).
 * - Provider UNKNOWN (timeout / 5xx) is never treated as success or failure:
 *   the attempt goes to UNKNOWN and a RECONCILE_PAYMENT job is enqueued.
 * - Audit entries carry no PII, tokens or secrets (ids are truncated).
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  consents,
  merchants,
  outings,
  participants,
  paymentAttempts,
  quoteVersions,
  settlementSnapshots,
  type Consent,
  type Outing,
  type PaymentAttempt,
  type QuoteVersion,
} from "../db/schema";
import type { Db, DbOrTx, Tx } from "../db/client";
import { config, type PaymentMode } from "../env";
import { assertCurrency, formatMoney } from "../domain/money";
import { assertPaymentTransition } from "../domain/state-machine";
import type { PaymentProviderName, PaymentStatus } from "../domain/types";
import { enqueueJob } from "../jobs/queue";
import { planPaymentOperation } from "../payments/plan";
import {
  defaultPaymentProviderName,
  FixtureProvider,
  getPaymentProvider,
  providerLabel,
  ProviderUnavailableError,
  type PaymentProvider,
} from "../payments";
import type { AuthorizationView, CreateOrderInput, ProviderFailure } from "../payments/provider";
import { recordAudit, type AuditActor } from "../audit";
import { badRequest, conflict, notFound, ServiceError } from "../http";

/** Reuse an APPROVAL_PENDING attempt's approval link for this long (PayPal keeps idempotency keys >= 6 h). */
export const APPROVAL_REUSE_WINDOW_MS = 3 * 60 * 60 * 1000;
/** A CREATED attempt younger than this is assumed to be in flight (double click). */
export const CREATED_IN_FLIGHT_MS = 2 * 60 * 1000;
/** Delay before the first reconciliation of an UNKNOWN attempt. */
export const RECONCILE_DELAY_MS = 10_000;

export const orderRequestId = (attemptId: string) => `outings-order-${attemptId}`;
export const authorizeRequestId = (attemptId: string) => `outings-authorize-${attemptId}`;
export const reconcileJobKey = (attemptId: string) => `reconcile:${attemptId}`;

export type PaymentOutcome = "AUTHORIZED" | "LATE" | "PENDING" | "FAILED" | "CANCELLED";

/** Where the browser lands after an approval round-trip. */
export function paymentRedirectPath(outingId: string, outcome: PaymentOutcome): string {
  return `/o/${outingId}?payment=${outcome.toLowerCase()}`;
}

const participantActor = (participantId: string): AuditActor => `PARTICIPANT:${participantId}`;
/** Truncated provider reference for audit / UI (never the full id). */
export const redactRef = (id: string | null | undefined): string | null => (id ? `…${id.slice(-4)}` : null);

const HELD_STATUSES: ReadonlySet<PaymentStatus> = new Set(["AUTHORIZED", "CAPTURE_PENDING", "CAPTURED"]);

function appUrl(path: string): string {
  return `${config().appBaseUrl.replace(/\/+$/, "")}${path}`;
}

function resolveDefaultProvider(): PaymentProviderName {
  try {
    return defaultPaymentProviderName();
  } catch (e) {
    if (e instanceof ProviderUnavailableError) throw new ServiceError("PAYMENTS_DISABLED", 503, e.message);
    throw e;
  }
}

/**
 * Which provider a NEW attempt for this outing must use. Demo (isFixture)
 * outings are seeded with FIXTURE holds and always stay on the simulator;
 * they never fall back to real PayPal when the simulator is disabled. Real
 * outings use the configured default (PayPal sandbox when credentials exist),
 * so one settlement never mixes simulated and real holds.
 */
export function providerNameForOuting(outing: Pick<Outing, "isFixture">): PaymentProviderName {
  if (outing.isFixture) {
    if (config().demoFixturesEnabled) return "FIXTURE";
    throw new ServiceError(
      "PAYMENTS_DISABLED",
      503,
      "This demo outing uses the fixture payment simulator, which is disabled (DEMO_FIXTURES_ENABLED is not set). It cannot be paid through real PayPal.",
    );
  }
  return resolveDefaultProvider();
}

/**
 * The payment mode a participant's screen must describe for THIS outing.
 * Mirrors `providerNameForOuting`: demo (isFixture) outings pay through the
 * simulator even when PayPal sandbox keys are set, so the deployment-wide
 * mode would label their simulated holds "PayPal sandbox".
 */
export function paymentModeForOuting(outing: Pick<Outing, "isFixture">): PaymentMode {
  const c = config();
  if (outing.isFixture) return c.demoFixturesEnabled ? "FIXTURE" : "DISABLED";
  return c.paymentMode;
}

function providerFor(name: PaymentProviderName): PaymentProvider {
  try {
    return getPaymentProvider(name);
  } catch (e) {
    if (e instanceof ProviderUnavailableError) throw new ServiceError("PAYMENTS_DISABLED", 503, e.message);
    throw e;
  }
}

/** Never let a thrown provider/network bug look like a definitive answer. */
async function safeCall<T>(fn: () => Promise<T>): Promise<T | ProviderFailure> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, kind: "UNKNOWN", code: "PROVIDER_EXCEPTION", message: e instanceof Error ? e.message.slice(0, 200) : "provider call threw" };
  }
}

function failureNote(f: ProviderFailure): string {
  return `${f.kind}:${f.code}${f.debugId ? ` debug_id=${f.debugId}` : ""}`.slice(0, 500);
}

function deadlineOf(outing: Outing): Date {
  if (!outing.deadlineAt) throw conflict("OUTING_NOT_COLLECTING", "This outing is not collecting commitments");
  return outing.deadlineAt;
}

/** True while the outing accepts NEW commitments, judged by server time. */
function acceptsNewCommitments(outing: Outing, now: Date): boolean {
  return outing.status === "COLLECTING" && !outing.frozenAt && !!outing.deadlineAt && now.getTime() < outing.deadlineAt.getTime();
}

async function lockOuting(tx: Tx, outingId: string): Promise<Outing> {
  const rows = await tx.select().from(outings).where(eq(outings.id, outingId)).for("update");
  if (!rows[0]) throw notFound("Outing not found");
  return rows[0];
}

async function lockAttempt(tx: Tx, attemptId: string): Promise<PaymentAttempt> {
  const rows = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).for("update");
  if (!rows[0]) throw notFound("Payment attempt not found");
  return rows[0];
}

/** Move an attempt to `next` with a legal transition; extra columns optional. */
async function setStatus(tx: Tx, attempt: PaymentAttempt, next: PaymentStatus, now: Date, extra: Partial<PaymentAttempt> = {}): Promise<void> {
  assertPaymentTransition(attempt.status, next);
  await tx
    .update(paymentAttempts)
    .set({ ...extra, status: next, updatedAt: now })
    .where(eq(paymentAttempts.id, attempt.id));
  attempt.status = next;
}

async function enqueueReconcile(tx: Tx, attempt: PaymentAttempt, now: Date, stage: "CREATE_ORDER" | "AUTHORIZE"): Promise<void> {
  await enqueueJob(tx, {
    kind: "RECONCILE_PAYMENT",
    outingId: attempt.outingId,
    runAt: new Date(now.getTime() + RECONCILE_DELAY_MS),
    dedupeKey: reconcileJobKey(attempt.id),
    payload: { paymentAttemptId: attempt.id, stage },
    onConflict: "requeue",
  });
}

function outcomeOf(attempt: PaymentAttempt): PaymentOutcome {
  switch (attempt.status) {
    case "AUTHORIZED":
    case "CAPTURE_PENDING":
    case "CAPTURED":
    case "REFUND_PENDING":
    case "REFUNDED":
      return attempt.late ? "LATE" : "AUTHORIZED";
    case "CREATED":
    case "APPROVAL_PENDING":
    case "UNKNOWN":
      return "PENDING";
    default:
      return attempt.late ? "LATE" : "FAILED";
  }
}

function describeHold(quote: QuoteVersion, capMinor: number): string {
  const terms = (quote.terms ?? {}) as { offeringName?: unknown };
  const what = typeof terms.offeringName === "string" ? terms.offeringName : "group outing";
  const currency = assertCurrency(quote.currency);
  return `Outings: hold up to ${formatMoney(capMinor, currency, { alwaysShowCents: true })} for ${what}`.slice(0, 127);
}

/**
 * The PayPal payee for an outing: its merchant's `merchants.paypal_merchant_id`,
 * else the deployment-wide PAYPAL_MERCHANT_ID, else none (PayPal then pays the
 * API caller's own account). Used both when creating the order and when
 * verifying the authorization's payee. FIXTURE attempts never carry a payee.
 */
export async function expectedPayeeFor(
  db: DbOrTx,
  provider: PaymentProviderName,
  merchantId: string | null | undefined,
): Promise<string | undefined> {
  if (provider !== "PAYPAL") return undefined;
  const merchant = merchantId
    ? await db.query.merchants.findFirst({ columns: { paypalMerchantId: true }, where: eq(merchants.id, merchantId) })
    : undefined;
  const fromRow = merchant?.paypalMerchantId?.trim();
  return fromRow || config().paypal?.merchantId;
}

function orderInput(attempt: PaymentAttempt, quote: QuoteVersion, payeeMerchantId: string | undefined): CreateOrderInput {
  return {
    requestId: orderRequestId(attempt.id),
    paymentAttemptId: attempt.id,
    amountMinor: attempt.requestedMinor,
    currency: assertCurrency(attempt.currency),
    description: describeHold(quote, attempt.requestedMinor),
    returnUrl: appUrl(`/api/payments/paypal/return?attempt=${attempt.id}`),
    cancelUrl: appUrl(`/api/payments/paypal/cancel?attempt=${attempt.id}`),
    ...(payeeMerchantId ? { payeeMerchantId } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

export interface StartPaymentResult {
  approveUrl: string;
  paymentAttemptId: string;
  provider: PaymentProviderName;
  providerLabel: string;
  /** True when an existing, still-valid approval link was returned instead of a new order. */
  reused: boolean;
}

/** The participant's active consent to the outing's CURRENT terms; throws a 409 otherwise. */
async function requireCurrentConsent(tx: Tx, participantId: string, outingId: string, quote: QuoteVersion, deadline: Date): Promise<Consent> {
  const active = await tx
    .select()
    .from(consents)
    .where(and(eq(consents.participantId, participantId), eq(consents.outingId, outingId), isNull(consents.withdrawnAt)))
    .orderBy(desc(consents.acceptedAt));
  const current = active.find((c) => c.quoteId === quote.id && c.termsHash === quote.termsHash);
  if (!current) {
    if (active.length > 0) throw conflict("TERMS_CHANGED", "The terms changed since you agreed to them. Review the new terms again before authorizing.");
    throw conflict("CONSENT_REQUIRED", "Review and accept the terms before authorizing a payment hold.");
  }
  if (current.capMinor !== quote.capMinor || current.currency !== quote.currency) {
    throw conflict("TERMS_CHANGED", "Your consent does not match the current terms. Review them again before authorizing.");
  }
  if (current.acceptedAt.getTime() >= deadline.getTime()) {
    throw conflict("CONSENT_LATE", "Your consent was recorded after the deadline.");
  }
  return current;
}

type StartPrep =
  | { kind: "reuse"; attempt: PaymentAttempt; quote: QuoteVersion; payee: string | undefined }
  | { kind: "new"; attempt: PaymentAttempt; quote: QuoteVersion; payee: string | undefined };

export async function startPayment(
  db: Db,
  input: { outingId: string; participantId: string; now: Date; reviewedTermsHash?: string },
  opts: { allowReuse?: boolean } = {},
): Promise<StartPaymentResult> {
  const { now } = input;
  const actor = participantActor(input.participantId);

  const prep: StartPrep = await db.transaction(async (tx) => {
    // Serialise concurrent starts by the same participant (double clicks).
    const [participant] = await tx
      .select()
      .from(participants)
      .where(and(eq(participants.id, input.participantId), eq(participants.outingId, input.outingId)))
      .for("update");
    if (!participant) throw notFound("Participant not found");
    const outing = await tx.query.outings.findFirst({ where: eq(outings.id, input.outingId) });
    if (!outing) throw notFound("Outing not found");
    if (outing.status !== "COLLECTING" || outing.frozenAt) {
      throw conflict("OUTING_NOT_COLLECTING", "This outing is not accepting payment holds right now.");
    }
    const providerName = providerNameForOuting(outing);
    const deadline = deadlineOf(outing);
    if (now.getTime() >= deadline.getTime()) {
      throw conflict("DEADLINE_PASSED", "The commitment deadline has passed. No new payment holds are accepted.");
    }
    if (participant.payerType !== "PAYER") {
      throw conflict("NOT_A_PAYER", "You're a sponsored guest — there is nothing to pay. Just accept the invitation.");
    }
    if (participant.attendance === "DECLINED" || participant.attendance === "WITHDRAWN") {
      throw conflict("NOT_ATTENDING", "You have declined or withdrawn from this outing.");
    }
    const quote = outing.currentQuoteId
      ? await tx.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId) })
      : undefined;
    if (!quote || quote.status !== "ACTIVE" || quote.outingId !== outing.id) {
      throw conflict("NO_ACTIVE_QUOTE", "There are no active terms to authorize against.");
    }
    if (input.reviewedTermsHash && input.reviewedTermsHash !== quote.termsHash) {
      throw conflict("TERMS_CHANGED", "The terms changed since you reviewed them. Review the new terms again before authorizing.");
    }
    const consent = await requireCurrentConsent(tx, participant.id, outing.id, quote, deadline);
    const payee = await expectedPayeeFor(tx, providerName, outing.merchantId);

    const attempts = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.participantId, participant.id), eq(paymentAttempts.outingId, outing.id)))
      .orderBy(desc(paymentAttempts.createdAt));

    for (const a of attempts) {
      if (a.quoteId === quote.id && HELD_STATUSES.has(a.status)) {
        throw conflict("ALREADY_AUTHORIZED", "You already authorized your maximum share for these terms.");
      }
      // An UNKNOWN attempt that reached the provider might hold funds: never open a second hold until it is reconciled.
      if (a.status === "UNKNOWN" && a.providerOrderId) {
        throw conflict("PAYMENT_BEING_CONFIRMED", "We're still confirming your previous payment attempt. Please check back in a minute.");
      }
    }

    for (const a of attempts) {
      if (a.status === "CREATED") {
        if (now.getTime() - a.createdAt.getTime() < CREATED_IN_FLIGHT_MS) {
          throw conflict("PAYMENT_IN_PROGRESS", "Your payment hold is being set up. Try again in a moment.");
        }
        await setStatus(tx, a, "FAILED", now, { lastError: "ABANDONED: order creation never completed" });
      }
      if (a.status === "APPROVAL_PENDING") {
        const reusable =
          opts.allowReuse !== false &&
          a.quoteId === quote.id &&
          a.consentId === consent.id &&
          a.requestedMinor === consent.capMinor &&
          a.provider === providerName &&
          !!a.providerOrderId &&
          now.getTime() - a.createdAt.getTime() < APPROVAL_REUSE_WINDOW_MS;
        if (reusable) return { kind: "reuse", attempt: a, quote, payee } satisfies StartPrep;
        await setStatus(tx, a, "FAILED", now, { lastError: "SUPERSEDED: approval link expired or terms changed; no hold was placed" });
        await recordAudit(tx, { outingId: outing.id, actor, type: "PAYMENT_APPROVAL_SUPERSEDED", data: { paymentAttemptId: a.id } });
      }
    }

    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        outingId: outing.id,
        participantId: participant.id,
        consentId: consent.id,
        quoteId: quote.id,
        provider: providerName,
        status: "CREATED",
        currency: consent.currency,
        // The hold is ALWAYS the consented cap for the current terms — never a client amount.
        requestedMinor: consent.capMinor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await recordAudit(tx, {
      outingId: outing.id,
      actor,
      type: "PAYMENT_STARTED",
      data: { paymentAttemptId: attempt.id, provider: providerName, requestedMinor: attempt.requestedMinor, currency: attempt.currency, quoteId: quote.id },
    });
    return { kind: "new", attempt, quote, payee } satisfies StartPrep;
  });

  const provider = providerFor(prep.attempt.provider);

  if (prep.kind === "reuse") {
    // Idempotent replay with the SAME request id returns the original order and its approval link.
    const replay = await safeCall(() => provider.createAuthorizeOrder(orderInput(prep.attempt, prep.quote, prep.payee)));
    if (replay.ok && replay.orderId === prep.attempt.providerOrderId && replay.approveUrl) {
      return {
        approveUrl: replay.approveUrl,
        paymentAttemptId: prep.attempt.id,
        provider: prep.attempt.provider,
        providerLabel: providerLabel(prep.attempt.provider),
        reused: true,
      };
    }
    await db.transaction(async (tx) => {
      const a = await lockAttempt(tx, prep.attempt.id);
      if (a.status === "APPROVAL_PENDING") {
        await setStatus(tx, a, "FAILED", now, { lastError: "SUPERSEDED: approval link could not be re-issued; no hold was placed" });
      }
    });
    return startPayment(db, input, { allowReuse: false });
  }

  const attempt = prep.attempt;
  const created = await safeCall(() => provider.createAuthorizeOrder(orderInput(attempt, prep.quote, prep.payee)));

  // Errors are returned (not thrown) from the transaction so the recorded status survives the commit.
  const outcome: StartPaymentResult | ServiceError = await db.transaction(async (tx) => {
    const a = await lockAttempt(tx, attempt.id);
    if (a.status !== "CREATED") return conflict("PAYMENT_IN_PROGRESS", "This payment attempt changed while it was being set up.");
    if (created.ok && created.approveUrl) {
      await setStatus(tx, a, "APPROVAL_PENDING", now, { providerOrderId: created.orderId, providerStatus: created.providerStatus });
      await recordAudit(tx, {
        outingId: a.outingId,
        actor,
        type: "PAYMENT_ORDER_CREATED",
        data: { paymentAttemptId: a.id, provider: a.provider, orderRef: redactRef(created.orderId), requestedMinor: a.requestedMinor },
      });
      return {
        approveUrl: created.approveUrl,
        paymentAttemptId: a.id,
        provider: a.provider,
        providerLabel: providerLabel(a.provider),
        reused: false,
      };
    }
    if (created.ok) {
      await setStatus(tx, a, "FAILED", now, {
        providerOrderId: created.orderId,
        providerStatus: created.providerStatus,
        lastError: "NO_APPROVAL_LINK: provider returned no buyer approval link",
      });
      await recordAudit(tx, { outingId: a.outingId, actor, type: "PAYMENT_ORDER_FAILED", data: { paymentAttemptId: a.id, code: "NO_APPROVAL_LINK" } });
      return new ServiceError("PROVIDER_ERROR", 502, "The payment provider did not return an approval link. Nothing was authorized.");
    }
    if (created.kind === "UNKNOWN") {
      await setStatus(tx, a, "UNKNOWN", now, { lastError: failureNote(created) });
      await enqueueReconcile(tx, a, now, "CREATE_ORDER");
      await recordAudit(tx, {
        outingId: a.outingId,
        actor,
        type: "PAYMENT_ORDER_UNKNOWN",
        data: { paymentAttemptId: a.id, code: created.code, debugId: created.debugId ?? null },
      });
      return new ServiceError("PROVIDER_UNAVAILABLE", 503, "We couldn't reach the payment provider. Nothing was authorized — please try again in a minute.");
    }
    await setStatus(tx, a, "FAILED", now, { lastError: failureNote(created) });
    await recordAudit(tx, {
      outingId: a.outingId,
      actor,
      type: "PAYMENT_ORDER_FAILED",
      data: { paymentAttemptId: a.id, kind: created.kind, code: created.code, debugId: created.debugId ?? null },
    });
    return new ServiceError("PROVIDER_REJECTED", 502, "The payment provider could not create the payment hold. Nothing was authorized.");
  });
  if (outcome instanceof ServiceError) throw outcome;
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Record a provider authorization (shared by return route + reconciliation)  */
/* -------------------------------------------------------------------------- */

/** Authorization states in which no hold exists any more (nothing to void). CAPTURED is deliberately absent: captured money is refunded. */
const NOTHING_HELD: ReadonlySet<string> = new Set(["DENIED", "VOIDED", "EXPIRED"]);

interface ReleasePlan {
  voidPlanned: boolean;
  refundPlanned: boolean;
  capturedMinor: number;
  captureRef: string | null;
  releaseNote: string | null;
}

/**
 * Release whatever the provider holds for an authorization we do not admit
 * (mismatch, stray hold on a closed attempt). A live hold is planned for VOID.
 * Money the provider already shows as captured (out of band) is recorded on the
 * attempt and planned for REFUND: a void would be refused (PREVIOUSLY_CAPTURED)
 * and captured money must never stay with the merchant for a booking that is
 * not confirmed. A CAPTURED / PARTIALLY_CAPTURED authorization whose capture
 * is not visible yet still gets a VOID: the void executor re-reads it and turns
 * a refused void into a refund once the capture is visible, or flags it.
 * The attempt must be FAILED (or AUTHORIZED) so *_PENDING is a legal move.
 */
async function planReleaseFor(tx: Tx, attempt: PaymentAttempt, auth: AuthorizationView, now: Date): Promise<ReleasePlan> {
  const plan: ReleasePlan = { voidPlanned: false, refundPlanned: false, capturedMinor: 0, captureRef: null, releaseNote: null };
  const refundable = auth.captures.find((c) => c.status === "COMPLETED" || c.status === "PARTIALLY_REFUNDED");
  const capture = refundable ?? auth.captures.find((c) => c.status === "REFUNDED");
  if (capture) {
    plan.capturedMinor = capture.amountMinor;
    plan.captureRef = redactRef(capture.captureId);
    const notes: string[] = [];
    if (auth.captures.length > 1) notes.push(`${auth.captures.length} captures at provider; only ${plan.captureRef} is tracked`);
    await tx
      .update(paymentAttempts)
      .set({
        captureId: capture.captureId,
        capturedMinor: capture.amountMinor,
        authorizedMinor: Math.max(attempt.authorizedMinor, auth.amountMinor, capture.amountMinor),
        ...(refundable ? {} : { refundedMinor: capture.amountMinor }),
        updatedAt: now,
      })
      .where(eq(paymentAttempts.id, attempt.id));
    if (refundable) {
      await planPaymentOperation(tx, {
        outingId: attempt.outingId,
        paymentAttemptId: attempt.id,
        kind: "REFUND",
        amountMinor: capture.amountMinor,
        currency: capture.currency,
      });
      plan.refundPlanned = true;
    } else {
      notes.push("capture already refunded at provider");
    }
    plan.releaseNote = notes.length > 0 ? notes.join("; ") : null;
    return plan;
  }
  if (!NOTHING_HELD.has(auth.status)) {
    await planPaymentOperation(tx, {
      outingId: attempt.outingId,
      paymentAttemptId: attempt.id,
      kind: "VOID",
      amountMinor: auth.amountMinor,
      currency: auth.currency,
    });
    plan.voidPlanned = true;
  }
  return plan;
}

function describeRelease(plan: ReleasePlan): string {
  return plan.refundPlanned ? "refund planned" : plan.voidPlanned ? "void planned" : "nothing held";
}

function snapshotAllocates(roster: unknown, attemptId: string): boolean {
  const allocations = roster && typeof roster === "object" ? (roster as { allocations?: unknown }).allocations : undefined;
  return Array.isArray(allocations) && allocations.some((a) => a && typeof a === "object" && (a as { paymentAttemptId?: unknown }).paymentAttemptId === attemptId);
}

/**
 * Verify a provider authorization against the attempt and record it, locking
 * the outing row (race rule). Plans a VOID for mismatched, late, or no-longer
 * admissible authorizations.
 */
async function recordAuthorization(db: Db, attemptId: string, auth: AuthorizationView, now: Date, actor: AuditActor): Promise<PaymentOutcome> {
  const pre = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
  if (!pre) throw notFound("Payment attempt not found");

  return db.transaction(async (tx) => {
    // Lock order: outing, then attempt (the settlement decision locks the outing and reads attempts).
    const outing = await lockOuting(tx, pre.outingId);
    const attempt = await lockAttempt(tx, attemptId);
    if (attempt.authorizationId) return outcomeOf(attempt); // already recorded
    if (attempt.status === "FAILED") return recordStrayAuthorization(tx, attempt, auth, now, actor);
    if (attempt.status !== "APPROVAL_PENDING" && attempt.status !== "UNKNOWN") return outcomeOf(attempt);

    const mismatches: string[] = [];
    if (auth.status !== "CREATED") mismatches.push(`STATUS_${auth.providerStatus}`);
    if (auth.amountMinor !== attempt.requestedMinor) mismatches.push("AMOUNT");
    if (auth.currency !== attempt.currency) mismatches.push("CURRENCY");
    if (auth.customId !== attempt.id) mismatches.push("CUSTOM_ID");
    if (auth.orderId && attempt.providerOrderId && auth.orderId !== attempt.providerOrderId) mismatches.push("ORDER_ID");
    const expectedPayee = await expectedPayeeFor(tx, attempt.provider, outing.merchantId);
    if (expectedPayee && auth.payeeMerchantId && auth.payeeMerchantId !== expectedPayee) mismatches.push("PAYEE");

    const verifiedFields = {
      authorizationId: auth.authorizationId,
      authorizedMinor: auth.amountMinor,
      authorizedAt: auth.createTime,
      authorizationExpiresAt: auth.expirationTime,
      providerStatus: auth.providerStatus,
      verified: true,
      verifiedAt: now,
    };
    const baseAudit = {
      paymentAttemptId: attempt.id,
      provider: attempt.provider,
      authorizationRef: redactRef(auth.authorizationId),
      authorizedMinor: auth.amountMinor,
      currency: auth.currency,
      providerCreateTime: auth.createTime.toISOString(),
    };

    if (mismatches.length > 0) {
      await setStatus(tx, attempt, "FAILED", now, { ...verifiedFields, lastError: `AUTHORIZATION_MISMATCH: ${mismatches.join(",")}` });
      // Whatever the provider holds or captured under this authorization is released (void) or returned (refund).
      const release = await planReleaseFor(tx, attempt, auth, now);
      await tx
        .update(paymentAttempts)
        .set({ lastError: `AUTHORIZATION_MISMATCH: ${mismatches.join(",")}; ${describeRelease(release)}`, updatedAt: now })
        .where(eq(paymentAttempts.id, attempt.id));
      await recordAudit(tx, { outingId: attempt.outingId, actor, type: "PAYMENT_AUTHORIZATION_MISMATCH", data: { ...baseAudit, mismatches, ...release } });
      return "FAILED";
    }

    const deadline = outing.deadlineAt;
    const lateByProviderTime = !deadline || auth.createTime.getTime() > deadline.getTime();
    const snapshot = await tx.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, outing.id) });
    const lostRace =
      (snapshot !== undefined && !snapshotAllocates(snapshot.roster, attempt.id)) || outing.status !== "COLLECTING" || outing.frozenAt !== null;
    const consent = await tx.query.consents.findFirst({ where: eq(consents.id, attempt.consentId) });
    const consentGone = !consent || consent.withdrawnAt !== null || attempt.quoteId !== outing.currentQuoteId;
    const late = lateByProviderTime || lostRace;

    await setStatus(tx, attempt, "AUTHORIZED", now, { ...verifiedFields, late, lastError: null });

    if (late || consentGone) {
      await planPaymentOperation(tx, {
        outingId: attempt.outingId,
        paymentAttemptId: attempt.id,
        kind: "VOID",
        amountMinor: auth.amountMinor,
        currency: auth.currency,
      });
      const reasons = [
        ...(lateByProviderTime ? ["AUTHORIZED_AFTER_DEADLINE"] : []),
        ...(lostRace ? ["ROSTER_ALREADY_FROZEN"] : []),
        ...(consentGone ? ["CONSENT_NO_LONGER_CURRENT"] : []),
      ];
      await recordAudit(tx, { outingId: attempt.outingId, actor, type: "PAYMENT_AUTHORIZATION_NOT_ADMITTED", data: { ...baseAudit, reasons, voidPlanned: true } });
      return late ? "LATE" : "FAILED";
    }

    await recordAudit(tx, { outingId: attempt.outingId, actor, type: "PAYMENT_AUTHORIZED", data: baseAudit });
    return "AUTHORIZED";
  });
}

/**
 * A provider authorization exists for an attempt we had already closed as
 * FAILED without ever recording a hold (a reconcile / late-approval path closed
 * it while the authorize call was still in flight, or the hold only became
 * visible later). It is never admitted: record the provider facts on the
 * attempt and plan a VOID so the buyer's money is released — a closed attempt
 * must never hide a live hold.
 */
async function recordStrayAuthorization(tx: Tx, attempt: PaymentAttempt, auth: AuthorizationView, now: Date, actor: AuditActor): Promise<PaymentOutcome> {
  await tx
    .update(paymentAttempts)
    .set({
      authorizationId: auth.authorizationId,
      authorizedMinor: auth.amountMinor,
      authorizedAt: auth.createTime,
      authorizationExpiresAt: auth.expirationTime,
      providerStatus: auth.providerStatus,
      verified: true,
      verifiedAt: now,
      updatedAt: now,
    })
    .where(eq(paymentAttempts.id, attempt.id));
  // A live hold is voided; money already captured under it is refunded (never left with the merchant).
  const release = await planReleaseFor(tx, { ...attempt, authorizedMinor: auth.amountMinor }, auth, now);
  await tx
    .update(paymentAttempts)
    .set({ lastError: `AUTHORIZATION_AFTER_CLOSE: hold found for a closed attempt; ${describeRelease(release)}`, updatedAt: now })
    .where(eq(paymentAttempts.id, attempt.id));
  await recordAudit(tx, {
    outingId: attempt.outingId,
    actor,
    type: "PAYMENT_AUTHORIZATION_NOT_ADMITTED",
    data: {
      paymentAttemptId: attempt.id,
      provider: attempt.provider,
      authorizationRef: redactRef(auth.authorizationId),
      authorizedMinor: auth.amountMinor,
      currency: auth.currency,
      providerCreateTime: auth.createTime.toISOString(),
      reasons: ["ATTEMPT_ALREADY_CLOSED"],
      ...release,
    },
  });
  return attempt.late ? "LATE" : "FAILED";
}

/** Mark an attempt FAILED if it is still awaiting approval / unknown (conditional, race-safe). */
async function failAttempt(
  db: Db,
  attemptId: string,
  now: Date,
  lastError: string,
  audit: { actor: AuditActor; type: string; data?: Record<string, unknown> },
  extra: Partial<PaymentAttempt> = {},
): Promise<PaymentAttempt> {
  return db.transaction(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (a.status === "APPROVAL_PENDING" || a.status === "CREATED" || (a.status === "UNKNOWN" && !a.authorizationId)) {
      await setStatus(tx, a, "FAILED", now, { ...extra, lastError });
      Object.assign(a, extra);
      await recordAudit(tx, { outingId: a.outingId, actor: audit.actor, type: audit.type, data: { paymentAttemptId: a.id, ...(audit.data ?? {}) } });
    }
    return a;
  });
}

/** Call authorize (stable request id) and turn the result into a recorded outcome. */
async function authorizeAndRecord(db: Db, attempt: PaymentAttempt, now: Date, actor: AuditActor): Promise<PaymentOutcome> {
  const provider = providerFor(attempt.provider);
  const orderId = attempt.providerOrderId;
  if (!orderId) throw conflict("NO_ORDER", "This payment attempt has no provider order.");

  // Intent marker BEFORE calling the provider: if this process dies after PayPal
  // authorized but before we record it, the attempt is UNKNOWN with a reconcile
  // job queued, so the hold is always found (and voided if late).
  const proceed = await db.transaction(async (tx) => {
    const a = await lockAttempt(tx, attempt.id);
    if (a.status === "APPROVAL_PENDING") {
      await setStatus(tx, a, "UNKNOWN", now, { lastError: "AUTHORIZE_IN_FLIGHT" });
    } else if (a.status !== "UNKNOWN" || a.authorizationId) {
      return { go: false as const, outcome: outcomeOf(a) }; // a concurrent request already handled it
    }
    await enqueueJob(tx, {
      kind: "RECONCILE_PAYMENT",
      outingId: a.outingId,
      runAt: new Date(now.getTime() + 60_000),
      dedupeKey: reconcileJobKey(a.id),
      payload: { paymentAttemptId: a.id, stage: "AUTHORIZE" },
      onConflict: "requeue",
    });
    return { go: true as const };
  });
  if (!proceed.go) return proceed.outcome;

  const res = await safeCall(() => provider.authorizeOrder({ orderId, requestId: authorizeRequestId(attempt.id) }));
  if (res.ok) return recordAuthorization(db, attempt.id, res.authorization, now, actor);

  if (res.kind === "UNKNOWN") {
    await db.transaction(async (tx) => {
      const a = await lockAttempt(tx, attempt.id);
      if (a.status === "UNKNOWN" && !a.authorizationId) {
        await tx.update(paymentAttempts).set({ lastError: failureNote(res), updatedAt: now }).where(eq(paymentAttempts.id, a.id));
        await enqueueReconcile(tx, a, now, "AUTHORIZE");
      }
      await recordAudit(tx, {
        outingId: a.outingId,
        actor,
        type: "PAYMENT_AUTHORIZE_UNKNOWN",
        data: { paymentAttemptId: a.id, code: res.code, debugId: res.debugId ?? null },
      });
    });
    return "PENDING";
  }
  await failAttempt(db, attempt.id, now, failureNote(res), {
    actor,
    type: "PAYMENT_AUTHORIZE_FAILED",
    data: { kind: res.kind, code: res.code, debugId: res.debugId ?? null },
  });
  return "FAILED";
}

/* -------------------------------------------------------------------------- */
/* Return from approval                                                       */
/* -------------------------------------------------------------------------- */

export interface ApprovalResult {
  outcome: PaymentOutcome;
  outingId: string;
  paymentAttemptId: string;
}

async function loadOwnAttempt(db: Db, attemptId: string, participantId: string): Promise<PaymentAttempt> {
  const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
  // Same answer for "missing" and "someone else's": never reveal other participants' attempts.
  if (!attempt || attempt.participantId !== participantId) throw notFound("Payment attempt not found");
  return attempt;
}

/**
 * The buyer approved at PayPal (redirect return) or on the FIXTURE page.
 * Authorizes only while the outing still accepts commitments (server time).
 */
export async function completeApproval(
  db: Db,
  input: { attemptId: string; participantId: string; orderId: string; now: Date },
): Promise<ApprovalResult> {
  const { now } = input;
  const actor = participantActor(input.participantId);
  const attempt = await loadOwnAttempt(db, input.attemptId, input.participantId);
  const result = (outcome: PaymentOutcome): ApprovalResult => ({ outcome, outingId: attempt.outingId, paymentAttemptId: attempt.id });
  if (!attempt.providerOrderId || attempt.providerOrderId !== input.orderId) {
    throw badRequest("ORDER_MISMATCH", "This approval does not belong to this payment attempt.");
  }
  if (attempt.status !== "APPROVAL_PENDING") return result(outcomeOf(attempt)); // refresh / double return

  const outing = await db.query.outings.findFirst({ where: eq(outings.id, attempt.outingId) });
  if (!outing) throw notFound("Outing not found");

  if (!acceptsNewCommitments(outing, now)) {
    await failAttempt(
      db,
      attempt.id,
      now,
      "LATE_APPROVAL: approval arrived after the deadline — no hold was placed",
      { actor, type: "PAYMENT_APPROVAL_LATE", data: { outingStatus: outing.status } },
      { late: true },
    );
    return result("LATE");
  }

  const consent = await db.query.consents.findFirst({ where: eq(consents.id, attempt.consentId) });
  if (!consent || consent.withdrawnAt || attempt.quoteId !== outing.currentQuoteId) {
    await failAttempt(db, attempt.id, now, "TERMS_CHANGED: consent no longer current — no hold was placed", {
      actor,
      type: "PAYMENT_APPROVAL_STALE",
    });
    return result("FAILED");
  }

  return result(await authorizeAndRecord(db, attempt, now, actor));
}

/** The buyer cancelled at PayPal: abandon the attempt; no hold exists. */
export async function cancelApproval(
  db: Db,
  input: { attemptId: string; participantId: string; orderId?: string | null; now: Date },
): Promise<ApprovalResult> {
  const attempt = await loadOwnAttempt(db, input.attemptId, input.participantId);
  if (input.orderId && attempt.providerOrderId && input.orderId !== attempt.providerOrderId) {
    throw badRequest("ORDER_MISMATCH", "This cancellation does not belong to this payment attempt.");
  }
  if (attempt.status !== "APPROVAL_PENDING" && attempt.status !== "CREATED") {
    return { outcome: outcomeOf(attempt), outingId: attempt.outingId, paymentAttemptId: attempt.id };
  }
  await failAttempt(db, attempt.id, input.now, "ABANDONED: buyer cancelled the approval — no hold was placed", {
    actor: participantActor(input.participantId),
    type: "PAYMENT_APPROVAL_CANCELLED",
  });
  return { outcome: "CANCELLED", outingId: attempt.outingId, paymentAttemptId: attempt.id };
}

/**
 * FIXTURE approval page action. 404 unless demo fixtures are enabled and the
 * attempt was created with the FIXTURE provider.
 */
export async function approveFixturePayment(
  db: Db,
  input: { attemptId: string; participantId: string; outcome: "APPROVE" | "CANCEL"; now: Date },
): Promise<ApprovalResult> {
  if (!config().demoFixturesEnabled) throw notFound("Not found");
  const attempt = await loadOwnAttempt(db, input.attemptId, input.participantId);
  if (attempt.provider !== "FIXTURE") throw notFound("Payment attempt not found");
  if (input.outcome === "CANCEL") {
    return cancelApproval(db, { attemptId: attempt.id, participantId: input.participantId, now: input.now });
  }
  if (attempt.status === "APPROVAL_PENDING" && attempt.providerOrderId) {
    const fixture = getPaymentProvider("FIXTURE");
    if (!(fixture instanceof FixtureProvider)) throw notFound("Payment attempt not found");
    // Simulated buyer approval (like approving on PayPal). Our deadline checks happen in completeApproval.
    await fixture.approveOrder(attempt.providerOrderId);
  }
  if (!attempt.providerOrderId) return { outcome: outcomeOf(attempt), outingId: attempt.outingId, paymentAttemptId: attempt.id };
  return completeApproval(db, { attemptId: attempt.id, participantId: input.participantId, orderId: attempt.providerOrderId, now: input.now });
}

/* -------------------------------------------------------------------------- */
/* Withdraw                                                                   */
/* -------------------------------------------------------------------------- */

export interface WithdrawResult {
  withdrawn: true;
  alreadyWithdrawn: boolean;
  voidsPlanned: number;
  earlyCancelScheduled: boolean;
}

/**
 * Withdraw before the deadline: consent withdrawn, attendance WITHDRAWN, any
 * hold planned for VOID. A required participant withdrawing schedules an early
 * cancellation check. Nobody else's share or hold changes.
 */
export async function withdraw(db: Db, input: { outingId: string; participantId: string; now: Date }): Promise<WithdrawResult> {
  const { now } = input;
  const actor = participantActor(input.participantId);
  return db.transaction(async (tx) => {
    const outing = await lockOuting(tx, input.outingId);
    const [participant] = await tx
      .select()
      .from(participants)
      .where(and(eq(participants.id, input.participantId), eq(participants.outingId, outing.id)))
      .for("update");
    if (!participant) throw notFound("Participant not found");
    if (participant.attendance === "WITHDRAWN") return { withdrawn: true, alreadyWithdrawn: true, voidsPlanned: 0, earlyCancelScheduled: false };
    if (participant.attendance === "DECLINED") throw conflict("ALREADY_DECLINED", "You already declined this outing.");
    if (!acceptsNewCommitments(outing, now)) {
      throw conflict(
        "WITHDRAW_CLOSED",
        "Withdrawals close at the commitment deadline. The deadline decision will settle or release payment holds.",
      );
    }

    await tx
      .update(consents)
      .set({ withdrawnAt: now })
      .where(and(eq(consents.participantId, participant.id), eq(consents.outingId, outing.id), isNull(consents.withdrawnAt)));
    await tx.update(participants).set({ attendance: "WITHDRAWN", attendanceAt: now, updatedAt: now }).where(eq(participants.id, participant.id));

    const attempts = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.participantId, participant.id), eq(paymentAttempts.outingId, outing.id)))
      .for("update");
    let voidsPlanned = 0;
    for (const a of attempts) {
      if ((a.status === "AUTHORIZED" || a.status === "UNKNOWN") && a.authorizationId) {
        await planPaymentOperation(tx, {
          outingId: outing.id,
          paymentAttemptId: a.id,
          kind: "VOID",
          amountMinor: a.authorizedMinor,
          currency: a.currency,
        });
        voidsPlanned += 1;
      } else if (a.status === "APPROVAL_PENDING" || a.status === "CREATED") {
        // A later return from PayPal must not authorize: the attempt is closed now.
        await setStatus(tx, a, "FAILED", now, { lastError: "WITHDRAWN: participant withdrew before approval — no hold was placed" });
      }
      // UNKNOWN without an authorization id: reconciliation sees the withdrawn consent and voids anything it finds.
    }

    let earlyCancelScheduled = false;
    if (participant.required) {
      await enqueueJob(tx, {
        kind: "SETTLE_DEADLINE",
        outingId: outing.id,
        runAt: now,
        dedupeKey: `settle-early:${outing.id}`,
        payload: { early: true, reason: "REQUIRED_DECLINED" },
        // An earlier early-cancel job may already be DONE/DEAD (e.g. it ran while still feasible): run again.
        onConflict: "requeue",
      });
      earlyCancelScheduled = true;
    }
    await tx.update(outings).set({ updatedAt: now }).where(eq(outings.id, outing.id));
    await recordAudit(tx, {
      outingId: outing.id,
      actor,
      type: "PARTICIPANT_WITHDRAWN",
      data: { required: participant.required, voidsPlanned, earlyCancelScheduled },
    });
    return { withdrawn: true, alreadyWithdrawn: false, voidsPlanned, earlyCancelScheduled };
  });
}

/* -------------------------------------------------------------------------- */
/* Reconciliation (RECONCILE_PAYMENT job)                                     */
/* -------------------------------------------------------------------------- */

export type ReconcileOutcome = PaymentOutcome | "NOOP";

/**
 * Resolve an attempt left UNKNOWN by order creation or authorization.
 * Returns "PENDING" while the provider is still unreachable — the job handler
 * should then fail the job so it retries with backoff. Idempotent.
 *
 * Holds found here go through the same verification / lateness / race-rule
 * path as a normal return; a late authorization is voided, never admitted.
 */
export async function reconcilePaymentAttempt(db: Db, input: { paymentAttemptId: string; now: Date }): Promise<ReconcileOutcome> {
  const { now } = input;
  const actor: AuditActor = "SYSTEM";
  const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, input.paymentAttemptId) });
  if (!attempt || attempt.authorizationId) return "NOOP";
  // A FAILED attempt that has an order but never recorded a hold is only re-read to find a stray
  // authorization (recorded + voided by recordAuthorization); it is never re-authorized or re-failed.
  const closed = attempt.status === "FAILED";
  if (attempt.status !== "UNKNOWN" && !closed) return "NOOP";
  if (closed && !attempt.providerOrderId) return "NOOP";

  if (!attempt.providerOrderId) {
    // Order creation never confirmed: the buyer never received an approval link, so no hold can exist.
    await failAttempt(db, attempt.id, now, "CREATE_ORDER_UNCONFIRMED: no approval link was issued — no hold can exist", {
      actor,
      type: "PAYMENT_RECONCILED",
      data: { result: "FAILED", stage: "CREATE_ORDER" },
    });
    return "FAILED";
  }

  const provider = providerFor(attempt.provider);
  const read = await safeCall(() => provider.getOrder(attempt.providerOrderId!));
  if (!read.ok) {
    if (read.kind === "UNKNOWN") return "PENDING";
    if (closed) return "NOOP";
    await failAttempt(db, attempt.id, now, `RECONCILE: ${failureNote(read)}`, { actor, type: "PAYMENT_RECONCILED", data: { result: "FAILED", code: read.code } });
    return "FAILED";
  }

  const found = read.order.authorizations;
  if (found.length > 0) {
    // Record (and, if needed, void) every authorization found; the first is the attempt's.
    return recordAuthorization(db, attempt.id, found[0], now, actor);
  }
  if (closed) return "NOOP";

  if (read.order.status === "APPROVED") {
    const outing = await db.query.outings.findFirst({ where: eq(outings.id, attempt.outingId) });
    const consent = await db.query.consents.findFirst({ where: eq(consents.id, attempt.consentId) });
    const admissible = outing && acceptsNewCommitments(outing, now) && consent && !consent.withdrawnAt && attempt.quoteId === outing.currentQuoteId;
    if (admissible) {
      // The authorize call never took effect; retry with the SAME request id (idempotent).
      return authorizeAndRecord(db, attempt, now, actor);
    }
    const late = !!outing && !acceptsNewCommitments(outing, now);
    await failAttempt(
      db,
      attempt.id,
      now,
      late ? "LATE_APPROVAL: approval was not authorized before the deadline — no hold was placed" : "TERMS_CHANGED: consent no longer current — no hold was placed",
      { actor, type: "PAYMENT_RECONCILED", data: { result: late ? "LATE" : "FAILED" } },
      { late },
    );
    return late ? "LATE" : "FAILED";
  }

  await failAttempt(db, attempt.id, now, `RECONCILE: order ${read.order.providerStatus}, no authorization — no hold was placed`, {
    actor,
    type: "PAYMENT_RECONCILED",
    data: { result: "FAILED", orderStatus: read.order.providerStatus },
  });
  return "FAILED";
}
