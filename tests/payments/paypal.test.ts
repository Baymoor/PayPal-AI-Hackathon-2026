/**
 * PayPal REST adapter against a MOCKED fetch. These tests check request shapes,
 * headers, parsing and error mapping. They do NOT prove the live sandbox
 * behaves this way — scripts/paypal-smoke.ts does that on the owner's machine.
 */
import { describe, expect, it } from "vitest";
import { classifyPaypalFailure, parsePaypalAmount, PaypalProvider } from "@/lib/payments/paypal";

const BASE = "https://api-m.sandbox.paypal.com";
const TOKEN = "A21AA-test-access-token-SECRET";
const ATTEMPT = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string | undefined;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenResponse(expiresIn = 32_400) {
  return jsonResponse(200, { access_token: TOKEN, token_type: "Bearer", app_id: "APP-1", expires_in: expiresIn, scope: "x" });
}

/** Routes the OAuth call automatically; `api` handles everything else. */
function mockFetch(api: Handler, opts: { token?: Handler } = {}) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const rawBody = typeof init.body === "string" ? init.body : undefined;
    let body: unknown = rawBody;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      /* form body */
    }
    const call: Call = { url, method: init.method ?? "GET", headers, rawBody, body, signal: init.signal ?? undefined };
    calls.push(call);
    if (url === `${BASE}/v1/oauth2/token`) return (opts.token ?? (() => tokenResponse()))(call);
    return api(call);
  };
  return { fn, calls, apiCalls: () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")) };
}

function provider(fetchFn: (url: string, init: RequestInit) => Promise<Response>, extra: Partial<ConstructorParameters<typeof PaypalProvider>[0]> = {}) {
  return new PaypalProvider({ clientId: "client-id", clientSecret: "client-secret", fetch: fetchFn, ...extra });
}

const authorizationJson = (over: Record<string, unknown> = {}) => ({
  id: "3C679366HH908993F",
  status: "CREATED",
  amount: { currency_code: "USD", value: "20.00" },
  custom_id: ATTEMPT,
  invoice_id: `OUTINGS-${ATTEMPT}`,
  expiration_time: "2026-12-03T10:00:00Z",
  create_time: "2026-11-04T10:00:00Z",
  update_time: "2026-11-04T10:00:00Z",
  payee: { merchant_id: "7KNGBPH2U58GQ" },
  links: [],
  ...over,
});

const authorizedOrderJson = (auth: Record<string, unknown> = authorizationJson()) => ({
  id: "5O190127TN364715T",
  status: "COMPLETED",
  intent: "AUTHORIZE",
  purchase_units: [
    {
      reference_id: ATTEMPT,
      custom_id: ATTEMPT,
      amount: { currency_code: "USD", value: "20.00" },
      payments: { authorizations: [auth] },
    },
  ],
});

