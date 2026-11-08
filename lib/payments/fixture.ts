/**
 * FIXTURE payment simulator, labelled "Fixture · not real PayPal".
 *
 * A deterministic, persistent stand-in for PayPal Orders v2 / Payments v2 used
 * only in clearly labelled demo mode (DEMO_FIXTURES_ENABLED=true, no PayPal
 * credentials) and in tests. No money moves and nothing here is ever presented
 * as PayPal sandbox output.
 *
 * State lives in the `fixture_provider_objects` table so the web app and the
 * worker share it. Semantics deliberately mirror PayPal:
 * - every mutation is idempotent on `requestId` (a REQUEST row stores the
 *   original successful result, which is replayed verbatim);
 * - an order must be approved by the buyer before it can be authorized; the
 *   only way to approve is our own fixture approval page
 *   (`/o/<outingId>/pay/fixture?attempt=<attemptId>`);
 * - authorizations are valid for 29 days from their server-side create_time;
 * - one capture per authorization, `final_capture` semantics: capture <=
 *   authorized, and the uncaptured remainder is released;
 * - a captured authorization cannot be voided (PREVIOUSLY_CAPTURED);
 * - refunds <= captured - refunded.
 *
 * Failure injection (`setFixtureFailure`) lets demos/tests force a DECLINE,
 * a TIMEOUT_AFTER (operation applied, response "lost" -> UNKNOWN) or a
 * PENDING capture/refund for a specific authorization.
 */
import { FIXTURE_PAYMENT_LABEL } from "../domain/labels";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { fixtureProviderObjects, paymentAttempts } from "../db/schema";
import { getDb, type Db, type Tx } from "../db/client";
import { isCurrency, type Currency } from "../domain/money";
import type {
  AuthorizationStatus,
  AuthorizationView,
  CaptureStatus,
  CaptureView,
  CreatedOrder,
  CreateOrderInput,
  OrderStatus,
  OrderView,
  PaymentProvider,
  ProviderFailure,
  ProviderFailureKind,
  ProviderResult,
  RefundStatus,
  RefundView,
} from "./provider";

/** Kept as an alias: the one spelling lives in lib/domain/labels.ts. */
export const FIXTURE_PROVIDER_LABEL = FIXTURE_PAYMENT_LABEL;
/** Fixture authorizations mirror PayPal's 29-day validity. */
export const FIXTURE_AUTHORIZATION_VALIDITY_MS = 29 * 24 * 60 * 60 * 1000;

export type FixtureOperation = "CAPTURE" | "VOID" | "REFUND";
export type FixtureFailureMode = "DECLINE" | "TIMEOUT_AFTER" | "PENDING";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FixtureOrder {
  orderId: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
  intent: "AUTHORIZE";
  amountMinor: number;
  currency: Currency;
  customId: string;
  invoiceId: string;
  description: string;
  payeeMerchantId?: string;
  outingId: string;
  approveUrl: string;
  createTime: string;
  approvedAt?: string;
  authorizationId?: string;
}

interface FixtureAuthorization {
  authorizationId: string;
  orderId: string;
  status: "CREATED" | "CAPTURED" | "VOIDED";
  amountMinor: number;
  currency: Currency;
  customId: string;
  payeeMerchantId?: string;
  createTime: string;
  expirationTime: string;
  capturedMinor: number;
  /** Uncaptured remainder released by the final capture. */
  releasedMinor: number;
  captureIds: string[];
  voidedAt?: string;
  failures?: Partial<Record<FixtureOperation, FixtureFailureMode>>;
}

interface FixtureCapture {
  captureId: string;
  authorizationId: string;
  orderId: string;
  status: "COMPLETED" | "PENDING" | "DECLINED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  amountMinor: number;
  currency: Currency;
  finalCapture: true;
  createTime: string;
  /** Includes amounts of PENDING refunds (reserved). */
  refundedMinor: number;
  refundIds: string[];
}

interface FixtureRefund {
  refundId: string;
  captureId: string;
  status: "COMPLETED" | "PENDING" | "FAILED";
  amountMinor: number;
  currency: Currency;
  createTime: string;
}

interface FixtureRequest {
  op: string;
  target: string;
  result: unknown;
}

type ObjKind = "ORDER" | "AUTHORIZATION" | "CAPTURE" | "REFUND" | "REQUEST";

