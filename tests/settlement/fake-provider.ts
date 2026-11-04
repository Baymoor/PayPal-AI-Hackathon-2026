/**
 * In-memory PaymentProvider for settlement tests, with failure injection.
 *
 * Models the parts of PayPal that matter for correctness: idempotent replay
 * by requestId, one capture per authorization, void/refund state, and the
 * three ways a call can go wrong (definitive decline, timeout BEFORE the
 * provider acted, timeout AFTER the provider acted).
 */
import type { Currency } from "@/lib/domain/money";
import type { PaymentProviderName } from "@/lib/domain/types";
import type {
  AuthorizationStatus,
  AuthorizationView,
  CaptureView,
  CreateOrderInput,
  CreatedOrder,
  OrderView,
  PaymentProvider,
  ProviderFailure,
  ProviderResult,
  RefundView,
} from "@/lib/payments/provider";

interface FakeAuth {
  orderId: string;
  authorizationId: string;
  status: AuthorizationStatus;
  amountMinor: number;
  currency: Currency;
  createTime: Date;
  expirationTime: Date | null;
  customId?: string;
  captureIds: string[];
}

interface FakeCapture {
  captureId: string;
  authorizationId: string;
  status: CaptureView["status"];
  amountMinor: number;
  currency: Currency;
  refundedMinor: number;
  createTime: Date;
}

interface FakeRefund {
  refundId: string;
  captureId: string;
  status: RefundView["status"];
  amountMinor: number;
  currency: Currency;
}

export type FakeOpKind = "capture" | "void" | "refund";

export interface FakeCalls {
  createOrder: number;
  authorize: number;
  getOrder: number;
  getAuthorization: number;
  capture: number;
  void: number;
  refund: number;
  getRefund: number;
  verifyWebhook: number;
}

function unknown(message: string): ProviderFailure {
  return { ok: false, kind: "UNKNOWN", code: "TIMEOUT", message, httpStatus: 504 };
}
function invalid(code: string, message: string): ProviderFailure {
  return { ok: false, kind: "INVALID", code, message, httpStatus: 422 };
}
function declined(code: string, message: string): ProviderFailure {
  return { ok: false, kind: "DECLINED", code, message, httpStatus: 422 };
}

export class FakeProvider implements PaymentProvider {
  readonly name: PaymentProviderName;
  readonly label = "Fake provider (tests)";

  readonly orders = new Map<string, { orderId: string; amountMinor: number; currency: Currency; customId?: string; authorizationIds: string[]; status: OrderView["status"] }>();
  readonly auths = new Map<string, FakeAuth>();
  readonly captures = new Map<string, FakeCapture>();
  readonly refunds = new Map<string, FakeRefund>();
  /** Idempotency store: requestId -> result. */
  readonly requests = new Map<string, ProviderResult<unknown>>();

  readonly calls: FakeCalls = { createOrder: 0, authorize: 0, getOrder: 0, getAuthorization: 0, capture: 0, void: 0, refund: 0, getRefund: 0, verifyWebhook: 0 };
  /** Capture requests actually PERFORMED per authorization (replays excluded). */
  readonly capturesPerformed = new Map<string, number>();
  readonly voidsPerformed = new Map<string, number>();
  readonly refundsPerformed = new Map<string, number>();

  // Failure injection
  private declineCaptureFor = new Map<string, string>();
  private timeoutAfterKeys = new Set<string>();
  private timeoutBeforeKeys = new Set<string>();
  private alwaysTimeoutKeys = new Set<string>();
  private pendingRefundCaptures = new Set<string>();
  readsFail = false;
  webhookVerified = true;
  /** Artificial latency on mutating calls (widens race windows in concurrency tests). */
  latencyMs = 0;

  private seq = 0;

