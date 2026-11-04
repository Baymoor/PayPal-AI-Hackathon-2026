/**
 * Real PayPal REST adapter (SANDBOX ONLY) for the PaymentProvider port.
 *
 * - Orders v2 intent AUTHORIZE + Payments v2 capture / void / refund.
 * - Server-only: OAuth client credentials never leave this module, and access
 *   tokens / secrets are never logged or returned.
 * - Every mutation sends the caller's stable `requestId` as PayPal-Request-Id
 *   and `Prefer: return=representation`.
 * - Timeouts, network errors, 5xx, 409 PREVIOUS_REQUEST_IN_PROGRESS and OAuth
 *   failures return `{ ok: false, kind: "UNKNOWN" }`: the caller must reconcile
 *   (GET, or retry with the SAME requestId) before deciding anything.
 * - 4xx business refusals return DECLINED (provider refused to move money) or
 *   INVALID (our request / the resource state is wrong), keeping `debug_id`.
 *
 * Request/response shapes follow docs/research/PAYPAL.md (official OpenAPI
 * specs). This container cannot reach api-m.sandbox.paypal.com, so the adapter
 * is only tested against a mocked fetch; scripts/paypal-smoke.ts is the live
 * check the project owner runs with real sandbox credentials.
 */
import { assertCurrency, decimalStringToMinor, minorToDecimalString, type Currency } from "../domain/money";
import { config } from "../env";
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
import { ProviderUnavailableError } from "./provider";

export const PAYPAL_SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";
export const PAYPAL_PROVIDER_LABEL = "PayPal sandbox";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PaypalProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Sandbox only; anything else is rejected. */
  apiBase?: string;
  webhookId?: string;
  /** Expected payee (merchant id, or email if it contains "@"); sent on orders when set. */
  merchantId?: string;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Injected for tests. */
  fetch?: FetchLike;
  /** Injected clock (ms) for token-cache tests. */
  nowMs?: () => number;
  brandName?: string;
}

/* -------------------------------------------------------------------------- */
/* Issue-code classification                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Issue codes where PayPal definitively refused to move money for a
 * buyer / instrument / risk / lifetime reason. Everything else that is a 4xx
 * is INVALID (our request or the resource state is wrong).
 * Sources: docs/research/PAYPAL.md §5-§10, §13 (several names UNVERIFIED there).
 */
const DECLINE_ISSUES = new Set([
  "INSTRUMENT_DECLINED",
  "PAYMENT_DENIED",
  "TRANSACTION_REFUSED",
  "PAYER_ACTION_REQUIRED",
  "PAYER_CANNOT_PAY",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_VOIDED",
  "AUTHORIZATION_DENIED",
  "ORDER_EXPIRED",
  "TRANSACTION_DISPUTED",
  "COMPLIANCE_VIOLATION",
  "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING",
  "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
  "CARD_EXPIRED",
  "PAYEE_BLOCKED_TRANSACTION",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "PAYER_ACCOUNT_RESTRICTED",
]);

/** Issues that mean "a previous request with this key is still running": outcome unknown, retry later. */
const IN_PROGRESS_ISSUES = new Set(["PREVIOUS_REQUEST_IN_PROGRESS"]);

/**
 * Classify a PayPal HTTP failure into the port's failure kinds.
 * Exported for tests and for callers that want to explain a code.
 */
export function classifyPaypalFailure(httpStatus: number, issue: string | undefined): ProviderFailureKind {
  if (httpStatus >= 500 || httpStatus === 429 || httpStatus === 408) return "UNKNOWN";
  if (issue && IN_PROGRESS_ISSUES.has(issue)) return "UNKNOWN";
  if (httpStatus === 401) return "UNKNOWN"; // auth problem on our side; nothing executed, safe to retry
  if (issue && DECLINE_ISSUES.has(issue)) return "DECLINED";
  return "INVALID";
}