interface Outcome<T> {
  result: ProviderResult<T>;
  /** Store a REQUEST row so the same requestId replays this result. */
  persist?: boolean;
  /** Target resource id recorded with the request (replay must match). */
  target: string;
  /** Applied, but the "response is lost": caller sees UNKNOWN. */
  timeoutAfter?: boolean;
}

function fail(kind: ProviderFailureKind, code: string, message: string, httpStatus = kind === "UNKNOWN" ? 504 : 422): ProviderFailure {
  return { ok: false, kind, code, message: `${message} (fixture)`, httpStatus, debugId: "fixture" };
}

function newId(prefix: string): string {
  // Visibly fixture ids: FX<kind>-<16 upper hex>
  return `${prefix}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

const DATE_KEYS = new Set(["createTime", "expirationTime"]);
function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = DATE_KEYS.has(k) && typeof v === "string" ? new Date(v) : reviveDates(v);
    }
    return out;
  }
  return value;
}

async function lockRow<T>(tx: Tx, id: string, kind: ObjKind): Promise<T | null> {
  const rows = await tx.select().from(fixtureProviderObjects).where(eq(fixtureProviderObjects.id, id)).for("update");
  const row = rows[0];
  if (!row || row.kind !== kind) return null;
  return row.data as T;
}

async function readRow<T>(db: Db | Tx, id: string, kind: ObjKind): Promise<T | null> {
  const rows = await db.select().from(fixtureProviderObjects).where(eq(fixtureProviderObjects.id, id));
  const row = rows[0];
  if (!row || row.kind !== kind) return null;
  return row.data as T;
}

async function insertRow(tx: Tx, id: string, kind: ObjKind, data: unknown): Promise<void> {
  await tx.insert(fixtureProviderObjects).values({ id, kind, data });
}

async function saveRow(tx: Tx, id: string, data: unknown): Promise<void> {
  await tx.update(fixtureProviderObjects).set({ data, updatedAt: new Date() }).where(eq(fixtureProviderObjects.id, id));
}

const requestKey = (requestId: string) => `REQ:${requestId}`;

export interface FixtureProviderOptions {
  /** Database (or a getter). Defaults to the app's shared pool. */
  db?: Db | (() => Db);
  /** Server clock. Injected by tests. */
  now?: () => Date;
}

export class FixtureProvider implements PaymentProvider {
  readonly name = "FIXTURE" as const;
  readonly label = FIXTURE_PROVIDER_LABEL;

  private readonly getDbHandle: () => Db;
  private readonly clock: () => Date;

  constructor(opts: FixtureProviderOptions = {}) {
    const d = opts.db;
    this.getDbHandle = typeof d === "function" ? d : d ? () => d : getDb;
    this.clock = opts.now ?? (() => new Date());
  }

  private get db(): Db {
    return this.getDbHandle();
  }

  /**
   * Run one idempotent mutation: serialise on the request id, replay a stored
   * result for a known request id, otherwise apply and (on success) store it.
   */
  private async mutate<T>(op: string, requestId: string, target: string, run: (tx: Tx, now: Date) => Promise<Outcome<T>>): Promise<ProviderResult<T>> {
    if (!requestId) return fail("INVALID", "MISSING_REQUEST_ID", "PayPal-Request-Id is required", 400);
    const out = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"fixture-req:" + requestId}))`);
      const existing = await lockRow<FixtureRequest>(tx, requestKey(requestId), "REQUEST");
      if (existing) {
        if (existing.op !== op || existing.target !== target) {
          return { result: fail("INVALID", "DUPLICATE_REQUEST_ID", "requestId was already used for a different operation", 422), target } as Outcome<T>;
        }
        return { result: reviveDates(existing.result) as ProviderResult<T>, target } as Outcome<T>;
      }
      const o = await run(tx, this.clock());
      if (o.persist && o.result.ok) {
        await insertRow(tx, requestKey(requestId), "REQUEST", { op, target: o.target, result: o.result } satisfies FixtureRequest);
      }
      return o;
    });
    if (out.timeoutAfter) return fail("UNKNOWN", "TIMEOUT", "Simulated timeout after the operation was applied", 504);
    return out.result;
  }

  /* ------------------------------- views -------------------------------- */

  private authStatus(a: FixtureAuthorization, now: Date): AuthorizationStatus {
    if (a.status === "CREATED" && now.getTime() >= new Date(a.expirationTime).getTime()) return "EXPIRED";
    return a.status;
  }

  private captureView(c: FixtureCapture): CaptureView {
    return {
      captureId: c.captureId,
      status: c.status as CaptureStatus,
      providerStatus: c.status,
      amountMinor: c.amountMinor,
      currency: c.currency,
      finalCapture: c.finalCapture,
      createTime: new Date(c.createTime),
    };
  }

  private authView(a: FixtureAuthorization, now: Date, captures: CaptureView[]): AuthorizationView {
    const status = this.authStatus(a, now);
    return {
      orderId: a.orderId,
      authorizationId: a.authorizationId,
      status,
      providerStatus: status,
      amountMinor: a.amountMinor,
      currency: a.currency,
      createTime: new Date(a.createTime),
      expirationTime: new Date(a.expirationTime),
      customId: a.customId,
      payeeMerchantId: a.payeeMerchantId,
      captures,
    };
  }

  private refundView(r: FixtureRefund): RefundView {
    return { refundId: r.refundId, status: r.status as RefundStatus, providerStatus: r.status, amountMinor: r.amountMinor, currency: r.currency };
  }

  private async capturesOf(db: Db | Tx, a: FixtureAuthorization): Promise<CaptureView[]> {
    const out: CaptureView[] = [];
    for (const id of a.captureIds) {
      const c = await readRow<FixtureCapture>(db, id, "CAPTURE");
      if (c) out.push(this.captureView(c));
    }
    return out;
  }

  /* ------------------------------- port --------------------------------- */

  async createAuthorizeOrder(input: CreateOrderInput): Promise<ProviderResult<CreatedOrder>> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      return fail("INVALID", "INVALID_PARAMETER_VALUE", "amount must be a positive integer", 400);
    }
    if (!isCurrency(input.currency)) return fail("INVALID", "INVALID_CURRENCY_CODE", "unsupported currency", 400);
    if (!UUID_RE.test(input.paymentAttemptId)) return fail("INVALID", "INVALID_PARAMETER_VALUE", "custom_id must be a payment attempt id", 400);

    return this.mutate<CreatedOrder>("CREATE_ORDER", input.requestId, input.paymentAttemptId, async (tx, now) => {
      const attempt = await tx.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, input.paymentAttemptId) });
      if (!attempt) return { result: fail("INVALID", "INVALID_PARAMETER_VALUE", "unknown payment attempt", 400), target: input.paymentAttemptId };
      const orderId = newId("FXORD");
      const approveUrl = `/o/${attempt.outingId}/pay/fixture?attempt=${attempt.id}`;
      const order: FixtureOrder = {
        orderId,
        status: "PAYER_ACTION_REQUIRED",
        intent: "AUTHORIZE",
        amountMinor: input.amountMinor,
        currency: input.currency,
        customId: input.paymentAttemptId,
        invoiceId: `OUTINGS-${input.paymentAttemptId}`,
        description: input.description.slice(0, 127),
        payeeMerchantId: input.payeeMerchantId,
        outingId: attempt.outingId,
        approveUrl,
        createTime: now.toISOString(),
      };
      await insertRow(tx, orderId, "ORDER", order);
      return {
        result: { ok: true, orderId, providerStatus: order.status, approveUrl },
        persist: true,
        target: input.paymentAttemptId,
      };
    });
  }

  /**
   * Buyer approval — FIXTURE ONLY. Called by the payment service after it has
   * verified that the signed-in participant owns the attempt. There is no
   * other way to approve a fixture order.
   */
  async approveOrder(orderId: string): Promise<{ ok: boolean; status: string }> {
    return this.db.transaction(async (tx) => {
      const order = await lockRow<FixtureOrder>(tx, orderId, "ORDER");
      if (!order) return { ok: false, status: "NOT_FOUND" };
      if (order.status === "PAYER_ACTION_REQUIRED") {
        order.status = "APPROVED";
        order.approvedAt = this.clock().toISOString();
        await saveRow(tx, orderId, order);
      }
      return { ok: true, status: order.status };
    });
  }

  async authorizeOrder(input: { orderId: string; requestId: string }): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    return this.mutate<{ authorization: AuthorizationView }>("AUTHORIZE", input.requestId, input.orderId, async (tx, now) => {
      const target = input.orderId;
      const order = await lockRow<FixtureOrder>(tx, input.orderId, "ORDER");
      if (!order) return { result: fail("INVALID", "RESOURCE_NOT_FOUND", "order not found", 404), target };
      if (order.status === "PAYER_ACTION_REQUIRED") {
        return { result: fail("INVALID", "ORDER_NOT_APPROVED", "the buyer has not approved this order"), target };
      }
      if (order.status === "COMPLETED") {
        return { result: fail("INVALID", "ORDER_ALREADY_AUTHORIZED", "order already authorized"), target };
      }
      const authorizationId = newId("FXAUTH");
      const auth: FixtureAuthorization = {
        authorizationId,
        orderId: order.orderId,
        status: "CREATED",
        amountMinor: order.amountMinor,
        currency: order.currency,
        customId: order.customId,
        payeeMerchantId: order.payeeMerchantId,
        // Server time of the authorization is the verified completion timestamp.
        createTime: now.toISOString(),
        expirationTime: new Date(now.getTime() + FIXTURE_AUTHORIZATION_VALIDITY_MS).toISOString(),
        capturedMinor: 0,
        releasedMinor: 0,
        captureIds: [],
      };
      await insertRow(tx, authorizationId, "AUTHORIZATION", auth);
      order.status = "COMPLETED";
      order.authorizationId = authorizationId;
      await saveRow(tx, order.orderId, order);
      return { result: { ok: true, authorization: this.authView(auth, now, []) }, persist: true, target };
    });
  }

  async getOrder(orderId: string): Promise<ProviderResult<{ order: OrderView }>> {
    const order = await readRow<FixtureOrder>(this.db, orderId, "ORDER");
    if (!order) return fail("INVALID", "RESOURCE_NOT_FOUND", "order not found", 404);
    const now = this.clock();
    const authorizations: AuthorizationView[] = [];
    if (order.authorizationId) {
      const a = await readRow<FixtureAuthorization>(this.db, order.authorizationId, "AUTHORIZATION");
      if (a) authorizations.push(this.authView(a, now, await this.capturesOf(this.db, a)));
    }
    return {
      ok: true,
      order: {
        orderId: order.orderId,
        status: order.status as OrderStatus,
        providerStatus: order.status,
        intent: order.intent,
        amountMinor: order.amountMinor,
        currency: order.currency,
        customId: order.customId,
        authorizations,
      },
    };
  }

  async getAuthorization(authorizationId: string): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    const a = await readRow<FixtureAuthorization>(this.db, authorizationId, "AUTHORIZATION");
    if (!a) return fail("INVALID", "RESOURCE_NOT_FOUND", "authorization not found", 404);
    // Captures are attached (the PayPal adapter does the same by also reading the order).
    return { ok: true, authorization: this.authView(a, this.clock(), await this.capturesOf(this.db, a)) };
  }

  async captureAuthorization(input: {
    authorizationId: string;
    amountMinor: number;
    currency: Currency;
    requestId: string;
    invoiceId?: string;
    noteToPayer?: string;
  }): Promise<ProviderResult<{ capture: CaptureView }>> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      return fail("INVALID", "INVALID_PARAMETER_VALUE", "capture amount must be a positive integer", 400);
    }
    return this.mutate<{ capture: CaptureView }>("CAPTURE", input.requestId, input.authorizationId, async (tx, now) => {
      const target = input.authorizationId;
      const a = await lockRow<FixtureAuthorization>(tx, input.authorizationId, "AUTHORIZATION");
      if (!a) return { result: fail("INVALID", "RESOURCE_NOT_FOUND", "authorization not found", 404), target };
      const injected = a.failures?.CAPTURE;
      if (injected === "DECLINE") {
        return { result: fail("DECLINED", "INSTRUMENT_DECLINED", "Injected decline: the funding instrument was declined"), target };
      }
      const status = this.authStatus(a, now);
      if (status === "VOIDED") return { result: fail("DECLINED", "AUTHORIZATION_VOIDED", "the authorization was voided"), target };
      if (status === "EXPIRED") return { result: fail("DECLINED", "AUTHORIZATION_EXPIRED", "the authorization has expired"), target };
      if (status === "CAPTURED") {
        return { result: fail("INVALID", "AUTHORIZATION_ALREADY_CAPTURED", "a final capture was already made"), target };
      }
      if (input.currency !== a.currency) return { result: fail("INVALID", "CURRENCY_MISMATCH", "currency must match the authorization"), target };
      if (input.amountMinor > a.amountMinor) {
        return {
          result: fail("INVALID", "MAX_CAPTURE_AMOUNT_EXCEEDED", "You can only capture up to the original authorization amount"),
          target,
        };
      }
      const capture: FixtureCapture = {
        captureId: newId("FXCAP"),
        authorizationId: a.authorizationId,
        orderId: a.orderId,
        status: injected === "PENDING" ? "PENDING" : "COMPLETED",
        amountMinor: input.amountMinor,
        currency: a.currency,
        finalCapture: true,
        createTime: now.toISOString(),
        refundedMinor: 0,
        refundIds: [],
      };
      await insertRow(tx, capture.captureId, "CAPTURE", capture);
      // final_capture: the authorization is closed and the remainder released.
      a.status = "CAPTURED";
      a.capturedMinor = input.amountMinor;
      a.releasedMinor = a.amountMinor - input.amountMinor;
      a.captureIds = [...a.captureIds, capture.captureId];
      await saveRow(tx, a.authorizationId, a);
      return { result: { ok: true, capture: this.captureView(capture) }, persist: true, target, timeoutAfter: injected === "TIMEOUT_AFTER" };
    });
  }

  async voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<ProviderResult<{ providerStatus: string }>> {
    return this.mutate<{ providerStatus: string }>("VOID", input.requestId, input.authorizationId, async (tx, now) => {
      const target = input.authorizationId;
      const a = await lockRow<FixtureAuthorization>(tx, input.authorizationId, "AUTHORIZATION");
      if (!a) return { result: fail("INVALID", "RESOURCE_NOT_FOUND", "authorization not found", 404), target };
      const injected = a.failures?.VOID;
      if (injected === "DECLINE") return { result: fail("DECLINED", "VOID_REFUSED", "Injected failure: the void was refused"), target };
      if (a.status === "CAPTURED") {
        return { result: fail("INVALID", "PREVIOUSLY_CAPTURED", "Authorization has been previously captured and cannot be voided"), target };
      }
      if (a.status !== "VOIDED") {
        // CREATED, or expired (an expired hold is released either way).
        a.status = "VOIDED";
        a.voidedAt = now.toISOString();
        await saveRow(tx, a.authorizationId, a);
      }
      return { result: { ok: true, providerStatus: "VOIDED" }, persist: true, target, timeoutAfter: injected === "TIMEOUT_AFTER" };
    });
  }

  async refundCapture(input: {
    captureId: string;
    amountMinor: number;
    currency: Currency;
    requestId: string;
    noteToPayer?: string;
  }): Promise<ProviderResult<{ refund: RefundView }>> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      return fail("INVALID", "INVALID_PARAMETER_VALUE", "refund amount must be a positive integer", 400);
    }
    return this.mutate<{ refund: RefundView }>("REFUND", input.requestId, input.captureId, async (tx, now) => {
      const target = input.captureId;
      const c = await lockRow<FixtureCapture>(tx, input.captureId, "CAPTURE");
      if (!c) return { result: fail("INVALID", "RESOURCE_NOT_FOUND", "capture not found", 404), target };
      const a = await readRow<FixtureAuthorization>(tx, c.authorizationId, "AUTHORIZATION");
      const injected = a?.failures?.REFUND;
      if (injected === "DECLINE") return { result: fail("DECLINED", "TRANSACTION_REFUSED", "Injected failure: the refund was refused"), target };
      if (c.status !== "COMPLETED" && c.status !== "PARTIALLY_REFUNDED") {
        return { result: fail("INVALID", "CAPTURE_NOT_REFUNDABLE", `capture is ${c.status}`), target };
      }
      if (input.currency !== c.currency) return { result: fail("INVALID", "CURRENCY_MISMATCH", "currency must match the capture"), target };
      if (input.amountMinor > c.amountMinor - c.refundedMinor) {
        return {
          result: fail("INVALID", "REFUND_AMOUNT_EXCEEDED", "refund must be less than or equal to the capture amount not yet refunded"),
          target,
        };
      }
      const refund: FixtureRefund = {
        refundId: newId("FXREF"),
        captureId: c.captureId,
        status: injected === "PENDING" ? "PENDING" : "COMPLETED",
        amountMinor: input.amountMinor,
        currency: c.currency,
        createTime: now.toISOString(),
      };
      await insertRow(tx, refund.refundId, "REFUND", refund);
      c.refundedMinor += input.amountMinor; // reserved even while PENDING (no double refunds)
      c.refundIds = [...c.refundIds, refund.refundId];
      if (refund.status === "COMPLETED") c.status = c.refundedMinor === c.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
      await saveRow(tx, c.captureId, c);
      return { result: { ok: true, refund: this.refundView(refund) }, persist: true, target, timeoutAfter: injected === "TIMEOUT_AFTER" };
    });
  }

  async getRefund(refundId: string): Promise<ProviderResult<{ refund: RefundView }>> {
    const r = await readRow<FixtureRefund>(this.db, refundId, "REFUND");
    if (!r) return fail("INVALID", "RESOURCE_NOT_FOUND", "refund not found", 404);
    return { ok: true, refund: this.refundView(r) };
  }

  /** FIXTURE has no external webhooks: nothing is ever verified. */
  async verifyWebhook(): Promise<ProviderResult<{ verified: boolean }>> {
    return { ok: true, verified: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Demo / test helpers (FIXTURE only)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Force the next capture / void / refund on `authorizationId` to fail.
 * - DECLINE: provider refuses (terminal), nothing changes.
 * - TIMEOUT_AFTER: the operation IS applied, but the caller sees UNKNOWN
 *   (reconcile by reading back, or retry with the same requestId -> replay).
 * - PENDING: capture/refund is created with status PENDING (resolve with
 *   `resolveFixturePending`). Not valid for VOID (PayPal voids never pend).
 * Stays in effect until `clearFixtureFailure`.
 */
export async function setFixtureFailure(
  db: Db,
  input: { authorizationId: string; operation: FixtureOperation; mode: FixtureFailureMode },
): Promise<void> {
  if (input.operation === "VOID" && input.mode === "PENDING") throw new Error("PayPal voids have no PENDING state");
  await db.transaction(async (tx) => {
    const a = await lockRow<FixtureAuthorization>(tx, input.authorizationId, "AUTHORIZATION");
    if (!a) throw new Error(`fixture authorization ${input.authorizationId} not found`);
    a.failures = { ...(a.failures ?? {}), [input.operation]: input.mode };
    await saveRow(tx, a.authorizationId, a);
  });
}

export async function clearFixtureFailure(db: Db, input: { authorizationId: string; operation?: FixtureOperation }): Promise<void> {
  await db.transaction(async (tx) => {
    const a = await lockRow<FixtureAuthorization>(tx, input.authorizationId, "AUTHORIZATION");
    if (!a) return;
    if (input.operation) {
      const next = { ...(a.failures ?? {}) };
      delete next[input.operation];
      a.failures = next;
    } else {
      a.failures = {};
    }
    await saveRow(tx, a.authorizationId, a);
  });
}

/** Settle a PENDING fixture capture or refund (simulates the later webhook / GET outcome). */
export async function resolveFixturePending(
  db: Db,
  input: { kind: "CAPTURE"; captureId: string; outcome: "COMPLETED" | "DECLINED" } | { kind: "REFUND"; refundId: string; outcome: "COMPLETED" | "FAILED" },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.kind === "CAPTURE") {
      const c = await lockRow<FixtureCapture>(tx, input.captureId, "CAPTURE");
      if (!c || c.status !== "PENDING") throw new Error("no PENDING fixture capture with that id");
      c.status = input.outcome;
      await saveRow(tx, c.captureId, c);
      if (input.outcome === "DECLINED") {
        // The money never moved; the hold is still valid and must be voided by the caller.
        const a = await lockRow<FixtureAuthorization>(tx, c.authorizationId, "AUTHORIZATION");
        if (a) {
          a.status = "CREATED";
          a.capturedMinor = 0;
          a.releasedMinor = 0;
          await saveRow(tx, a.authorizationId, a);
        }
      }
      return;
    }
    const r = await lockRow<FixtureRefund>(tx, input.refundId, "REFUND");
    if (!r || r.status !== "PENDING") throw new Error("no PENDING fixture refund with that id");
    r.status = input.outcome;
    await saveRow(tx, r.refundId, r);
    const c = await lockRow<FixtureCapture>(tx, r.captureId, "CAPTURE");
    if (c) {
      if (input.outcome === "FAILED") c.refundedMinor -= r.amountMinor;
      const completedRefunded = c.refundedMinor;
      if (completedRefunded > 0) c.status = completedRefunded === c.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
      await saveRow(tx, c.captureId, c);
    }
  });
}

/** Read-only peek used by tests and the demo tooling. */
export async function readFixtureObject(db: Db, id: string): Promise<{ kind: string; data: unknown } | null> {
  const rows = await db
    .select({ kind: fixtureProviderObjects.kind, data: fixtureProviderObjects.data })
    .from(fixtureProviderObjects)
    .where(and(eq(fixtureProviderObjects.id, id)));
  return rows[0] ?? null;
}