  constructor(name: PaymentProviderName = "PAYPAL") {
    this.name = name;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString(36).padStart(4, "0")}`;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  /* ----------------------------- test controls ---------------------------- */

  seedAuthorization(input: {
    authorizationId: string;
    orderId?: string;
    amountMinor: number;
    currency?: Currency;
    createTime: Date;
    expirationTime?: Date | null;
    customId?: string;
    status?: AuthorizationStatus;
  }): FakeAuth {
    const orderId = input.orderId ?? `order-${input.authorizationId}`;
    const currency = input.currency ?? "USD";
    const auth: FakeAuth = {
      orderId,
      authorizationId: input.authorizationId,
      status: input.status ?? "CREATED",
      amountMinor: input.amountMinor,
      currency,
      createTime: input.createTime,
      expirationTime: input.expirationTime === undefined ? new Date(input.createTime.getTime() + 29 * 24 * 3600 * 1000) : input.expirationTime,
      customId: input.customId,
      captureIds: [],
    };
    this.auths.set(auth.authorizationId, auth);
    const order = this.orders.get(orderId) ?? { orderId, amountMinor: input.amountMinor, currency, customId: input.customId, authorizationIds: [], status: "COMPLETED" as const };
    if (!order.authorizationIds.includes(auth.authorizationId)) order.authorizationIds.push(auth.authorizationId);
    this.orders.set(orderId, order);
    return auth;
  }

  /** An approved order that has NOT been authorized yet. */
  seedOrder(input: { orderId: string; amountMinor: number; currency?: Currency; customId?: string; status?: OrderView["status"] }): void {
    this.orders.set(input.orderId, {
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? "USD",
      customId: input.customId,
      authorizationIds: [],
      status: input.status ?? "APPROVED",
    });
  }

  declineCapture(authorizationId: string, code = "INSTRUMENT_DECLINED"): void {
    this.declineCaptureFor.set(authorizationId, code);
  }
  /** Next call of `kind` on `id` performs the operation, then reports a timeout. */
  timeoutAfter(kind: FakeOpKind, id: string): void {
    this.timeoutAfterKeys.add(`${kind}:${id}`);
  }
  /** Next call of `kind` on `id` reports a timeout WITHOUT performing anything. */
  timeoutBefore(kind: FakeOpKind, id: string): void {
    this.timeoutBeforeKeys.add(`${kind}:${id}`);
  }
  /** Every call of `kind` on `id` reports a timeout without performing anything, until cleared. */
  alwaysTimeout(kind: FakeOpKind, id: string, on = true): void {
    if (on) this.alwaysTimeoutKeys.add(`${kind}:${id}`);
    else this.alwaysTimeoutKeys.delete(`${kind}:${id}`);
  }
  /** Refunds of this capture come back PENDING until `completeRefund`. */
  refundPending(captureId: string): void {
    this.pendingRefundCaptures.add(captureId);
  }
  completeRefund(refundId: string): void {
    const r = this.refunds.get(refundId);
    if (!r) throw new Error(`unknown refund ${refundId}`);
    r.status = "COMPLETED";
    const cap = this.captures.get(r.captureId)!;
    cap.refundedMinor += r.amountMinor;
    cap.status = cap.refundedMinor >= cap.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
  }
  expireAuthorization(authorizationId: string): void {
    const a = this.auths.get(authorizationId);
    if (!a) throw new Error(`unknown authorization ${authorizationId}`);
    a.status = "EXPIRED";
    a.expirationTime = new Date(Date.now() - 1000);
  }
  captureCount(authorizationId: string): number {
    return this.capturesPerformed.get(authorizationId) ?? 0;
  }
  capturesOf(authorizationId: string): FakeCapture[] {
    return (this.auths.get(authorizationId)?.captureIds ?? []).map((id) => this.captures.get(id)!);
  }

  /* ------------------------------- views ---------------------------------- */

  private captureView(c: FakeCapture): CaptureView {
    return { captureId: c.captureId, status: c.status, providerStatus: c.status, amountMinor: c.amountMinor, currency: c.currency, finalCapture: true, createTime: c.createTime };
  }
  private authView(a: FakeAuth): AuthorizationView {
    return {
      orderId: a.orderId,
      authorizationId: a.authorizationId,
      status: a.status,
      providerStatus: a.status,
      amountMinor: a.amountMinor,
      currency: a.currency,
      createTime: a.createTime,
      expirationTime: a.expirationTime,
      customId: a.customId,
      captures: a.captureIds.map((id) => this.captureView(this.captures.get(id)!)),
    };
  }
  private refundView(r: FakeRefund): RefundView {
    return { refundId: r.refundId, status: r.status, providerStatus: r.status, amountMinor: r.amountMinor, currency: r.currency };
  }

  /* ------------------------------- port ----------------------------------- */

  async createAuthorizeOrder(input: CreateOrderInput): Promise<ProviderResult<CreatedOrder>> {
    this.calls.createOrder++;
    const replay = this.requests.get(input.requestId);
    if (replay) return replay as ProviderResult<CreatedOrder>;
    const orderId = this.nextId("order");
    this.orders.set(orderId, { orderId, amountMinor: input.amountMinor, currency: input.currency, customId: input.paymentAttemptId, authorizationIds: [], status: "CREATED" });
    const result: ProviderResult<CreatedOrder> = { ok: true, orderId, providerStatus: "CREATED", approveUrl: `fake://approve/${orderId}` };
    this.requests.set(input.requestId, result);
    return result;
  }

  async authorizeOrder(input: { orderId: string; requestId: string }): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    this.calls.authorize++;
    const replay = this.requests.get(input.requestId);
    if (replay) return replay as ProviderResult<{ authorization: AuthorizationView }>;
    const order = this.orders.get(input.orderId);
    if (!order) return invalid("RESOURCE_NOT_FOUND", "order not found");
    const auth = this.seedAuthorization({ authorizationId: this.nextId("auth"), orderId: order.orderId, amountMinor: order.amountMinor, currency: order.currency, createTime: new Date(), customId: order.customId });
    order.status = "COMPLETED";
    const result: ProviderResult<{ authorization: AuthorizationView }> = { ok: true, authorization: this.authView(auth) };
    this.requests.set(input.requestId, result);
    return result;
  }

  async getOrder(orderId: string): Promise<ProviderResult<{ order: OrderView }>> {
    this.calls.getOrder++;
    if (this.readsFail) return unknown("read failed");
    const o = this.orders.get(orderId);
    if (!o) return invalid("RESOURCE_NOT_FOUND", "order not found");
    return {
      ok: true,
      order: {
        orderId: o.orderId,
        status: o.status,
        providerStatus: o.status,
        intent: "AUTHORIZE",
        amountMinor: o.amountMinor,
        currency: o.currency,
        customId: o.customId,
        authorizations: o.authorizationIds.map((id) => this.authView(this.auths.get(id)!)),
      },
    };
  }

  async getAuthorization(authorizationId: string): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    this.calls.getAuthorization++;
    if (this.readsFail) return unknown("read failed");
    const a = this.auths.get(authorizationId);
    if (!a) return invalid("RESOURCE_NOT_FOUND", "authorization not found");
    return { ok: true, authorization: this.authView(a) };
  }

  async captureAuthorization(input: { authorizationId: string; amountMinor: number; currency: Currency; requestId: string }): Promise<ProviderResult<{ capture: CaptureView }>> {
    this.calls.capture++;
    await this.delay();
    const replay = this.requests.get(input.requestId);
    if (replay) return replay as ProviderResult<{ capture: CaptureView }>;
    const beforeKey = `capture:${input.authorizationId}`;
    if (this.alwaysTimeoutKeys.has(beforeKey) || this.timeoutBeforeKeys.delete(beforeKey)) return unknown("timeout before capture reached provider");

    const a = this.auths.get(input.authorizationId);
    if (!a) return invalid("RESOURCE_NOT_FOUND", "authorization not found");
    if (a.status === "EXPIRED") return invalid("AUTHORIZATION_EXPIRED", "The authorization has expired.");
    if (a.status === "VOIDED") return invalid("AUTHORIZATION_VOIDED", "The authorization was voided.");
    if (a.status === "CAPTURED") return invalid("AUTHORIZATION_ALREADY_CAPTURED", "Already captured.");
    if (a.status !== "CREATED") return invalid("AUTHORIZATION_NOT_CAPTURABLE", `status ${a.status}`);
    if (input.currency !== a.currency) return invalid("CURRENCY_MISMATCH", "currency mismatch");
    if (input.amountMinor > a.amountMinor) return invalid("MAX_CAPTURE_AMOUNT_EXCEEDED", "Capture amount exceeds the authorization.");
    const declineCode = this.declineCaptureFor.get(a.authorizationId);
    if (declineCode) return declined(declineCode, "The instrument was declined.");

    this.capturesPerformed.set(a.authorizationId, (this.capturesPerformed.get(a.authorizationId) ?? 0) + 1);
    const capture: FakeCapture = { captureId: this.nextId("cap"), authorizationId: a.authorizationId, status: "COMPLETED", amountMinor: input.amountMinor, currency: a.currency, refundedMinor: 0, createTime: new Date() };
    this.captures.set(capture.captureId, capture);
    a.captureIds.push(capture.captureId);
    a.status = "CAPTURED";
    const result: ProviderResult<{ capture: CaptureView }> = { ok: true, capture: this.captureView(capture) };
    this.requests.set(input.requestId, result);
    if (this.timeoutAfterKeys.delete(`capture:${input.authorizationId}`)) return unknown("timeout after capture was performed");
    return result;
  }

  async voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<ProviderResult<{ providerStatus: string }>> {
    this.calls.void++;
    await this.delay();
    const replay = this.requests.get(input.requestId);
    if (replay) return replay as ProviderResult<{ providerStatus: string }>;
    if (this.alwaysTimeoutKeys.has(`void:${input.authorizationId}`) || this.timeoutBeforeKeys.delete(`void:${input.authorizationId}`)) return unknown("timeout before void reached provider");
    const a = this.auths.get(input.authorizationId);
    if (!a) return invalid("RESOURCE_NOT_FOUND", "authorization not found");
    if (a.status === "CAPTURED" || a.status === "PARTIALLY_CAPTURED") return invalid("PREVIOUSLY_CAPTURED", "Authorization has been previously captured and cannot be voided.");
    if (a.status === "EXPIRED") return invalid("AUTHORIZATION_EXPIRED", "The authorization has expired.");
    if (a.status === "VOIDED") return invalid("AUTHORIZATION_VOIDED", "Already voided.");
    this.voidsPerformed.set(a.authorizationId, (this.voidsPerformed.get(a.authorizationId) ?? 0) + 1);
    a.status = "VOIDED";
    const result: ProviderResult<{ providerStatus: string }> = { ok: true, providerStatus: "VOIDED" };
    this.requests.set(input.requestId, result);
    if (this.timeoutAfterKeys.delete(`void:${input.authorizationId}`)) return unknown("timeout after void was performed");
    return result;
  }

  async refundCapture(input: { captureId: string; amountMinor: number; currency: Currency; requestId: string }): Promise<ProviderResult<{ refund: RefundView }>> {
    this.calls.refund++;
    await this.delay();
    const replay = this.requests.get(input.requestId);
    if (replay) return replay as ProviderResult<{ refund: RefundView }>;
    if (this.alwaysTimeoutKeys.has(`refund:${input.captureId}`) || this.timeoutBeforeKeys.delete(`refund:${input.captureId}`)) return unknown("timeout before refund reached provider");
    const c = this.captures.get(input.captureId);
    if (!c) return invalid("RESOURCE_NOT_FOUND", "capture not found");
    if (c.status !== "COMPLETED" && c.status !== "PARTIALLY_REFUNDED") return invalid("CAPTURE_NOT_REFUNDABLE", `capture ${c.status}`);
    if (input.amountMinor > c.amountMinor - c.refundedMinor) return invalid("REFUND_AMOUNT_EXCEEDED", "Refund exceeds the unrefunded amount.");
    this.refundsPerformed.set(c.captureId, (this.refundsPerformed.get(c.captureId) ?? 0) + 1);
    const refund: FakeRefund = { refundId: this.nextId("ref"), captureId: c.captureId, status: this.pendingRefundCaptures.has(c.captureId) ? "PENDING" : "COMPLETED", amountMinor: input.amountMinor, currency: c.currency };
    this.refunds.set(refund.refundId, refund);
    if (refund.status === "COMPLETED") {
      c.refundedMinor += refund.amountMinor;
      c.status = c.refundedMinor >= c.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
    }
    const result: ProviderResult<{ refund: RefundView }> = { ok: true, refund: this.refundView(refund) };
    this.requests.set(input.requestId, result);
    if (this.timeoutAfterKeys.delete(`refund:${input.captureId}`)) return unknown("timeout after refund was performed");
    return result;
  }

  async getRefund(refundId: string): Promise<ProviderResult<{ refund: RefundView }>> {
    this.calls.getRefund++;
    if (this.readsFail) return unknown("read failed");
    const r = this.refunds.get(refundId);
    if (!r) return invalid("RESOURCE_NOT_FOUND", "refund not found");
    return { ok: true, refund: this.refundView(r) };
  }

  async verifyWebhook(): Promise<ProviderResult<{ verified: boolean }>> {
    this.calls.verifyWebhook++;
    return { ok: true, verified: this.webhookVerified };
  }
}
