/**
 * Payment provider port. Two adapters implement it:
 * - lib/payments/paypal.ts   real PayPal REST (sandbox) — server-only
 * - lib/payments/fixture.ts  deterministic in-app simulator, clearly labelled FIXTURE
 *
 * Amounts are integer minor units. Every mutating call takes a stable
 * `requestId` (sent as PayPal-Request-Id) so retries are idempotent.
 *
 * Outcome semantics
 * - `ok: true`             provider confirmed the result
 * - `ok: false, kind: "DECLINED" | "INVALID"`  provider definitively refused (terminal)
 * - `ok: false, kind: "UNKNOWN"`  timeout / 5xx / network: outcome unknown, MUST reconcile
 *   (read state back, or retry with the SAME requestId) before any other decision.
 */
import type { Currency } from "../domain/money";
import type { PaymentProviderName } from "../domain/types";

export type ProviderFailureKind = "DECLINED" | "INVALID" | "UNKNOWN";

export interface ProviderFailure {
  ok: false;
  kind: ProviderFailureKind;
  /** Provider error name / issue code, e.g. "AUTHORIZATION_EXPIRED". */
  code: string;
  message: string;
  httpStatus?: number;
  debugId?: string;
}

export type ProviderResult<T> = ({ ok: true } & T) | ProviderFailure;

export interface CreateOrderInput {
  requestId: string;
  /** Our payment attempt id, sent as custom_id for reconciliation. */
  paymentAttemptId: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  /** Optional absolute URLs for redirect-style approval. */
  returnUrl?: string;
  cancelUrl?: string;
  /** Payee merchant id (experience merchant), when known. */
  payeeMerchantId?: string;
}

export interface CreatedOrder {
  orderId: string;
  /** Raw provider order status, e.g. "CREATED" / "PAYER_ACTION_REQUIRED". */
  providerStatus: string;
  /** Buyer approval URL (redirect flow), if provided by the provider. */
  approveUrl?: string;
}

export type AuthorizationStatus =
  | "CREATED"
  | "CAPTURED"
  | "PARTIALLY_CAPTURED"
  | "DENIED"
  | "VOIDED"
  | "EXPIRED"
  | "PENDING"
  | "OTHER";

export interface AuthorizationView {
  orderId: string;
  authorizationId: string;
  status: AuthorizationStatus;
  providerStatus: string;
  amountMinor: number;
  currency: Currency;
  /** Provider create_time: verified authorization completion timestamp. */
  createTime: Date;
  expirationTime: Date | null;
  customId?: string;
  payeeMerchantId?: string;
  captures: CaptureView[];
}

export type CaptureStatus = "COMPLETED" | "PENDING" | "DECLINED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "OTHER";

export interface CaptureView {
  captureId: string;
  status: CaptureStatus;
  providerStatus: string;
  amountMinor: number;
  currency: Currency;
  finalCapture: boolean;
  createTime: Date | null;
}

export type RefundStatus = "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED" | "OTHER";

export interface RefundView {
  refundId: string;
  status: RefundStatus;
  providerStatus: string;
  amountMinor: number;
  currency: Currency;
}

export type OrderStatus = "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED" | "OTHER";

export interface OrderView {
  orderId: string;
  status: OrderStatus;
  providerStatus: string;
  intent: "AUTHORIZE" | "CAPTURE" | "OTHER";
  amountMinor: number;
  currency: Currency;
  customId?: string;
  authorizations: AuthorizationView[];
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Human label for UI badges ("PayPal sandbox" / "Fixture — not real PayPal"). */
  readonly label: string;

  /** Create an Orders v2 order with intent AUTHORIZE for exactly `amountMinor`. */
  createAuthorizeOrder(input: CreateOrderInput): Promise<ProviderResult<CreatedOrder>>;

  /** Authorize a buyer-approved order. Idempotent on requestId. */
  authorizeOrder(input: { orderId: string; requestId: string }): Promise<ProviderResult<{ authorization: AuthorizationView }>>;

  /** Read the order (and any authorizations / captures) back from the provider. */
  getOrder(orderId: string): Promise<ProviderResult<{ order: OrderView }>>;

  /** Read one authorization back from the provider. */
  getAuthorization(authorizationId: string): Promise<ProviderResult<{ authorization: AuthorizationView }>>;

  /**
   * Capture exactly `amountMinor` (<= authorized) with final_capture=true.
   * Callers MUST have enforced amountMinor <= consented cap before calling.
   */
  captureAuthorization(input: {
    authorizationId: string;
    amountMinor: number;
    currency: Currency;
    requestId: string;
    invoiceId?: string;
    noteToPayer?: string;
  }): Promise<ProviderResult<{ capture: CaptureView }>>;

  /** Void an uncaptured authorization. Idempotent on requestId. */
  voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<ProviderResult<{ providerStatus: string }>>;

  /** Refund a completed capture (full refund when amountMinor equals captured amount). */
  refundCapture(input: {
    captureId: string;
    amountMinor: number;
    currency: Currency;
    requestId: string;
    noteToPayer?: string;
  }): Promise<ProviderResult<{ refund: RefundView }>>;

  /** Read a refund back from the provider (refunds can stay PENDING). */
  getRefund(refundId: string): Promise<ProviderResult<{ refund: RefundView }>>;

  /** Verify a webhook delivery's authenticity. FIXTURE never verifies external webhooks. */
  verifyWebhook(input: { headers: Headers; rawBody: string }): Promise<ProviderResult<{ verified: boolean }>>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