describe("PayPal adapter: create order", () => {
  it("sends an AUTHORIZE order for the exact decimal amount with idempotency and representation headers", async () => {
    const m = mockFetch(() =>
      jsonResponse(201, {
        id: "5O190127TN364715T",
        status: "PAYER_ACTION_REQUIRED",
        links: [
          { href: `${BASE}/v2/checkout/orders/5O190127TN364715T`, rel: "self", method: "GET" },
          { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "payer-action", method: "GET" },
        ],
      }),
    );
    const p = provider(m.fn, { merchantId: "7KNGBPH2U58GQ" });
    const r = await p.createAuthorizeOrder({
      requestId: `outings-order-${ATTEMPT}`,
      paymentAttemptId: ATTEMPT,
      amountMinor: 3334,
      currency: "USD",
      description: "Outings: hold up to $33.34 for Private karaoke room",
      returnUrl: `http://localhost:3000/api/payments/paypal/return?attempt=${ATTEMPT}`,
      cancelUrl: `http://localhost:3000/api/payments/paypal/cancel?attempt=${ATTEMPT}`,
    });
    expect(r).toEqual({
      ok: true,
      orderId: "5O190127TN364715T",
      providerStatus: "PAYER_ACTION_REQUIRED",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    });

    const [call] = m.apiCalls();
    expect(call.url).toBe(`${BASE}/v2/checkout/orders`);
    expect(call.method).toBe("POST");
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["paypal-request-id"]).toBe(`outings-order-${ATTEMPT}`);
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: ATTEMPT,
          custom_id: ATTEMPT,
          invoice_id: `OUTINGS-${ATTEMPT}`,
          description: "Outings: hold up to $33.34 for Private karaoke room",
          amount: { currency_code: "USD", value: "33.34" },
          payee: { merchant_id: "7KNGBPH2U58GQ" },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Outings",
            locale: "en-US",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            payment_method_preference: "UNRESTRICTED",
            return_url: `http://localhost:3000/api/payments/paypal/return?attempt=${ATTEMPT}`,
            cancel_url: `http://localhost:3000/api/payments/paypal/cancel?attempt=${ATTEMPT}`,
          },
        },
      },
    });
  });

  it("accepts the legacy `approve` link and rejects approval links that are not on paypal.com", async () => {
    const legacy = mockFetch(() =>
      jsonResponse(201, { id: "ORDER1", status: "CREATED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }),
    );
    const ok = await provider(legacy.fn).createAuthorizeOrder({ requestId: "r1", paymentAttemptId: ATTEMPT, amountMinor: 2000, currency: "USD", description: "d" });
    expect(ok.ok && ok.approveUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER1");

    const evil = mockFetch(() => jsonResponse(201, { id: "ORDER2", links: [{ rel: "payer-action", href: "https://paypal.com.evil.example/checkout" }] }));
    const bad = await provider(evil.fn).createAuthorizeOrder({ requestId: "r2", paymentAttemptId: ATTEMPT, amountMinor: 2000, currency: "USD", description: "d" });
    expect(bad).toMatchObject({ ok: false, kind: "UNKNOWN", code: "UNTRUSTED_APPROVAL_URL" });
  });

  it("payee is sent as email_address when the configured merchant id is an email", async () => {
    const m = mockFetch(() => jsonResponse(201, { id: "O", links: [] }));
    await provider(m.fn, { merchantId: "merchant@business.example.com" }).createAuthorizeOrder({
      requestId: "r",
      paymentAttemptId: ATTEMPT,
      amountMinor: 2000,
      currency: "USD",
      description: "d",
    });
    const body = m.apiCalls()[0].body as { purchase_units: { payee: unknown }[] };
    expect(body.purchase_units[0].payee).toEqual({ email_address: "merchant@business.example.com" });
  });

  it("refuses to talk to anything but the sandbox API", () => {
    expect(() => new PaypalProvider({ clientId: "a", clientSecret: "b", apiBase: "https://api-m.paypal.com" })).toThrow(/sandbox/);
  });
});

describe("PayPal adapter: OAuth token cache", () => {
  it("uses Basic client credentials once and caches the token until shortly before expires_in", async () => {
    let nowMs = 1_000_000;
    const m = mockFetch(() => jsonResponse(200, authorizedOrderJson()));
    const p = provider(m.fn, { nowMs: () => nowMs });

    await p.getOrder("O1");
    await p.getOrder("O2");
    const tokenCalls = () => m.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"));
    expect(tokenCalls()).toHaveLength(1);
    const t = tokenCalls()[0];
    expect(t.method).toBe("POST");
    expect(t.headers["authorization"]).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(t.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(t.rawBody).toBe("grant_type=client_credentials");

    // expires_in 32400 s -> refresh 5 minutes early.
    nowMs += (32_400 - 301) * 1000;
    await p.getOrder("O3");
    expect(tokenCalls()).toHaveLength(1);
    nowMs += 2_000;
    await p.getOrder("O4");
    expect(tokenCalls()).toHaveLength(2);
  });

  it("shares one in-flight token request between concurrent calls", async () => {
    const m = mockFetch(() => jsonResponse(200, authorizedOrderJson()));
    const p = provider(m.fn);
    await Promise.all([p.getOrder("A"), p.getOrder("B"), p.getOrder("C")]);
    expect(m.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("on a 401 refreshes the token once and retries with the SAME PayPal-Request-Id", async () => {
    let n = 0;
    const m = mockFetch(() => (++n === 1 ? jsonResponse(401, { name: "AUTHENTICATION_FAILURE" }) : jsonResponse(201, authorizedOrderJson())));
    const r = await provider(m.fn).authorizeOrder({ orderId: "5O190127TN364715T", requestId: "outings-authorize-x" });
    expect(r.ok).toBe(true);
    const api = m.apiCalls();
    expect(api).toHaveLength(2);
    expect(api.map((c) => c.headers["paypal-request-id"])).toEqual(["outings-authorize-x", "outings-authorize-x"]);
    expect(m.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(2);
  });

  it("an OAuth failure is UNKNOWN (nothing sent) and never leaks the secret or token", async () => {
    const m = mockFetch(() => jsonResponse(200, {}), { token: () => jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }) });
    const r = await provider(m.fn).captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(r).toMatchObject({ ok: false, kind: "UNKNOWN", code: "OAUTH_INVALID_CLIENT", httpStatus: 401 });
    expect(JSON.stringify(r)).not.toMatch(/client-secret|SECRET/);
    expect(m.apiCalls()).toHaveLength(0);
  });
});

describe("PayPal adapter: transport failures are UNKNOWN", () => {
  it("timeout via AbortSignal -> UNKNOWN TIMEOUT", async () => {
    const m = mockFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
        }),
    );
    const r = await provider(m.fn, { timeoutMs: 30 }).captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(r).toMatchObject({ ok: false, kind: "UNKNOWN", code: "TIMEOUT" });
    expect(m.apiCalls()[0].signal).toBeDefined();
  });

  it("network error -> UNKNOWN NETWORK_ERROR", async () => {
    const m = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const r = await provider(m.fn).voidAuthorization({ authorizationId: "A", requestId: "v" });
    expect(r).toMatchObject({ ok: false, kind: "UNKNOWN", code: "NETWORK_ERROR" });
  });

  it.each([500, 502, 503, 504])("HTTP %i -> UNKNOWN, keeps debug_id", async (status) => {
    const m = mockFetch(() => jsonResponse(status, { name: "INTERNAL_SERVER_ERROR", message: "boom", debug_id: "dbg123" }));
    const r = await provider(m.fn).captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(r).toMatchObject({ ok: false, kind: "UNKNOWN", httpStatus: status, debugId: "dbg123" });
  });

  it("409 PREVIOUS_REQUEST_IN_PROGRESS -> UNKNOWN (retry later with the same key)", async () => {
    const m = mockFetch(() =>
      jsonResponse(409, { name: "RESOURCE_CONFLICT", debug_id: "d", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS", description: "busy" }] }),
    );
    const r = await provider(m.fn).refundCapture({ captureId: "C", amountMinor: 1000, currency: "USD", requestId: "r" });
    expect(r).toMatchObject({ ok: false, kind: "UNKNOWN", code: "PREVIOUS_REQUEST_IN_PROGRESS" });
  });

  it("a 2xx body that cannot be parsed is UNKNOWN, never success", async () => {
    const m = mockFetch(() => new Response("<html>oops</html>", { status: 201 }));
    const r = await provider(m.fn).captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(r).toMatchObject({ ok: false, kind: "UNKNOWN", code: "UNPARSEABLE_RESPONSE" });
  });
});

describe("PayPal adapter: 4xx issue mapping", () => {
  const err422 = (issue: string) =>
    jsonResponse(422, {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed",
      debug_id: "90bff07028f7f",
      details: [{ issue, description: `${issue} description` }],
    });

  it.each([
    ["INSTRUMENT_DECLINED", "DECLINED"],
    ["AUTHORIZATION_EXPIRED", "DECLINED"],
    ["AUTHORIZATION_VOIDED", "DECLINED"],
    ["PAYMENT_DENIED", "DECLINED"],
    ["TRANSACTION_REFUSED", "DECLINED"],
    ["MAX_CAPTURE_AMOUNT_EXCEEDED", "INVALID"],
    ["AUTHORIZATION_ALREADY_CAPTURED", "INVALID"],
    ["DUPLICATE_INVOICE_ID", "INVALID"],
    ["SOMETHING_NEW", "INVALID"],
  ])("capture 422 %s -> %s with debug_id", async (issue, kind) => {
    const m = mockFetch(() => err422(issue));
    const r = await provider(m.fn).captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(r).toMatchObject({ ok: false, kind, code: issue, httpStatus: 422, debugId: "90bff07028f7f" });
  });

  it.each([
    ["ORDER_NOT_APPROVED", "INVALID"],
    ["PAYER_ACTION_REQUIRED", "DECLINED"],
  ])("authorize 422 %s -> %s", async (issue, kind) => {
    const m = mockFetch(() => err422(issue));
    const r = await provider(m.fn).authorizeOrder({ orderId: "O", requestId: "a" });
    expect(r).toMatchObject({ ok: false, kind, code: issue });
  });

  it("authorize 422 ORDER_ALREADY_AUTHORIZED reads the order back and returns the existing authorization", async () => {
    const m = mockFetch((c) => (c.method === "POST" ? err422("ORDER_ALREADY_AUTHORIZED") : jsonResponse(200, authorizedOrderJson())));
    const r = await provider(m.fn).authorizeOrder({ orderId: "5O190127TN364715T", requestId: "a" });
    expect(r.ok && r.authorization.authorizationId).toBe("3C679366HH908993F");
  });

  it("400 / 403 / 404 are INVALID", async () => {
    for (const status of [400, 403, 404]) {
      const m = mockFetch(() => jsonResponse(status, { name: "X", details: [{ issue: "INVALID_PARAMETER_VALUE" }] }));
      const r = await provider(m.fn).getAuthorization("A");
      expect(r).toMatchObject({ ok: false, kind: "INVALID", httpStatus: status });
    }
  });

  it("classifyPaypalFailure table", () => {
    expect(classifyPaypalFailure(422, "INSTRUMENT_DECLINED")).toBe("DECLINED");
    expect(classifyPaypalFailure(422, "PREVIOUSLY_CAPTURED")).toBe("INVALID");
    expect(classifyPaypalFailure(409, "PREVIOUS_REQUEST_IN_PROGRESS")).toBe("UNKNOWN");
    expect(classifyPaypalFailure(429, undefined)).toBe("UNKNOWN");
    expect(classifyPaypalFailure(500, "INTERNAL_SERVER_ERROR")).toBe("UNKNOWN");
  });
});

describe("PayPal adapter: authorize / capture / void / refund mapping", () => {
  it("authorize parses the authorization from purchase_units[0].payments.authorizations[0]", async () => {
    const m = mockFetch(() => jsonResponse(201, authorizedOrderJson()));
    const r = await provider(m.fn).authorizeOrder({ orderId: "5O190127TN364715T", requestId: `outings-authorize-${ATTEMPT}` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authorization).toEqual({
      orderId: "5O190127TN364715T",
      authorizationId: "3C679366HH908993F",
      status: "CREATED",
      providerStatus: "CREATED",
      amountMinor: 2000,
      currency: "USD",
      createTime: new Date("2026-11-04T10:00:00Z"),
      expirationTime: new Date("2026-12-03T10:00:00Z"),
      customId: ATTEMPT,
      payeeMerchantId: "7KNGBPH2U58GQ",
      captures: [],
    });
    const call = m.apiCalls()[0];
    expect(call.url).toBe(`${BASE}/v2/checkout/orders/5O190127TN364715T/authorize`);
    expect(call.headers["paypal-request-id"]).toBe(`outings-authorize-${ATTEMPT}`);
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(call.body).toEqual({});
  });

  it("rejects a currency mismatch or a non-integer-cent amount in a response as UNKNOWN (fail closed)", async () => {
    const eur = mockFetch(() => jsonResponse(201, authorizedOrderJson(authorizationJson({ amount: { currency_code: "EUR", value: "20.00" } }))));
    expect(await provider(eur.fn).authorizeOrder({ orderId: "O", requestId: "a" })).toMatchObject({ ok: false, kind: "UNKNOWN", code: "CURRENCY_MISMATCH" });

    const frac = mockFetch(() => jsonResponse(201, authorizedOrderJson(authorizationJson({ amount: { currency_code: "USD", value: "20.001" } }))));
    expect(await provider(frac.fn).authorizeOrder({ orderId: "O", requestId: "a" })).toMatchObject({ ok: false, kind: "UNKNOWN", code: "INVALID_AMOUNT" });

    const missingTime = mockFetch(() => jsonResponse(201, authorizedOrderJson(authorizationJson({ create_time: undefined }))));
    expect(await provider(missingTime.fn).authorizeOrder({ orderId: "O", requestId: "a" })).toMatchObject({ ok: false, kind: "UNKNOWN", code: "MISSING_TIME" });

    const capEur = mockFetch(() => jsonResponse(201, { id: "C", status: "COMPLETED", amount: { currency_code: "EUR", value: "10.00" } }));
    expect(
      await provider(capEur.fn).captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" }),
    ).toMatchObject({ ok: false, kind: "UNKNOWN", code: "CURRENCY_MISMATCH" });
  });

  it("parsePaypalAmount is strict integer parsing", () => {
    expect(parsePaypalAmount({ currency_code: "USD", value: "20.00" })).toEqual({ amountMinor: 2000, currency: "USD" });
    expect(parsePaypalAmount({ currency_code: "USD", value: "20.5" })).toEqual({ amountMinor: 2050, currency: "USD" });
    expect(parsePaypalAmount({ currency_code: "USD", value: "33.34" })).toEqual({ amountMinor: 3334, currency: "USD" });
    for (const bad of ["1e3", "-1.00", "10.001", "1,000.00", " ", "0x10"]) {
      expect(() => parsePaypalAmount({ currency_code: "USD", value: bad })).toThrow();
    }
    expect(() => parsePaypalAmount({ currency_code: "JPY", value: "100" })).toThrow();
  });

  it("capture sends amount as a decimal string with final_capture=true and maps the capture", async () => {
    const m = mockFetch(() =>
      jsonResponse(201, {
        id: "2GG279541U471931P",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "10.00" },
        final_capture: true,
        create_time: "2026-11-05T10:00:00Z",
      }),
    );
    const r = await provider(m.fn).captureAuthorization({
      authorizationId: "3C679366HH908993F",
      amountMinor: 1000,
      currency: "USD",
      requestId: "outings-capture-x",
      invoiceId: "INV-1",
    });
    expect(r).toEqual({
      ok: true,
      capture: {
        captureId: "2GG279541U471931P",
        status: "COMPLETED",
        providerStatus: "COMPLETED",
        amountMinor: 1000,
        currency: "USD",
        finalCapture: true,
        createTime: new Date("2026-11-05T10:00:00Z"),
      },
    });
    const call = m.apiCalls()[0];
    expect(call.url).toBe(`${BASE}/v2/payments/authorizations/3C679366HH908993F/capture`);
    expect(call.headers["paypal-request-id"]).toBe("outings-capture-x");
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(call.body).toEqual({ amount: { currency_code: "USD", value: "10.00" }, final_capture: true, invoice_id: "INV-1" });
  });

  it("refuses non-positive / fractional capture amounts without calling PayPal", async () => {
    const m = mockFetch(() => jsonResponse(201, {}));
    for (const amountMinor of [0, -5, 10.5]) {
      const r = await provider(m.fn).captureAuthorization({ authorizationId: "A", amountMinor, currency: "USD", requestId: "c" });
      expect(r).toMatchObject({ ok: false, kind: "INVALID" });
    }
    expect(m.apiCalls()).toHaveLength(0);
  });

  it("void: 204 and 200-representation both succeed", async () => {
    const empty = mockFetch(() => new Response(null, { status: 204 }));
    expect(await provider(empty.fn).voidAuthorization({ authorizationId: "A", requestId: "outings-void-x" })).toEqual({ ok: true, providerStatus: "VOIDED" });
    expect(empty.apiCalls()[0].headers["paypal-request-id"]).toBe("outings-void-x");
    expect(empty.apiCalls()[0].url).toBe(`${BASE}/v2/payments/authorizations/A/void`);

    const rep = mockFetch(() => jsonResponse(200, authorizationJson({ status: "VOIDED" })));
    expect(await provider(rep.fn).voidAuthorization({ authorizationId: "A", requestId: "v" })).toEqual({ ok: true, providerStatus: "VOIDED" });
  });

  it("void 422 reads the authorization back: already VOIDED = success, CAPTURED = PREVIOUSLY_CAPTURED", async () => {
    const voided = mockFetch((c) =>
      c.method === "POST"
        ? jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] })
        : jsonResponse(200, authorizationJson({ status: "VOIDED" })),
    );
    expect(await provider(voided.fn).voidAuthorization({ authorizationId: "A", requestId: "v" })).toEqual({ ok: true, providerStatus: "VOIDED" });

    const captured = mockFetch((c) =>
      c.method === "POST"
        ? jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", debug_id: "d1", details: [{ issue: "PREVIOUSLY_CAPTURED" }] })
        : jsonResponse(200, authorizationJson({ status: "CAPTURED" })),
    );
    expect(await provider(captured.fn).voidAuthorization({ authorizationId: "A", requestId: "v" })).toMatchObject({
      ok: false,
      kind: "INVALID",
      code: "PREVIOUSLY_CAPTURED",
      debugId: "d1",
    });
  });

  it("refund sends the amount and maps the refund", async () => {
    const m = mockFetch(() => jsonResponse(201, { id: "1JU08902781691411", status: "COMPLETED", amount: { currency_code: "USD", value: "20.00" } }));
    const r = await provider(m.fn).refundCapture({ captureId: "2GG279541U471931P", amountMinor: 2000, currency: "USD", requestId: "outings-refund-x" });
    expect(r).toEqual({
      ok: true,
      refund: { refundId: "1JU08902781691411", status: "COMPLETED", providerStatus: "COMPLETED", amountMinor: 2000, currency: "USD" },
    });
    const call = m.apiCalls()[0];
    expect(call.url).toBe(`${BASE}/v2/payments/captures/2GG279541U471931P/refund`);
    expect(call.body).toEqual({ amount: { currency_code: "USD", value: "20.00" } });
    expect(call.headers["paypal-request-id"]).toBe("outings-refund-x");
  });

  it("getOrder maps status, intent, amount and captures under the authorization", async () => {
    const m = mockFetch(() =>
      jsonResponse(200, {
        ...authorizedOrderJson(authorizationJson({ status: "CAPTURED" })),
        purchase_units: [
          {
            custom_id: ATTEMPT,
            amount: { currency_code: "USD", value: "20.00" },
            payments: {
              authorizations: [authorizationJson({ status: "CAPTURED" })],
              captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" }, final_capture: true }],
            },
          },
        ],
      }),
    );
    const r = await provider(m.fn).getOrder("5O190127TN364715T");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order).toMatchObject({ orderId: "5O190127TN364715T", status: "COMPLETED", intent: "AUTHORIZE", amountMinor: 2000, customId: ATTEMPT });
    expect(r.order.authorizations[0].status).toBe("CAPTURED");
    expect(r.order.authorizations[0].captures).toMatchObject([{ captureId: "CAP1", amountMinor: 1000, finalCapture: true }]);
    expect(m.apiCalls()[0].method).toBe("GET");
    expect(m.apiCalls()[0].headers["paypal-request-id"]).toBeUndefined();
  });

  it("getAuthorization attaches the authorization's captures by also reading its order", async () => {
    const authWithOrder = authorizationJson({ status: "CAPTURED", supplementary_data: { related_ids: { order_id: "5O190127TN364715T" } } });
    const m = mockFetch((c) =>
      c.url.includes("/v2/payments/authorizations/")
        ? jsonResponse(200, authWithOrder)
        : jsonResponse(200, {
            id: "5O190127TN364715T",
            status: "COMPLETED",
            intent: "AUTHORIZE",
            purchase_units: [
              {
                amount: { currency_code: "USD", value: "20.00" },
                payments: {
                  authorizations: [authWithOrder],
                  captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" }, final_capture: true }],
                },
              },
            ],
          }),
    );
    const r = await provider(m.fn).getAuthorization("3C679366HH908993F");
    expect(r.ok && r.authorization.orderId).toBe("5O190127TN364715T");
    expect(r.ok && r.authorization.captures).toMatchObject([{ captureId: "CAP1", status: "COMPLETED", amountMinor: 1000 }]);
    expect(m.apiCalls().map((c) => c.url)).toEqual([
      `${BASE}/v2/payments/authorizations/3C679366HH908993F`,
      `${BASE}/v2/checkout/orders/5O190127TN364715T`,
    ]);
  });

  it("getAuthorization fails closed when captures may exist but cannot be read", async () => {
    const noOrder = mockFetch(() => jsonResponse(200, authorizationJson({ status: "PARTIALLY_CAPTURED" })));
    expect(await provider(noOrder.fn).getAuthorization("A")).toMatchObject({ ok: false, kind: "UNKNOWN", code: "CAPTURES_UNRESOLVABLE" });

    const orderDown = mockFetch((c) =>
      c.url.includes("/v2/payments/authorizations/")
        ? jsonResponse(200, authorizationJson({ status: "CAPTURED", supplementary_data: { related_ids: { order_id: "O1" } } }))
        : jsonResponse(503, { name: "SERVICE_UNAVAILABLE" }),
    );
    expect(await provider(orderDown.fn).getAuthorization("A")).toMatchObject({ ok: false, kind: "UNKNOWN" });

    // Nothing can have been captured from a VOIDED authorization: no order read needed.
    const voided = mockFetch(() => jsonResponse(200, authorizationJson({ status: "VOIDED" })));
    expect(await provider(voided.fn).getAuthorization("A")).toMatchObject({ ok: true, authorization: { status: "VOIDED", captures: [] } });
  });

  it("sandbox negative testing header is only added by withMockApplicationCode", async () => {
    const m = mockFetch(() => jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }));
    const base = provider(m.fn);
    const r = await base.withMockApplicationCode("INSTRUMENT_DECLINED").captureAuthorization({ authorizationId: "A", amountMinor: 1000, currency: "USD", requestId: "c" });
    expect(r).toMatchObject({ ok: false, kind: "DECLINED", code: "INSTRUMENT_DECLINED" });
    expect(m.apiCalls()[0].headers["paypal-mock-response"]).toBe('{"mock_application_codes":"INSTRUMENT_DECLINED"}');
    await base.voidAuthorization({ authorizationId: "A", requestId: "v" }).catch(() => undefined);
    expect(m.apiCalls().at(-1)?.headers["paypal-mock-response"]).toBeUndefined();
  });
});