/* -------------------------------------------------------------------------- */
/* Response parsing (strict)                                                  */
/* -------------------------------------------------------------------------- */

class ParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Strictly parse a PayPal money object into integer minor units. */
export function parsePaypalAmount(value: unknown, expectedCurrency?: Currency): { amountMinor: number; currency: Currency } {
  if (!isObj(value)) throw new ParseError("MISSING_AMOUNT", "amount is missing");
  const code = str(value.currency_code);
  const raw = str(value.value);
  if (!code || !raw) throw new ParseError("INVALID_AMOUNT", "amount must have currency_code and value");
  let currency: Currency;
  try {
    currency = assertCurrency(code);
  } catch {
    throw new ParseError("CURRENCY_MISMATCH", `unsupported currency ${code}`);
  }
  if (expectedCurrency && currency !== expectedCurrency) {
    throw new ParseError("CURRENCY_MISMATCH", `expected ${expectedCurrency}, got ${currency}`);
  }
  try {
    return { amountMinor: decimalStringToMinor(raw, currency), currency };
  } catch {
    throw new ParseError("INVALID_AMOUNT", `amount value "${raw}" is not a valid ${currency} decimal`);
  }
}

function parseTime(v: unknown, field: string, required: true): Date;
function parseTime(v: unknown, field: string, required: false): Date | null;
function parseTime(v: unknown, field: string, required: boolean): Date | null {
  const s = str(v);
  if (!s) {
    if (required) throw new ParseError("MISSING_TIME", `${field} is missing`);
    return null;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ParseError("INVALID_TIME", `${field} is not a valid timestamp`);
  return d;
}

const AUTH_STATUSES: readonly AuthorizationStatus[] = ["CREATED", "CAPTURED", "PARTIALLY_CAPTURED", "DENIED", "VOIDED", "EXPIRED", "PENDING"];
const CAPTURE_STATUSES: readonly CaptureStatus[] = ["COMPLETED", "PENDING", "DECLINED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"];
const REFUND_STATUSES: readonly RefundStatus[] = ["COMPLETED", "PENDING", "FAILED", "CANCELLED"];
const ORDER_STATUSES: readonly OrderStatus[] = ["CREATED", "SAVED", "APPROVED", "VOIDED", "COMPLETED", "PAYER_ACTION_REQUIRED"];

function mapEnum<T extends string>(raw: string, allowed: readonly T[]): T | "OTHER" {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : "OTHER";
}

function linkHref(links: unknown, rels: string[]): string | undefined {
  for (const rel of rels) {
    const l = arr(links).find((x) => isObj(x) && x.rel === rel);
    if (isObj(l) && str(l.href)) return l.href as string;
  }
  return undefined;
}

/** Only accept buyer approval links on PayPal's own hosts (defence against open redirects). */
export function isPaypalApprovalUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && (u.hostname === "paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

function orderIdFromLinks(links: unknown): string | undefined {
  const up = linkHref(links, ["up"]);
  const m = up ? /\/v2\/checkout\/orders\/([^/?#]+)/.exec(up) : null;
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function parseCapture(raw: unknown, expectedCurrency?: Currency, fallback?: { amountMinor: number; currency: Currency }): CaptureView {
  if (!isObj(raw)) throw new ParseError("INVALID_CAPTURE", "capture is not an object");
  const captureId = str(raw.id);
  const providerStatus = str(raw.status);
  if (!captureId || !providerStatus) throw new ParseError("INVALID_CAPTURE", "capture id/status missing");
  const money =
    raw.amount === undefined && fallback ? fallback : parsePaypalAmount(raw.amount, expectedCurrency ?? fallback?.currency);
  return {
    captureId,
    status: mapEnum(providerStatus, CAPTURE_STATUSES),
    providerStatus,
    amountMinor: money.amountMinor,
    currency: money.currency,
    finalCapture: raw.final_capture === true,
    createTime: parseTime(raw.create_time, "capture.create_time", false),
  };
}

export function parseAuthorization(raw: unknown, ctx: { orderId?: string; captures?: CaptureView[] } = {}): AuthorizationView {
  if (!isObj(raw)) throw new ParseError("INVALID_AUTHORIZATION", "authorization is not an object");
  const authorizationId = str(raw.id);
  const providerStatus = str(raw.status);
  if (!authorizationId || !providerStatus) throw new ParseError("INVALID_AUTHORIZATION", "authorization id/status missing");
  const money = parsePaypalAmount(raw.amount);
  const related = isObj(raw.supplementary_data) && isObj(raw.supplementary_data.related_ids) ? raw.supplementary_data.related_ids : {};
  const payee = isObj(raw.payee) ? raw.payee : {};
  return {
    orderId: ctx.orderId ?? str(related.order_id) ?? orderIdFromLinks(raw.links) ?? "",
    authorizationId,
    status: mapEnum(providerStatus, AUTH_STATUSES),
    providerStatus,
    amountMinor: money.amountMinor,
    currency: money.currency,
    createTime: parseTime(raw.create_time, "authorization.create_time", true),
    expirationTime: parseTime(raw.expiration_time, "authorization.expiration_time", false),
    customId: str(raw.custom_id),
    payeeMerchantId: str(payee.merchant_id) ?? str(payee.email_address),
    captures: ctx.captures ?? [],
  };
}

export function parseOrder(raw: unknown): OrderView {
  if (!isObj(raw)) throw new ParseError("INVALID_ORDER", "order is not an object");
  const orderId = str(raw.id);
  if (!orderId) throw new ParseError("INVALID_ORDER", "order id missing");
  const providerStatus = str(raw.status) ?? "OTHER";
  const intentRaw = str(raw.intent);
  const pu = arr(raw.purchase_units)[0];
  if (!isObj(pu)) throw new ParseError("INVALID_ORDER", "order has no purchase unit");
  const money = parsePaypalAmount(pu.amount);
  const payments = isObj(pu.payments) ? pu.payments : {};
  const captures = arr(payments.captures).map((c) => parseCapture(c, money.currency));
  const rawAuths = arr(payments.authorizations);
  const authorizations = rawAuths.map((a) =>
    parseAuthorization(a, {
      orderId,
      // One purchase unit, one authorization: captures belong to it. With several,
      // attribute captures by their `up` link when present.
      captures:
        rawAuths.length === 1
          ? captures
          : captures.filter((c, i) => {
              const rc = arr(payments.captures)[i];
              const up = isObj(rc) ? linkHref(rc.links, ["up"]) : undefined;
              return Boolean(up && isObj(a) && typeof a.id === "string" && up.endsWith(`/authorizations/${a.id}`));
            }),
    }),
  );
  return {
    orderId,
    status: mapEnum(providerStatus, ORDER_STATUSES),
    providerStatus,
    intent: intentRaw === "AUTHORIZE" || intentRaw === "CAPTURE" ? intentRaw : "OTHER",
    amountMinor: money.amountMinor,
    currency: money.currency,
    customId: str(pu.custom_id),
    authorizations,
  };
}

export function parseRefund(raw: unknown, fallback?: { amountMinor: number; currency: Currency }): RefundView {
  if (!isObj(raw)) throw new ParseError("INVALID_REFUND", "refund is not an object");
  const refundId = str(raw.id);
  const providerStatus = str(raw.status);
  if (!refundId || !providerStatus) throw new ParseError("INVALID_REFUND", "refund id/status missing");
  const money = raw.amount === undefined && fallback ? fallback : parsePaypalAmount(raw.amount, fallback?.currency);
  return {
    refundId,
    status: mapEnum(providerStatus, REFUND_STATUSES),
    providerStatus,
    amountMinor: money.amountMinor,
    currency: money.currency,
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

interface HttpOk {
  ok: true;
  status: number;
  body: unknown;
}
type HttpResult = HttpOk | ProviderFailure;

interface TokenState {
  token: string | null;
  refreshAtMs: number;
  inflight: Promise<string | ProviderFailure> | null;
}

function failure(kind: ProviderFailureKind, code: string, message: string, extra: { httpStatus?: number; debugId?: string } = {}): ProviderFailure {
  return { ok: false, kind, code, message, ...extra };
}

export class PaypalProvider implements PaymentProvider {
  readonly name = "PAYPAL" as const;
  readonly label = PAYPAL_PROVIDER_LABEL;

  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;
  private readonly tokenState: TokenState;
  private readonly mockApplicationCode: string | undefined;

  constructor(
    private readonly opts: PaypalProviderOptions,
    shared?: { tokenState: TokenState; mockApplicationCode?: string },
  ) {
    const base = (opts.apiBase ?? PAYPAL_SANDBOX_API_BASE).replace(/\/+$/, "");
    if (base !== PAYPAL_SANDBOX_API_BASE) {
      throw new ProviderUnavailableError("Outings only talks to the PayPal sandbox API");
    }
    if (!opts.clientId || !opts.clientSecret) throw new ProviderUnavailableError("PayPal sandbox credentials are not configured");
    this.apiBase = base;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.tokenState = shared?.tokenState ?? { token: null, refreshAtMs: 0, inflight: null };
    this.mockApplicationCode = shared?.mockApplicationCode;
  }

  /** Build from `config().paypal`; throws ProviderUnavailableError without credentials. */
  static fromConfig(): PaypalProvider {
    const p = config().paypal;
    if (!p) throw new ProviderUnavailableError("PayPal sandbox credentials are not configured");
    return new PaypalProvider({
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      apiBase: p.apiBase,
      webhookId: p.webhookId,
      merchantId: p.merchantId,
    });
  }

  /**
   * SANDBOX negative testing: a provider that adds
   * `PayPal-Mock-Response: {"mock_application_codes":"<code>"}` to mutations.
   * Used only by scripts/paypal-smoke.ts --mock-decline. Shares the token cache.
   */
  withMockApplicationCode(code: string): PaypalProvider {
    if (!/^[A-Z_]{3,64}$/.test(code)) throw new Error("invalid mock application code");
    return new PaypalProvider(this.opts, { tokenState: this.tokenState, mockApplicationCode: code });
  }

  /* ------------------------------- OAuth -------------------------------- */

  /** Drop the cached token (tests / after a 401). */
  invalidateToken(): void {
    this.tokenState.token = null;
    this.tokenState.refreshAtMs = 0;
  }

  private async accessToken(): Promise<string | ProviderFailure> {
    const s = this.tokenState;
    if (s.token && this.nowMs() < s.refreshAtMs) return s.token;
    if (!s.inflight) {
      s.inflight = this.fetchToken().finally(() => {
        s.inflight = null;
      });
    }
    return s.inflight;
  }

  private async fetchToken(): Promise<string | ProviderFailure> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`, "utf8").toString("base64");
    const startedAt = this.nowMs();
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      text = await res.text();
    } catch (err) {
      return failure("UNKNOWN", isTimeout(err) ? "OAUTH_TIMEOUT" : "OAUTH_NETWORK_ERROR", "Could not obtain a PayPal access token; no payment request was sent");
    }
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok || !isObj(body) || !str(body.access_token)) {
      const code = isObj(body) && str(body.error) ? `OAUTH_${String(body.error).toUpperCase()}` : "OAUTH_FAILED";
      // Credentials / availability problem on our side: nothing was executed, so UNKNOWN (retry later), never a business refusal.
      return failure("UNKNOWN", code, "PayPal OAuth failed; no payment request was sent", { httpStatus: res.status });
    }
    const expiresInSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
    const lifeMs = expiresInSec * 1000;
    // Refresh early: 5 minutes before expiry, or at half-life for short tokens.
    this.tokenState.token = body.access_token as string;
    this.tokenState.refreshAtMs = startedAt + Math.max(lifeMs - 5 * 60_000, lifeMs / 2);
    return this.tokenState.token;
  }

  /* ------------------------------- HTTP --------------------------------- */

  private async call(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; rawBody?: string; requestId?: string; mutation?: boolean } = {},
    retriedAuth = false,
  ): Promise<HttpResult> {
    const token = await this.accessToken();
    if (typeof token !== "string") return token;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      payload = opts.rawBody ?? JSON.stringify(opts.body ?? {});
    }
    if (opts.mutation) {
      if (!opts.requestId) throw new Error("PayPal mutations require a requestId");
      headers["PayPal-Request-Id"] = opts.requestId;
      headers["Prefer"] = "return=representation";
      if (this.mockApplicationCode) {
        headers["PayPal-Mock-Response"] = JSON.stringify({ mock_application_codes: this.mockApplicationCode });
      }
    }

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      text = await res.text();
    } catch (err) {
      return failure(
        "UNKNOWN",
        isTimeout(err) ? "TIMEOUT" : "NETWORK_ERROR",
        isTimeout(err) ? `PayPal did not answer within ${this.timeoutMs} ms` : "Network error talking to PayPal",
      );
    }

    if (res.status === 401 && !retriedAuth) {
      // Token revoked / expired early: refresh once and retry with the SAME request id.
      this.invalidateToken();
      return this.call(method, path, opts, true);
    }

    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) return failure("UNKNOWN", "UNPARSEABLE_RESPONSE", "PayPal returned a non-JSON success body", { httpStatus: res.status });
        body = null;
      }
    }

    if (res.ok) return { ok: true, status: res.status, body };

    const err = isObj(body) ? body : {};
    const details = arr(err.details);
    const first = isObj(details[0]) ? details[0] : {};
    const issue = str(first.issue) ?? str(err.name) ?? `HTTP_${res.status}`;
    const description = str(first.description) ?? str(err.message) ?? `PayPal returned HTTP ${res.status}`;
    const kind = classifyPaypalFailure(res.status, str(first.issue) ?? str(err.name));
    return failure(kind, issue, description, { httpStatus: res.status, debugId: str(err.debug_id) });
  }

  private parsed<T>(fn: () => T, httpStatus: number): ProviderResult<T> | ProviderFailure {
    try {
      return { ok: true, ...fn() } as ProviderResult<T>;
    } catch (e) {
      if (e instanceof ParseError) {
        // A 2xx we cannot verify: outcome unknown -> reconcile (fail closed), never treat as success.
        return failure("UNKNOWN", e.code, `Unverifiable PayPal response: ${e.message}`, { httpStatus });
      }
      throw e;
    }
  }

  /* ------------------------------- Port --------------------------------- */

  async createAuthorizeOrder(input: CreateOrderInput): Promise<ProviderResult<CreatedOrder>> {
    const currency = assertCurrency(input.currency);
    const payee = this.payee(input.payeeMerchantId);
    const experience: Json = {
      brand_name: this.opts.brandName ?? "Outings",
      locale: "en-US",
      shipping_preference: "NO_SHIPPING",
      // Authorize now, capture later: the PayPal button must not say "Pay Now".
      user_action: "CONTINUE",
      payment_method_preference: "UNRESTRICTED",
    };
    if (input.returnUrl) experience.return_url = input.returnUrl;
    if (input.cancelUrl) experience.cancel_url = input.cancelUrl;

    const body = {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.paymentAttemptId,
          custom_id: input.paymentAttemptId,
          // Unique per attempt (and stable, so an idempotent replay sends the same payload).
          invoice_id: `OUTINGS-${input.paymentAttemptId}`.slice(0, 127),
          description: input.description.slice(0, 127),
          amount: { currency_code: currency, value: minorToDecimalString(input.amountMinor, currency) },
          ...(payee ? { payee } : {}),
        },
      ],
      payment_source: { paypal: { experience_context: experience } },
    };

    const r = await this.call("POST", "/v2/checkout/orders", { body, requestId: input.requestId, mutation: true });
    if (!r.ok) return r;
    return this.parsed(() => {
      if (!isObj(r.body) || !str(r.body.id)) throw new ParseError("INVALID_ORDER", "order id missing");
      const href = linkHref(r.body.links, ["payer-action", "approve"]);
      if (href && !isPaypalApprovalUrl(href)) throw new ParseError("UNTRUSTED_APPROVAL_URL", "approval link is not on a paypal.com host");
      return {
        orderId: r.body.id as string,
        providerStatus: str(r.body.status) ?? "CREATED",
        approveUrl: href,
      };
    }, r.status);
  }

  async authorizeOrder(input: { orderId: string; requestId: string }): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    const path = `/v2/checkout/orders/${encodeURIComponent(input.orderId)}/authorize`;
    const r = await this.call("POST", path, { body: {}, requestId: input.requestId, mutation: true });
    if (!r.ok) {
      if (r.code === "ORDER_ALREADY_AUTHORIZED") {
        // Idempotency window lapsed or a parallel request won: read the existing authorization back.
        const existing = await this.getOrder(input.orderId);
        if (existing.ok && existing.order.authorizations.length === 1) {
          return { ok: true, authorization: existing.order.authorizations[0] };
        }
      }
      return r;
    }
    const parsed = this.parsed(() => {
      const order = parseOrder(r.body);
      if (order.authorizations.length !== 1) throw new ParseError("NO_AUTHORIZATION", "authorize response has no single authorization");
      return { authorization: order.authorizations[0] };
    }, r.status);
    if (parsed.ok || parsed.code !== "NO_AUTHORIZATION") return parsed;
    // Minimal body: read the order back to find the authorization.
    const back = await this.getOrder(input.orderId);
    if (back.ok && back.order.authorizations.length === 1) return { ok: true, authorization: back.order.authorizations[0] };
    return parsed;
  }

  async getOrder(orderId: string): Promise<ProviderResult<{ order: OrderView }>> {
    const r = await this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (!r.ok) return r;
    return this.parsed(() => ({ order: parseOrder(r.body) }), r.status);
  }

  async getAuthorization(authorizationId: string): Promise<ProviderResult<{ authorization: AuthorizationView }>> {
    const r = await this.call("GET", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
    if (!r.ok) return r;
    return this.parsed(() => ({ authorization: parseAuthorization(r.body) }), r.status);
  }

  async captureAuthorization(input: {
    authorizationId: string;
    amountMinor: number;
    currency: Currency;
    requestId: string;
    invoiceId?: string;
    noteToPayer?: string;
  }): Promise<ProviderResult<{ capture: CaptureView }>> {
    const currency = assertCurrency(input.currency);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      return failure("INVALID", "INVALID_AMOUNT", "capture amount must be a positive integer number of minor units");
    }
    const body: Json = {
      amount: { currency_code: currency, value: minorToDecimalString(input.amountMinor, currency) },
      // Exactly one capture per authorization; releases any remainder (see PAYPAL.md §5).
      final_capture: true,
    };
    if (input.invoiceId) body.invoice_id = input.invoiceId.slice(0, 127);
    if (input.noteToPayer) body.note_to_payer = input.noteToPayer.slice(0, 255);
    const path = `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`;
    const r = await this.call("POST", path, { body, requestId: input.requestId, mutation: true });
    if (!r.ok) return r;
    return this.parsed(
      () => ({ capture: parseCapture(r.body, currency, { amountMinor: input.amountMinor, currency }) }),
      r.status,
    );
  }

  async voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<ProviderResult<{ providerStatus: string }>> {
    const path = `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/void`;
    const r = await this.call("POST", path, { requestId: input.requestId, mutation: true, rawBody: "" });
    if (r.ok) {
      const status = isObj(r.body) ? str(r.body.status) : undefined;
      return { ok: true, providerStatus: status ?? "VOIDED" };
    }
    if (r.kind === "UNKNOWN" || r.httpStatus === undefined || r.httpStatus < 400 || r.httpStatus >= 500) return r;
    // Any definitive refusal: read the authorization back (PAYPAL.md §6). Already voided / expired = no hold = success.
    const back = await this.getAuthorization(input.authorizationId);
    if (back.ok) {
      const s = back.authorization.status;
      if (s === "VOIDED" || s === "EXPIRED" || s === "DENIED") return { ok: true, providerStatus: back.authorization.providerStatus };
      if (s === "CAPTURED" || s === "PARTIALLY_CAPTURED") {
        return { ...r, kind: "INVALID", code: "PREVIOUSLY_CAPTURED" };
      }
    }
    if (r.code === "AUTHORIZATION_EXPIRED" || r.code === "AUTHORIZATION_VOIDED") {
      // The hold no longer exists; the goal of the void is met.
      return { ok: true, providerStatus: r.code === "AUTHORIZATION_EXPIRED" ? "EXPIRED" : "VOIDED" };
    }
    return r;
  }

  async refundCapture(input: {
    captureId: string;
    amountMinor: number;
    currency: Currency;
    requestId: string;
    noteToPayer?: string;
  }): Promise<ProviderResult<{ refund: RefundView }>> {
    const currency = assertCurrency(input.currency);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      return failure("INVALID", "INVALID_AMOUNT", "refund amount must be a positive integer number of minor units");
    }
    const body: Json = { amount: { currency_code: currency, value: minorToDecimalString(input.amountMinor, currency) } };
    if (input.noteToPayer) body.note_to_payer = input.noteToPayer.slice(0, 255);
    const path = `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`;
    const r = await this.call("POST", path, { body, requestId: input.requestId, mutation: true });
    if (!r.ok) return r;
    return this.parsed(() => ({ refund: parseRefund(r.body, { amountMinor: input.amountMinor, currency }) }), r.status);
  }

  async getRefund(refundId: string): Promise<ProviderResult<{ refund: RefundView }>> {
    const r = await this.call("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
    if (!r.ok) return r;
    return this.parsed(() => ({ refund: parseRefund(r.body) }), r.status);
  }

  async verifyWebhook(input: { headers: Headers; rawBody: string }): Promise<ProviderResult<{ verified: boolean }>> {
    const webhookId = this.opts.webhookId;
    if (!webhookId) return failure("INVALID", "WEBHOOK_ID_MISSING", "PAYPAL_WEBHOOK_ID is not configured; webhooks cannot be verified");
    const h = (name: string) => input.headers.get(name) ?? undefined;
    const fields = {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
    };
    if (Object.values(fields).some((v) => !v)) {
      return failure("INVALID", "MISSING_TRANSMISSION_HEADERS", "Webhook is missing PayPal transmission headers");
    }
    try {
      const parsed: unknown = JSON.parse(input.rawBody);
      if (!isObj(parsed)) throw new Error("not an object");
    } catch {
      return failure("INVALID", "INVALID_WEBHOOK_BODY", "Webhook body is not a JSON object");
    }
    // Embed the raw event text unmodified (re-serialising can break verification).
    const head = JSON.stringify({ ...fields, webhook_id: webhookId });
    const rawBody = `${head.slice(0, -1)},"webhook_event":${input.rawBody}}`;
    const r = await this.call("POST", "/v1/notifications/verify-webhook-signature", { rawBody });
    if (!r.ok) return r;
    const status = isObj(r.body) ? str(r.body.verification_status) : undefined;
    return { ok: true, verified: status === "SUCCESS" };
  }

  /* ------------------------------ helpers -------------------------------- */

  private payee(explicit?: string): Json | null {
    const id = explicit ?? this.opts.merchantId;
    if (!id) return null;
    return id.includes("@") ? { email_address: id } : { merchant_id: id };
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
