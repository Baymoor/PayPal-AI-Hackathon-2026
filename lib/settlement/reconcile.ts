/**
 * Reconcile one payment attempt against the provider.
 *
 * Reconciliation is the only way a browser redirect, a timeout or a webhook
 * ever changes what we believe about a hold: we read the order /
 * authorization / refund back from the provider and record those facts. A
 * failed read marks the attempt unverified (fail closed); it never guesses.
 *
 * Provider calls happen OUTSIDE any SQL transaction. Writes lock the attempt
 * row (and, for the straggler-void rule, the outing row) in short transactions.
 */
import { eq } from "drizzle-orm";
import { outings, paymentAttempts, settlementSnapshots, type PaymentAttempt } from "../db/schema";
import type { Db, Tx } from "../db/client";
import type { PaymentStatus } from "../domain/types";
import type { AuthorizationView } from "../payments/provider";
import { planPaymentOperation } from "../payments/plan";
import { reconcilePaymentAttempt } from "../services/payments";
import { recordAudit } from "../audit";
import { assertPaymentPath, lockAttempt, moveAttempt, patchAttempt, truncateError, type AttemptPatch } from "./attempts";
import { plannedCaptureFor, readRoster } from "./snapshot";
import { workerActor, type ProviderResolver } from "./types";

export interface ReconcileAttemptOptions {
  attemptId: string;
  now: Date;
  workerId: string;
  /** Deadline used to flag late authorizations; defaults to the outing's stored deadline. */
  deadlineAt?: Date | null;
  /**
   * Deadline pass only: leave a late hold AUTHORIZED so `decideSettlement` records
   * LATE_AUTHORIZATION and plans the void itself. Everywhere else a late hold is voided at once.
   */
  deferLateVoid?: boolean;
}

export interface ReconcileAttemptResult {
  attempt: PaymentAttempt | null;
  /** Whether the provider read succeeded. SKIPPED: nothing to read for this status. */
  read: "OK" | "FAILED" | "SKIPPED";
  note?: string;
  /** A VOID was planned because the hold is not part of the frozen roster. */
  plannedVoid: boolean;
}

/** Statuses where the only provider handle we may have is the order id. */
const ORDER_STAGE: ReadonlySet<PaymentStatus> = new Set(["CREATED", "APPROVAL_PENDING", "UNKNOWN"]);

function canMove(from: PaymentStatus, to: PaymentStatus): boolean {
  try {
    assertPaymentPath(from, to);
    return true;
  } catch {
    return false;
  }
}