describe("PayPal adapter: webhook verification", () => {
  const headers = new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "sig==",
    "paypal-transmission-time": "2026-11-04T10:00:00Z",
  });
  const rawBody = '{"id":"WH-1","event_type":"PAYMENT.AUTHORIZATION.VOIDED","resource":{"id":"A","amount":{"value":"20.00"}}}';

  it("missing PAYPAL_WEBHOOK_ID -> INVALID, nothing sent", async () => {
    const m = mockFetch(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    expect(await provider(m.fn).verifyWebhook({ headers, rawBody })).toMatchObject({ ok: false, kind: "INVALID", code: "WEBHOOK_ID_MISSING" });
    expect(m.calls).toHaveLength(0);
  });

  it("posts transmission headers + webhook id + the raw event and only trusts SUCCESS", async () => {
    const m = mockFetch(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const p = provider(m.fn, { webhookId: "WH-ID-9" });
    expect(await p.verifyWebhook({ headers, rawBody })).toEqual({ ok: true, verified: true });
    const call = m.apiCalls()[0];
    expect(call.url).toBe(`${BASE}/v1/notifications/verify-webhook-signature`);
    expect(call.body).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      transmission_id: "tx-1",
      transmission_sig: "sig==",
      transmission_time: "2026-11-04T10:00:00Z",
      webhook_id: "WH-ID-9",
      webhook_event: JSON.parse(rawBody),
    });
    expect(call.rawBody?.endsWith(`"webhook_event":${rawBody}}`)).toBe(true);

    const f = mockFetch(() => jsonResponse(200, { verification_status: "FAILURE" }));
    expect(await provider(f.fn, { webhookId: "W" }).verifyWebhook({ headers, rawBody })).toEqual({ ok: true, verified: false });
  });

  it("missing transmission headers or a non-JSON body -> INVALID", async () => {
    const m = mockFetch(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const p = provider(m.fn, { webhookId: "W" });
    expect(await p.verifyWebhook({ headers: new Headers(), rawBody })).toMatchObject({ ok: false, code: "MISSING_TRANSMISSION_HEADERS" });
    expect(await p.verifyWebhook({ headers, rawBody: "not json" })).toMatchObject({ ok: false, code: "INVALID_WEBHOOK_BODY" });
    expect(m.calls).toHaveLength(0);
  });
});