function pickAuthorization(auths: AuthorizationView[]): AuthorizationView | null {
  const rank = (a: AuthorizationView) =>
    a.status === "CREATED" ? 0 : a.status === "CAPTURED" || a.status === "PARTIALLY_CAPTURED" ? 1 : a.status === "PENDING" ? 2 : 3;
  return [...auths].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * Record a provider-observed authorization on the attempt. Locks the row,
 * recomputes the transition from the CURRENT status (another process may
 * have moved it meanwhile) and applies the facts.
 */
export async function applyAuthorizationView(
  db: Db,
  attemptId: string,
  auth: AuthorizationView,
  deadlineAt: Date | null,
  now: Date,
): Promise<{ attempt: PaymentAttempt; note?: string }> {
  return db.transaction(async (tx) => {
    const current = await lockAttempt(tx, attemptId);
    if (!current) throw new Error(`payment attempt ${attemptId} not found`);

    if (current.authorizationId && current.authorizationId !== auth.authorizationId) {
      const note = `provider returned authorization ${auth.authorizationId} but attempt records ${current.authorizationId}`;
      const attempt = await patchAttempt(tx, current.id, { verified: false, verifiedAt: now, lastError: note }, now);
      return { attempt, note };
    }
    const customMismatch = auth.customId !== undefined && auth.customId !== current.id;
    const currencyMismatch = auth.currency !== current.currency;
    if (customMismatch) {
      const note = "authorization custom_id does not match this attempt";
      const attempt = await patchAttempt(tx, current.id, { verified: false, verifiedAt: now, lastError: note }, now);
      return { attempt, note };
    }

    const facts: AttemptPatch = {
      authorizationId: auth.authorizationId,
      providerOrderId: current.providerOrderId ?? auth.orderId,
      authorizedMinor: Math.max(auth.amountMinor, current.capturedMinor),
      authorizedAt: auth.createTime,
      authorizationExpiresAt: auth.expirationTime,
      late: deadlineAt ? auth.createTime.getTime() > deadlineAt.getTime() : current.late,
      providerStatus: auth.providerStatus,
      verified: !currencyMismatch,
      verifiedAt: now,
      lastError: currencyMismatch ? `authorization currency ${auth.currency} does not match ${current.currency}` : null,
    };

    let target: PaymentStatus = current.status;
    let note: string | undefined;
    switch (auth.status) {
      case "CREATED":
        if (ORDER_STAGE.has(current.status)) target = "AUTHORIZED";
        break;
      case "CAPTURED":
      case "PARTIALLY_CAPTURED": {
        const done = auth.captures.find((c) => c.status === "COMPLETED" || c.status === "REFUNDED" || c.status === "PARTIALLY_REFUNDED");
        if (done) {
          facts.captureId = current.captureId ?? done.captureId;
          facts.capturedMinor = Math.max(current.capturedMinor, done.amountMinor);
          if (done.status === "REFUNDED" && current.status === "REFUND_PENDING") {
            facts.refundedMinor = done.amountMinor;
            target = "REFUNDED";
          } else if (current.status !== "CAPTURED" && current.status !== "REFUND_PENDING" && current.status !== "REFUNDED") {
            target = canMove(current.status, "CAPTURED") ? "CAPTURED" : current.status;
            if (target === current.status) note = `capture observed at provider but attempt is ${current.status}`;
          }
        } else {
          const pending = auth.captures.find((c) => c.status === "PENDING");
          if (pending) facts.captureId = current.captureId ?? pending.captureId;
        }
        break;
      }
      case "VOIDED":
      case "EXPIRED":
        note = `authorization ${auth.status.toLowerCase()} at provider`;
        facts.lastError = note;
        target = canMove(current.status, "VOIDED") ? "VOIDED" : canMove(current.status, "FAILED") ? "FAILED" : current.status;
        break;
      case "DENIED":
        note = "authorization denied by provider";
        facts.lastError = note;
        target = canMove(current.status, "FAILED") ? "FAILED" : current.status;
        break;
      default:
        // PENDING / OTHER: readable but not a usable hold.
        facts.verified = false;
        note = `authorization status ${auth.providerStatus} is not usable`;
        facts.lastError = note;
    }

    const attempt =
      target === current.status ? await patchAttempt(tx, current.id, facts, now) : await moveAttempt(tx, current, target, facts, now);
    return { attempt, note };
  });
}

async function markReadFailure(db: Db, attempt: PaymentAttempt, message: string, now: Date): Promise<PaymentAttempt> {
  // Only an AUTHORIZED hold loses its "verified" flag: that is what makes the policy fail closed.
  const patch: AttemptPatch = { lastError: truncateError(message) };
  if (attempt.status === "AUTHORIZED") {
    patch.verified = false;
    patch.verifiedAt = now;
  }
  return patchAttempt(db, attempt.id, patch, now);
}

/**
 * If a verified hold exists but the roster is frozen without it (late
 * authorization, authorization recorded after the snapshot, cancelled
 * outing), plan a VOID. Locks the outing row so it serialises with the
 * decision transaction and with the payments service.
 */
export async function voidIfNotOnRoster(
  db: Db,
  attemptId: string,
  ctx: { now: Date; workerId: string; deferLateVoid?: boolean },
): Promise<boolean> {
  // Cheap pre-check without locks; the locked re-read below is authoritative.
  const peek = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId), columns: { outingId: true, status: true } });
  if (!peek || peek.status !== "AUTHORIZED") return false;
  return db.transaction(async (tx) => {
    // Lock order everywhere in the engine: outing row first, then attempt rows (prevents deadlocks
    // with the decision transaction, which holds the outing lock while updating attempts).
    const [outing] = await tx.select().from(outings).where(eq(outings.id, peek.outingId)).for("update");
    if (!outing) return false;
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.status !== "AUTHORIZED") return false;
    const snapshot = await tx.query.settlementSnapshots.findFirst({ where: eq(settlementSnapshots.outingId, outing.id) });
    const lateHold = attempt.late && !ctx.deferLateVoid;
    if (!snapshot && outing.status === "COLLECTING" && !lateHold) return false;
    if (snapshot && plannedCaptureFor(readRoster(snapshot), attempt.id)) return false;
    await planVoid(tx, attempt, ctx.now);
    await recordAudit(tx, {
      outingId: outing.id,
      actor: workerActor(ctx.workerId),
      type: attempt.late ? "LATE_AUTHORIZATION_VOID_PLANNED" : "STRAGGLER_HOLD_VOID_PLANNED",
      data: { paymentAttemptId: attempt.id, participantId: attempt.participantId, outingStatus: outing.status, hasSnapshot: Boolean(snapshot) },
    });
    return true;
  });
}

export async function planVoid(tx: Tx, attempt: PaymentAttempt, now: Date): Promise<void> {
  await planPaymentOperation(tx, {
    outingId: attempt.outingId,
    paymentAttemptId: attempt.id,
    kind: "VOID",
    amountMinor: Math.max(0, attempt.authorizedMinor - attempt.capturedMinor),
    currency: attempt.currency,
    runAt: now,
  });
}

/** Reconcile one attempt. Safe to call concurrently and repeatedly. */
export async function reconcileAttempt(
  db: Db,
  resolveProvider: ProviderResolver,
  opts: ReconcileAttemptOptions,
): Promise<ReconcileAttemptResult> {
  const { now } = opts;
  let attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, opts.attemptId) });
  if (!attempt) return { attempt: null, read: "SKIPPED", note: "attempt not found", plannedVoid: false };

  let deadlineAt = opts.deadlineAt ?? null;
  if (deadlineAt === null && opts.deadlineAt === undefined) {
    const outing = await db.query.outings.findFirst({ where: eq(outings.id, attempt.outingId), columns: { deadlineAt: true } });
    deadlineAt = outing?.deadlineAt ?? null;
  }
  const provider = resolveProvider(attempt.provider);

  let read: ReconcileAttemptResult["read"] = "SKIPPED";
  let note: string | undefined;

  if (attempt.status === "VOIDED" || attempt.status === "REFUNDED") {
    // Terminal; nothing to learn.
  } else if (attempt.authorizationId) {
    const res = await provider.getAuthorization(attempt.authorizationId);
    if (!res.ok) {
      read = "FAILED";
      note = `getAuthorization failed: ${res.code}`;
      attempt = await markReadFailure(db, attempt, note, now);
    } else {
      read = "OK";
      ({ attempt, note } = await applyAuthorizationView(db, attempt.id, res.authorization, deadlineAt, now));
    }
  } else if (attempt.status === "UNKNOWN" || (attempt.status === "FAILED" && attempt.providerOrderId)) {
    // An order-creation or authorize call whose outcome we never saw. The payments service owns
    // that stage (it can re-send authorize with its own stable request id): no order -> FAILED,
    // order without authorization -> re-authorize if still admissible, else FAILED; an
    // authorization found is recorded through its race rule (late -> VOID). A FAILED attempt
    // that never recorded a hold is only re-read for a stray authorization (recorded + voided).
    const outcome = await reconcilePaymentAttempt(db, { paymentAttemptId: attempt.id, now });
    if (outcome === "PENDING") {
      read = "FAILED";
      note = "provider unreachable; attempt stays UNKNOWN";
    } else {
      read = "OK";
      note = `payments service reconciled: ${outcome}`;
    }
    attempt = (await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attempt.id) })) ?? attempt;
  } else if (attempt.providerOrderId && ORDER_STAGE.has(attempt.status)) {
    const res = await provider.getOrder(attempt.providerOrderId);
    if (!res.ok) {
      read = "FAILED";
      note = `getOrder failed: ${res.code}`;
      attempt = await markReadFailure(db, attempt, note, now);
    } else {
      read = "OK";
      const order = res.order;
      const auth = pickAuthorization(order.authorizations);
      if (order.customId !== undefined && order.customId !== attempt.id) {
        note = "order custom_id does not match this attempt";
        attempt = await patchAttempt(db, attempt.id, { verified: false, verifiedAt: now, lastError: note }, now);
      } else if (auth) {
        ({ attempt, note } = await applyAuthorizationView(db, attempt.id, auth, deadlineAt, now));
      } else {
        // No authorization exists: nothing is held. Record what the order says.
        attempt = await db.transaction(async (tx) => {
          const current = await lockAttempt(tx, attempt!.id);
          if (!current) throw new Error("attempt vanished");
          const facts: AttemptPatch = { providerStatus: order.providerStatus, verifiedAt: now };
          if (order.status === "VOIDED" && canMove(current.status, "FAILED")) {
            return moveAttempt(tx, current, "FAILED", { ...facts, lastError: "order voided at provider before authorization" }, now);
          }
          if (current.status === "UNKNOWN" && canMove(current.status, "APPROVAL_PENDING")) {
            return moveAttempt(tx, current, "APPROVAL_PENDING", { ...facts, lastError: null }, now);
          }
          return patchAttempt(tx, current.id, facts, now);
        });
      }
    }
  }

  // Refunds that were pending: poll the refund itself.
  if (attempt.status === "REFUND_PENDING" && attempt.refundId) {
    const res = await provider.getRefund(attempt.refundId);
    if (res.ok) {
      read = read === "FAILED" ? "FAILED" : "OK";
      if (res.refund.status === "COMPLETED") {
        attempt = await db.transaction(async (tx) => {
          const current = await lockAttempt(tx, attempt!.id);
          if (!current || current.status !== "REFUND_PENDING") return current ?? attempt!;
          return moveAttempt(
            tx,
            current,
            "REFUNDED",
            { refundedMinor: Math.min(current.capturedMinor, res.refund.amountMinor), providerStatus: res.refund.providerStatus, lastError: null },
            now,
          );
        });
      }
    } else if (read !== "FAILED") {
      read = "FAILED";
      note = `getRefund failed: ${res.code}`;
    }
  }

  const plannedVoid = await voidIfNotOnRoster(db, attempt.id, { now, workerId: opts.workerId, deferLateVoid: opts.deferLateVoid });
  if (plannedVoid) attempt = (await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attempt.id) })) ?? attempt;
  return { attempt, read, note, plannedVoid };
}
