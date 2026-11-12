# PayPal REST integration reference (sandbox, AUTHORIZE flow)

Scope: server-side adapter for Orders v2 (intent `AUTHORIZE`) + Payments v2 (capture / void / refund / reauthorize) + webhooks, plus the browser approval step.
Written 2026-11-03.

Note, 12 Nov 2026: this is pre-build research, kept as written. Some items tagged UNVERIFIED below were answered in the PayPal sandbox on 7 Nov 2026. Each one now carries an inline pointer to section 14, and section 14 wins where the two differ.

## 0. How to read the evidence tags

The cloud container this was written in could not reach `developer.paypal.com`, `docs.paypal.ai`, or `api-m.sandbox.paypal.com` (DNS or proxy 403). Evidence is therefore graded:

| Tag | Meaning |
|---|---|
| **[SPEC]** | Read directly from the official OpenAPI files in `github.com/paypal/paypal-rest-api-specifications` (`main`): `checkout_orders_v2.json` (info.version 2.32), `payments_payment_v2.json` (2.12), `notifications_webhooks_v1.json` (1.11). Field names, enums, status codes and example JSON below are copied from these. Highest confidence. |
| **[SDK]** | Read directly from official source in `github.com/paypal/paypal-js` (`main`): `packages/paypal-js/README.md`, `src/v6/index.ts`, `types/v6/*.d.ts`. High confidence for v6 method names and types. |
| **[SEARCH]** | A WebSearch summary of a `developer.paypal.com` page. The page itself was not read. Medium confidence. The page URL is cited so a human can confirm. |
| **UNVERIFIED** | From general knowledge only, or sources conflict. Test in sandbox before relying on it. |

The spec files were mirrored in that container's scratch folder, which no longer exists. They are not in the repo; fetch them again from the raw URLs.
Raw URLs: `https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/{checkout_orders_v2,payments_payment_v2,notifications_webhooks_v1}.json`.

Base URLs: sandbox API `https://api-m.sandbox.paypal.com`; buyer-facing sandbox site `https://www.sandbox.paypal.com`; live API `https://api-m.paypal.com` ([SEARCH] https://developer.paypal.com/api/rest/requests/, and the paypaldev sandbox README [fetched] https://github.com/paypaldev/getting-started-with-paypal-sandbox).

---

## 1. OAuth 2.0 token

`POST https://api-m.sandbox.paypal.com/v1/oauth2/token`

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=client_credentials"
```
(The curl form is verbatim from the official sandbox README, https://github.com/paypaldev/getting-started-with-paypal-sandbox.)

- Auth: HTTP Basic with `client_id:client_secret`. Body is `application/x-www-form-urlencoded` (curl `-d` sets it). [SEARCH] https://developer.paypal.com/api/rest/authentication, https://developer.paypal.com/reference/get-an-access-token/
- Response fields [SEARCH]: `access_token`, `token_type` (`Bearer`), `app_id`, `expires_in` (seconds), `nonce`, `scope`. Sample responses show `expires_in: 31668`. Docs disagree on typical lifetime (about 9 hours vs 15 min / 8 hours by scope), so treat `expires_in` as the only authority.
- Use on API calls: `Authorization: Bearer <access_token>`.
- Recommended handling (engineering advice, not from the spec):
  - Cache in memory with `expiresAt = now + expires_in - 60s` skew.
  - Share one in-flight refresh promise across concurrent callers.
  - On a 401 from any API, drop the cache, fetch a new token once, and retry the call once.
- Browser-safe client token (only needed for JS SDK v6 if you choose `clientToken` auth): same endpoint with `response_type=client_token`. [SEARCH] says it expires after 15 minutes. The exact extra form fields (e.g. `domains[]`) are UNVERIFIED. For one-time PayPal payments v6 accepts a `clientId` instead (section 12), so we do not need this.
- The server bearer token must never reach the browser.

---

## 2. Create order with intent AUTHORIZE

`POST /v2/checkout/orders` [SPEC]

### Request headers
| Header | Notes [SPEC] |
|---|---|
| `Authorization: Bearer ...` | required |
| `Content-Type: application/json` | |
| `PayPal-Request-Id` | Idempotency key. Spec text: "The server stores keys for 6 hours. The API callers can request the times to up to 72 hours by speaking to their Account Manager. It is mandatory for all single-step create order calls" (i.e. create with a card / vault_id payment source). We should send it on every call anyway. |
| `Prefer: return=minimal` (default) or `return=representation` | minimal = `id`, `status`, links. |
| `PayPal-Client-Metadata-Id`, `PayPal-Partner-Attribution-Id`, `PayPal-Auth-Assertion` | optional. Not needed. |

### Request body
`intent` enum is `CAPTURE | AUTHORIZE` (`checkout_payment_intent`). Order `status` enum: `CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED`. [SPEC]

`purchase_units[]` (`purchase_unit_request`) [SPEC]:
| Field | Type / limit | Notes |
|---|---|---|
| `reference_id` | string, max 256 | Defaults to `default` if omitted and there is one unit. |
| `amount` | `{currency_code, value}` | `value` is a string; positive. `breakdown` optional. |
| `payee` | `{email_address?, merchant_id?}` | Merchant receiving funds. Omit; defaults to the REST app's business account. |
| `description` | max 3000 in, but truncated to 127 | |
| `custom_id` | max 255 | Reconciliation ID. Shown in reports, not to payer. Also echoed on the authorization object. Good place for our `payerId:outingId`. |
| `invoice_id` | max 127 | "required to be unique within each merchant account by default", so reusing it across orders can yield `DUPLICATE_INVOICE_ID` (code name [SEARCH]). Use a per-attempt unique value, or put the stable ID in `custom_id`. |
| `soft_descriptor` | accepted up to 1000, truncated to 22 chars | For PayPal wallet the statement text is prefixed by PayPal; see spec text. |
| `items`, `shipping`, `payment_instruction`, `supplementary_data` | | not needed |

`payment_source.paypal.experience_context` (`paypal_wallet_experience_context`) [SPEC]:
| Field | Values |
|---|---|
| `brand_name` | string, max 127 |
| `locale` | BCP-47, e.g. `en-US` |
| `shipping_preference` | `GET_FROM_FILE`, `NO_SHIPPING`, `SET_PROVIDED_ADDRESS` (use `NO_SHIPPING`) |
| `return_url`, `cancel_url` | where the buyer lands after approve / cancel (required for redirect flows) |
| `landing_page` | `LOGIN`, `GUEST_CHECKOUT`, `NO_PREFERENCE`, `BILLING` |
| `user_action` | `CONTINUE` or `PAY_NOW`. For authorize-now-capture-later use `CONTINUE` so the button does not say "Pay Now" (UX inference; the spec only says "Configures a Continue or Pay Now checkout flow"). |
| `payment_method_preference` | `UNRESTRICTED` or `IMMEDIATE_PAYMENT_REQUIRED`. Do NOT use IMMEDIATE_PAYMENT_REQUIRED for authorize (UNVERIFIED how it interacts with AUTHORIZE; leave as `UNRESTRICTED`). |
| `contact_preference`, `app_switch_context`, `order_update_callback_config` | not needed |

The top-level `application_context` is the older equivalent and `payer` is deprecated in favour of `payment_source.paypal` ([SPEC] descriptions). Use `payment_source.paypal.experience_context`.

Example request (shapes from the spec's `00_orders_create` example, adapted to AUTHORIZE; the exact combination is not an official example):
```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [
    {
      "reference_id": "outing_123_payer_456",
      "custom_id": "outing_123:payer_456",
      "invoice_id": "OUTING-123-P456-A1",
      "description": "Outing deposit (max share)",
      "soft_descriptor": "OUTINGS",
      "amount": { "currency_code": "USD", "value": "20.00" }
    }
  ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "brand_name": "Outings",
        "locale": "en-US",
        "shipping_preference": "NO_SHIPPING",
        "user_action": "CONTINUE",
        "return_url": "https://app.example.com/api/paypal/return",
        "cancel_url": "https://app.example.com/api/paypal/cancel"
      }
    }
  }
}
```

### Response
Status codes in spec: 200 (idempotent replay), 201 (created), 202, 400, 401, 403, 422, 500. [SPEC]

Spec example, `payment_source.paypal.experience_context` supplied -> `200`/`201` with a **`payer-action`** link and (in the example) no `status` field present under the default minimal preference:
```json
{
  "id": "5O190127TN364715T",
  "payment_source": { "paypal": {} },
  "links": [
    { "href": "https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T", "rel": "self", "method": "GET" },
    { "href": "https://www.paypal.com/checkoutnow?token=5O190127TN364715T", "rel": "payer-action", "method": "GET" }
  ]
}
```
Legacy / no-experience-context response ([SPEC] `orders_create_simple`, 201) has rel `approve` and also `edit` (PATCH) and `capture`/`authorize` (POST). Handle BOTH `payer-action` and `approve`:
```ts
const url = links.find(l => l.rel === "payer-action" || l.rel === "approve")?.href;
```
The sandbox host for these links is `https://www.sandbox.paypal.com/checkoutnow?token=<id>` (host swap per environment; the spec examples show the live host).

Order `status` after create is `CREATED` (or `PAYER_ACTION_REQUIRED` when a payer-action link is returned) [SPEC enum; which one applies to which response was UNVERIFIED when written, so branch on links, not status. **Sandbox 7 Nov: `PAYER_ACTION_REQUIRED`**, section 14 item 3]. After buyer approval the order is `APPROVED`. After authorize the order is `COMPLETED` (there is no `AUTHORIZED` order status in the enum). The `links` doc: "The API caller has 6 hours ... from the time the order is created, to redirect your payer. Once redirected, the API caller has 6 hours for the payer to approve the order and either authorize or capture the order." [SPEC]

---

## 3. Authorize an approved order

`POST /v2/checkout/orders/{id}/authorize` [SPEC]

- Body: `{}` (empty object) after buyer approval. `payment_source` is only needed for single-step flows (vault_id, card).
- Headers: `Authorization`, `Content-Type: application/json`, `PayPal-Request-Id` (idempotency), `Prefer: return=representation` (recommended so the full authorization object comes back), optional `PayPal-Client-Metadata-Id`.
- Status codes: 200 (idempotent replay), 201 (created), 202, 207 (mixed outcomes across multiple purchase units), 400, 401, 403, 404, 409 (order state conflict), 422, 500.
- Precondition: the buyer has approved. Spec: "the buyer must first approve the order or a valid payment_source must be provided".

### Success response (201), authorization location
The authorization lives at **`purchase_units[0].payments.authorizations[0]`**. Example [SPEC `00_orders_authorize`, abridged]:
```json
{
  "id": "5O190127TN364715T",
  "payment_source": { "paypal": { "name": {"given_name":"John","surname":"Doe"}, "email_address": "customer@example.com", "account_id": "QYR5Z8XDVJNXQ" } },
  "purchase_units": [
    {
      "reference_id": "d9f80740-38f0-11e8-b467-0ed5f89f718b",
      "payments": {
        "authorizations": [
          {
            "id": "3C679366HH908993F",
            "status": "CREATED",
            "amount": { "currency_code": "USD", "value": "100.00" },
            "seller_protection": { "status": "ELIGIBLE", "dispute_categories": ["ITEM_NOT_RECEIVED","UNAUTHORIZED_TRANSACTION"] },
            "expiration_time": "2021-10-08T23:37:39Z",
            "create_time": "2018-04-01T21:20:49Z",
            "update_time": "2018-04-01T21:20:49Z",
            "links": [
              { "rel": "self", "method": "GET", "href": ".../v2/payments/authorizations/3C679366HH908993F" },
              { "rel": "capture", "method": "POST", "href": ".../capture" },
              { "rel": "void", "method": "POST", "href": ".../void" },
              { "rel": "reauthorize", "method": "POST", "href": ".../reauthorize" }
            ]
          }
        ]
      }
    }
  ],
  "payer": { "email_address": "customer@example.com", "payer_id": "QYR5Z8XDVJNXQ" },
  "links": [ { "rel": "self", "method": "GET", "href": ".../v2/checkout/orders/5O190127TN364715T" } ]
}
```
(Caution: the spec's own example links in the 201 sample use the order id in the authorization href. That is a doc typo. Always use `authorizations[0].id`, never the order id, for payments calls.)

### Authorization object fields [SPEC `authorization`]
`id`, `status`, `status_details.reason`, `amount{currency_code,value}`, `invoice_id`, `custom_id`, `network_transaction_reference`, `seller_protection{status,dispute_categories}`, `expiration_time`, `links[]`, `create_time`, `update_time` (+ `payee`, `supplementary_data.related_ids.order_id` on GET).

### Authorization status enum [SPEC `authorization_status`]
`CREATED`, `CAPTURED`, `DENIED`, `PARTIALLY_CAPTURED`, `VOIDED`, `PENDING`.

| Status | Meaning (spec descriptions are terse; semantic notes are inferred from the names and docs) |
|---|---|
| `CREATED` | Authorization created, funds held, capturable. |
| `PENDING` | Pending; `status_details.reason` is `PENDING_REVIEW` or `DECLINED_BY_RISK_FRAUD_FILTERS`. Not capturable yet. |
| `PARTIALLY_CAPTURED` | Some amount captured, authorization still open (v1 doc: partial amount puts it in this state [SEARCH]). |
| `CAPTURED` | Fully captured. |
| `VOIDED` | Voided. Per [SEARCH] https://developer.paypal.com/api/rest/webhooks, expiry-driven voids also surface as `PAYMENT.AUTHORIZATION.VOIDED`, so you cannot rely on a separate "expired" status. |
| `DENIED` | Denied. |

**There is no `EXPIRED` value in the v2 enum.** An expired authorization is reported through the error issue `AUTHORIZATION_EXPIRED` on capture (section 10), and probably as `VOIDED` on GET / webhook (UNVERIFIED which). Do not code against `status === "EXPIRED"`.

`status_details.reason` enum on an authorization: only `PENDING_REVIEW`, `DECLINED_BY_RISK_FRAUD_FILTERS`. [SPEC]

Authorization time window: sample responses show `expiration_time` = `create_time` + 30 days (e.g. 2018-04-01 -> 2018-05-01; 2024-10-23 -> 2024-11-21 is +29 days). Read `expiration_time` from the response and store it; do not hardcode.

### Failure on authorize
- `422 PAYER_ACTION_REQUIRED` ("Transaction cannot complete successfully, instruct the buyer to return to PayPal.") [SPEC]
- `422 PAYMENT_DENIED` ("PayPal has declined to process this transaction.") [SPEC]
- Other 422 issues such as `ORDER_NOT_APPROVED`, `ORDER_ALREADY_AUTHORIZED`, `ORDER_ALREADY_CAPTURED`, `INSTRUMENT_DECLINED`, `ORDER_EXPIRED` come from the Orders errors page (https://developer.paypal.com/api/rest/reference/orders/v2/errors/) which was unreachable: UNVERIFIED names (see section 10).
- Retry-safe: if the first authorize timed out, retry with the same `PayPal-Request-Id`, or GET the order and read `payments.authorizations`.

---

## 4. Read endpoints

### GET /v2/checkout/orders/{id} [SPEC]
- Query: `fields` = comma-separated, only valid value `payment_source`. Returns 200 / 401 / 403 / 404 / 500.
- Use to verify `status` (`APPROVED` before authorize; `COMPLETED` after) and to recover the authorization id from `purchase_units[0].payments.authorizations[0].id` if authorize's response was lost.

### GET /v2/payments/authorizations/{authorization_id} [SPEC]
Example (200):
```json
{
  "id": "0VF52814937998046",
  "status": "CREATED",
  "amount": { "value": "10.99", "currency_code": "USD" },
  "invoice_id": "INVOICE-123",
  "seller_protection": { "status": "ELIGIBLE", "dispute_categories": ["ITEM_NOT_RECEIVED","UNAUTHORIZED_TRANSACTION"] },
  "payee": { "email_address": "merchant@example.com", "merchant_id": "7KNGBPH2U58GQ" },
  "expiration_time": "2017-10-10T23:23:45Z",
  "create_time": "2017-09-11T23:23:45Z",
  "update_time": "2017-09-11T23:23:45Z",
  "links": [ {"rel":"self"}, {"rel":"capture","method":"POST"}, {"rel":"void","method":"POST"}, {"rel":"reauthorize","method":"POST"} ]
}
```
A second example adds `supplementary_data.related_ids.order_id` and an `up` link to the order. Returns 200 / 401 / 403 / 404 / 500. Note: no `amount_captured` style field exists on the authorization, so track captured totals in our DB.

### GET /v2/payments/captures/{capture_id}  [SPEC]
200 with the capture object (section 5).

---

## 5. Capture an authorization

`POST /v2/payments/authorizations/{authorization_id}/capture` [SPEC]

Headers: `Authorization`, `Content-Type: application/json`, **`PayPal-Request-Id`**, `Prefer: return=representation | return=minimal`, optional `PayPal-Auth-Assertion`.

### Request body (`capture_request`) [SPEC]
| Field | Notes |
|---|---|
| `amount` `{currency_code, value}` | "To capture a portion of the full authorized amount, specify an amount. If amount is not specified, the full authorized amount is captured." Same currency as the authorization; positive. |
| `final_capture` | boolean, default `false`. "Indicates whether you can make additional captures against the authorized payment. Set to `true` if you do not intend to capture additional payments against the authorization." |
| `invoice_id` | max 127. Per-capture external invoice number. Appears to the payer. |
| `note_to_payer` | max 255. |
| `soft_descriptor` | max 22. |
| `payment_instruction` | platform fees; not applicable. |

Request example [SPEC `authorizations_capture`]:
```json
{
  "amount": { "value": "10.00", "currency_code": "USD" },
  "invoice_id": "INVOICE-123",
  "final_capture": true,
  "note_to_payer": "Final share for your outing",
  "soft_descriptor": "OUTINGS"
}
```

### Response
Status codes [SPEC]: `200` (idempotent replay), `201` (created), 400, 401, 403, 404, 409, 422, 500.

Minimal (default) 201 body:
```json
{ "id": "2GG279541U471931P", "status": "COMPLETED",
  "links": [ {"rel":"self","method":"GET","href":".../v2/payments/captures/2GG279541U471931P"},
             {"rel":"refund","method":"POST","href":".../captures/2GG279541U471931P/refund"},
             {"rel":"up","method":"GET","href":".../v2/payments/authorizations/0VF52814937998046"} ] }
```
With `Prefer: return=representation` (201):
```json
{
  "id": "2GG279541U471931P",
  "status": "COMPLETED",
  "status_details": {},
  "amount": { "value": "10.99", "currency_code": "USD" },
  "final_capture": true,
  "seller_protection": { "status": "ELIGIBLE", "dispute_categories": ["ITEM_NOT_RECEIVED","UNAUTHORIZED_TRANSACTION"] },
  "seller_receivable_breakdown": {
    "gross_amount": { "value": "10.99", "currency_code": "USD" },
    "paypal_fee":   { "value": "0.33",  "currency_code": "USD" },
    "net_amount":   { "value": "10.66", "currency_code": "USD" }
  },
  "invoice_id": "INV-123",
  "create_time": "2017-09-11T23:24:01Z",
  "update_time": "2017-09-11T23:24:01Z",
  "links": [ ... ]
}
```
A `PENDING` example in the spec carries `"status_details": {"reason": "OTHER"}`.

Capture `status` enum: `COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED`. [SPEC]
Capture `status_details.reason` enum: `BUYER_COMPLAINT, CHARGEBACK, ECHECK, INTERNATIONAL_WITHDRAWAL, OTHER, PENDING_REVIEW, RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION, REFUNDED, TRANSACTION_APPROVED_AWAITING_FUNDING, UNILATERAL, VERIFICATION_REQUIRED, DECLINED_BY_RISK_FRAUD_FILTERS`. [SPEC]

Handling: `COMPLETED` = money moved. `PENDING` = not final; wait for `PAYMENT.CAPTURE.COMPLETED` or `PAYMENT.CAPTURE.DENIED` webhook (or poll GET capture). `DECLINED` / `FAILED` = treat as failed capture, and feed our partial-failure compensation path.

### Capturing LESS than authorized, with `final_capture: true`
- Supported: yes, partial capture is the documented purpose of `amount` ("To capture a portion of the full authorized amount, specify an amount"). The delay-capture guide gives "Authorize $100, capture $60 -> $60 captured, $40 remains available" [SEARCH] https://developer.paypal.com/checkout/delay-capture.
- What happens to the remainder with `final_capture: true`:
  - The v2 spec only says that no further captures are allowed. It does NOT say the remainder is automatically voided. UNVERIFIED for v2 when written. **Sandbox 7 Nov: PayPal releases the remainder itself, no void needed** (section 14 item 1).
  - The legacy DoCapture NVP / SOAP docs state that on the final capture "any remaining amount of the original authorized transaction is automatically voided" [SEARCH] https://developer.paypal.com/api/nvp-soap/do-capture-nvp/. The v1 REST `is_final_capture` flag was described as releasing all remaining held funds [SEARCH] https://developer.paypal.com/api/deprecated/payments/v1/authorization-capture.
  - The delay-capture guide says an unused remainder "can be voided or left to expire" [SEARCH].
  - **Plan**: send `final_capture: true` on the final capture (this is the right intent), then GET the authorization afterwards. Log the status. If it is still `PARTIALLY_CAPTURED` and not `CAPTURED` / `VOIDED`, issue an explicit `void` of the remainder (void on a partially captured authorization is allowed: the spec says only that you cannot void an authorization that "has been fully captured"). Treat a "nothing to void" 422 there as success. Confirm in sandbox and update this doc. **Sandbox 7 Nov: confirmed, the authorization reads `CAPTURED` and the explicit void is not needed** (section 14 item 1).
  - The resulting authorization `status` after a final partial capture was UNVERIFIED when written (`PARTIALLY_CAPTURED` vs `CAPTURED`). **Sandbox 7 Nov: `CAPTURED`** (section 14 item 1). v1 doc said `CAPTURED` only if the amount equals the authorized amount [SEARCH].
- Partial capture account setting: [SEARCH] https://developer.paypal.com/checkout/delay-capture states "For PayPal payment authorizations, you must enable partial capture on your PayPal account", but it was not possible to see where that toggle is (possibly legacy). The v2 spec itself lists no account-capability error for partial capture. UNVERIFIED when written: if sandbox partial capture fails with `PERMISSION_DENIED` / `NOT_AUTHORIZED`, check the business sandbox account's settings and the REST app's feature checkboxes in the Developer Dashboard. **Sandbox 7 Nov: no setting was needed** for the default sandbox Business account (section 14 item 2).
- Multiple captures: each needs a distinct `invoice_id`, and a later capture after `final_capture: true` fails. [SEARCH] https://developer.paypal.com/checkout/delay-capture. For us: exactly one capture per authorization, `final_capture: true`.

### Capturing MORE than authorized
- The spec's 422 example: `MAX_CAPTURE_AMOUNT_EXCEEDED` -- "Capture amount specified exceeded allowable limit. You can only capture up to the original authorization amount." (field `/amount/value`, value `10.99`). [SPEC]
- A separate rule says you can capture up to 115% of the authorized amount or authorized + $75, whichever is less [SEARCH delay-capture]. In the payments spec this rule is attached to **reauthorize** ("in US it is up to 115% of the original authorized amount, not to exceed an increase of $75 USD"). The two sources conflict for capture. Our app forbids over-capture in code, so: never send `amount > authorized`, and treat `MAX_CAPTURE_AMOUNT_EXCEEDED` as a programming error.

### Capture error examples [SPEC]
- 400 `INVALID_REQUEST` with `details[].issue` e.g. `INVALID_STRING_MAX_LENGTH` (field `/invoice_id`).
- 409 `RESOURCE_CONFLICT`, issue `PREVIOUS_REQUEST_IN_PROGRESS` (retry after a delay).
- 422 `MAX_CAPTURE_AMOUNT_EXCEEDED`; 422 `AUTHORIZATION_EXPIRED` ("The authorization has expired.").

---

## 6. Void an authorization

`POST /v2/payments/authorizations/{authorization_id}/void` [SPEC]

- No body needed. Headers: `Authorization`, `PayPal-Request-Id` (declared in spec), `Prefer`, optional `PayPal-Auth-Assertion`.
- Responses: **`204 No Content`** by default; **`200`** with the authorization object (`status: "VOIDED"`) when `Prefer: return=representation` is sent (spec: "This response is returned when the Prefer header is set to return=representation"; also the replay of an idempotent void). 401, 403, 404, 409, 422, 500. [SPEC]; migration-guide statement [SEARCH] https://developer.paypal.com/api/rest/integration/payments-api/v1-v2-migration.
- Success example (200, `Prefer: return=representation`):
```json
{ "id": "5C908745JK343851U", "status": "VOIDED",
  "amount": { "currency_code": "USD", "value": "100.00" },
  "invoice_id": "OrderInvoice-10_10_2024_12_06_00_pm",
  "expiration_time": "2024-11-08T09:06:03-08:00",
  "create_time": "2024-10-10T10:06:03-07:00", "update_time": "2024-10-10T10:06:19-07:00",
  "links": [ { "rel": "self", "method": "GET", "href": "https://api.paypal.com/v2/payments/authorizations/5C908745JK343851U" } ] }
```
- Errors [SPEC examples]:
  - `422 UNPROCESSABLE_ENTITY`, issue **`PREVIOUSLY_CAPTURED`** -- "Authorization has been previously captured and cannot be voided."
  - `409 RESOURCE_CONFLICT`, issue `PREVIOUS_REQUEST_IN_PROGRESS`.
  - `CANNOT_BE_VOIDED` is NOT in the payments spec. It may exist on older docs; do not rely on it (UNVERIFIED). Void on an already-voided or expired authorization: exact issue code UNVERIFIED (likely `AUTHORIZATION_VOIDED` / `AUTHORIZATION_EXPIRED` style 422). Our adapter should treat any 422 on void as "re-GET the authorization and compare status": `VOIDED` -> success (idempotent), `CAPTURED` / `PARTIALLY_CAPTURED` -> real conflict.
- Void releases the hold. If nothing was captured the whole authorization becomes void and nothing can be captured. [SEARCH] https://developer.paypal.com/checkout/void-authorized-payment

---

## 7. Refund a capture

`POST /v2/payments/captures/{capture_id}/refund` [SPEC]

- Full refund: empty JSON body `{}`. Partial: include `amount`. ("For a full refund, include an empty payload in the JSON request body. For a partial refund, include an amount object.")
- Body fields (example in spec): `amount{currency_code,value}`, `invoice_id`, `custom_id`, `note_to_payer`/`note` (spec examples use `"note": "Defective product"`), `payment_instruction` (platform).
- Headers: `Authorization`, `PayPal-Request-Id`, `Prefer`.
- Responses: `200` (idempotent replay), `201` (created), 400, 401, 403, 404, 409, 422, 500.
- Response example (201) [SPEC]:
```json
{
  "id": "1JU08902781691411",
  "amount": { "value": "10.99", "currency_code": "USD" },
  "status": "COMPLETED",
  "note": "Defective product",
  "seller_payable_breakdown": {
    "gross_amount": { "value": "10.99", "currency_code": "USD" },
    "paypal_fee":   { "value": "0", "currency_code": "USD" },
    "net_amount":   { "value": "10.99", "currency_code": "USD" },
    "total_refunded_amount": { "value": "10.99", "currency_code": "USD" }
  },
  "invoice_id": "INVOICE-123",
  "create_time": "2018-09-11T23:24:19Z",
  "update_time": "2018-09-11T23:24:19Z",
  "links": [ {"rel":"self","method":"GET","href":".../v2/payments/refunds/1JU08902781691411"},
             {"rel":"up","method":"GET","href":".../v2/payments/captures/2GG279541U471931P"} ]
}
```
- Refund `status` enum: `CANCELLED, FAILED, PENDING, COMPLETED`. `status_details.reason`: `ECHECK`. [SPEC] `PENDING` means not final (eCheck funded); wait for webhook `PAYMENT.CAPTURE.REFUNDED` / poll.
- Errors [SPEC]: `422 REFUND_AMOUNT_EXCEEDED` ("must be less than or equal to the capture amount that has not yet been refunded"); `422 TRANSACTION_DISPUTED` (partial refunds blocked by open case); 409 `PREVIOUS_REQUEST_IN_PROGRESS`; 400 `INVALID_STRING_LENGTH` for long `invoice_id`.
- Capture `status` moves to `PARTIALLY_REFUNDED` / `REFUNDED`.
- `GET /v2/payments/refunds/{refund_id}` [SPEC]: 200 with the same refund object (the spec example `refunds_get_platform_fees`), 401 / 403 / 404 / 500.
- A refund of a capture that is still `PENDING` or already fully refunded: issue codes UNVERIFIED.

---

## 8. Reauthorize, honor period and validity

`POST /v2/payments/authorizations/{authorization_id}/reauthorize` [SPEC]
- Body: `{ "amount": { "currency_code": "USD", "value": "20.00" } }` ("Supports only the `amount` request parameter"). Headers: `PayPal-Request-Id`, `Prefer`.
- Responses: 200, 201, 400, 401, 403, 404, 422, 500.
- Spec description (verbatim essentials): "reauthorize a payment after its initial three-day honor period expires. Within the 29-day authorization period, you can issue multiple re-authorizations after the honor period expires. If 30 days have transpired since the date of the original authorization, you must create an authorized payment instead of reauthorizing... A reauthorized payment itself has a new honor period of three days. You can reauthorize an authorized payment from 4 to 29 days after the 3-day honor period. The allowed amount ... in US it is up to 115% of the original authorized amount, not to exceed an increase of $75 USD."
- 422 errors [SPEC]: `REAUTHORIZATION_TOO_SOON` ("Re-authorization is not allowed within the three-day honor period."), `AUTH_CURRENCY_MISMATCH`.
- Per [SEARCH] https://developer.paypal.com/checkout/extend-authorization: a reauthorization generates a **new Authorization ID**; capture against the new one. (Spec's reauthorize 200/201 body should show the new `id`; confirm in sandbox.)
- Honor period vs validity [SEARCH] https://developer.paypal.com/payment-methods/auth-honor and https://developer.paypal.com/checkout/delay-capture:
  - Authorization holds funds and is valid for 29 days. PayPal recommends capturing within the 3-day honor period, where success rates are best.
  - After the honor period, funds are not guaranteed, so a capture may fail with the funds no longer available; reauthorize first.
  - One page says "3 days in the US, up to 29 days in most other regions" (conflicting; UNVERIFIED which is current).
  - Sandbox vs production difference: NOT documented in anything we could read. UNVERIFIED. Practical consequence for a hackathon demo: sandbox will not make us wait 3 / 29 days. To demo the expired path use negative testing (section 13) rather than waiting.
- Product implication: if the outing deadline is more than 3 days after approval, schedule a reauthorize on day 4+ (or capture earlier), and persist the new authorization id. If the deadline is more than 29 days out, you must create a new order. Our app should cap outing deadlines at about 3 days for MVP, or at most 29 days minus margin with reauthorize.

---

## 9. Idempotency and request behaviour

- Header: `PayPal-Request-Id: <unique string>` (a UUID v4 is fine). Declared in the spec for: create order, authorize order, capture order, capture authorization, reauthorize, void, refund. [SPEC] Not applicable to GET.
- Replay semantics [SPEC response descriptions + SEARCH]:
  - Same key + same request -> PayPal returns the original result. The spec gives the replay its own status: `200` for create / authorize / capture / refund / void (vs `201` on first execution). Treat 200 and 201 equivalently, but note a void's first success is `204`.
  - Concurrent duplicate with the same key while the first is running -> `409 RESOURCE_CONFLICT`, issue `PREVIOUS_REQUEST_IN_PROGRESS` ([SPEC] examples on capture / void / refund). Back off and retry.
  - Reusing a key with a different payload: behaviour UNVERIFIED. A `DUPLICATE_REQUEST`-style error may be returned; do not do it. One key = one logical operation.
- Retention: conflicting.
  - Orders spec text: stored **6 hours** (extendable to 72 hours by account manager). [SPEC]
  - General REST guidance: up to **45 days** [SEARCH] https://developer.paypal.com/api/rest/reference/idempotency , https://developer.paypal.com/api/rest/requests/.
  - Design for the shortest (6 hours): never rely on a replay after 6 hours. After that, reconcile by GET (order / authorization / capture / refund) rather than re-POST.
- Our key scheme (recommended): derive a deterministic key per logical operation and persist it before sending, e.g. `capture:{authorizationId}:{attempt}`, `void:{authorizationId}`, `refund:{captureId}:{reason}`, `order:{outingId}:{payerId}:{n}`. Retry on timeout / 5xx with the SAME key.
- `Prefer: return=representation`: returns the full resource on create / authorize / capture / reauthorize / refund (and 200 with body for void). `return=minimal` is the default (`id`, `status`, links). [SPEC]
- `PayPal-Auth-Assertion`: for acting on behalf of a merchant (partner / platform). Not needed. Omit.
- Retry policy (engineering advice):
  - Retry on network error / timeout / 500 / 502 / 503 / 504 and 409 `PREVIOUS_REQUEST_IN_PROGRESS`, with exponential backoff plus jitter (e.g. 0.5s, 1s, 2s, 4s; max 4 tries), reusing the same `PayPal-Request-Id`.
  - 401: refresh token once and retry.
  - 400 / 403 / 404 / 422: do not retry; map to a domain error.
  - After retries are exhausted on a mutating call, mark the DB row `UNKNOWN` and reconcile by GET plus webhook before taking any compensating action.
- Include `debug_id` from error bodies in logs (not user-facing).

---

## 10. Error format and issue codes

Body shape [SPEC]:
```json
{
  "name": "UNPROCESSABLE_ENTITY",
  "message": "The requested action could not be performed, semantically incorrect, or failed business validation.",
  "debug_id": "90bff07028f7f",
  "details": [
    { "issue": "AUTHORIZATION_EXPIRED", "description": "The authorization has expired.", "field": "/amount/value", "value": "10.99", "location": "body" }
  ],
  "links": [ { "href": "https://developer.paypal.com/docs/api/orders/v2/#error-AUTHORIZATION_EXPIRED", "rel": "information_link" } ]
}
```
(`field`, `value`, `location`, `links` appear only on some errors.) Note the spec itself spells the 422 `name` inconsistently (`UNPROCESSABLE_ENTITY` vs `UNPROCCESSABLE_ENTITY`). **Branch on `details[0].issue`, not on `name`.**

`name` values seen in the spec: `INVALID_REQUEST` (400), `UNPROCESSABLE_ENTITY` (422), `RESOURCE_CONFLICT` (409). Others (e.g. `NOT_AUTHORIZED`, `PERMISSION_DENIED` for 403, `RESOURCE_NOT_FOUND` for 404, `INTERNAL_SERVER_ERROR`) are UNVERIFIED names.

### Issue codes found verbatim in the official specs [SPEC]
| Endpoint | HTTP | `issue` | Description (spec) |
|---|---|---|---|
| capture auth | 422 | `MAX_CAPTURE_AMOUNT_EXCEEDED` | Capture amount exceeds allowable limit; can only capture up to original authorization amount |
| capture auth | 422 | `AUTHORIZATION_EXPIRED` | The authorization has expired |
| capture/void/refund | 409 | `PREVIOUS_REQUEST_IN_PROGRESS` | A previous request on this resource is in progress; retry later |
| void | 422 | `PREVIOUSLY_CAPTURED` | Authorization has been previously captured and cannot be voided |
| reauthorize | 422 | `REAUTHORIZATION_TOO_SOON` | Not allowed within the three-day honor period |
| reauthorize | 422 | `AUTH_CURRENCY_MISMATCH` | Currency must match the original authorization |
| refund | 422 | `REFUND_AMOUNT_EXCEEDED` | Refund must be <= unrefunded captured amount |
| refund | 422 | `TRANSACTION_DISPUTED` | Partial refunds blocked by an open case |
| authorize order | 422 | `PAYER_ACTION_REQUIRED` | Send buyer back to PayPal (e.g. SCA) |
| authorize order | 422 | `PAYMENT_DENIED` | PayPal declined |
| create order | 422 | `MISSING_SHIPPING_ADDRESS` | Needed when `shipping_preference=SET_PROVIDED_ADDRESS` |
| patch order | 422 | `PAYER_PATCH_NOT_ALLOWED` | |
| any | 400 | `INVALID_ARRAY_MIN_ITEMS`, `INVALID_STRING_MAX_LENGTH`, `INVALID_STRING_LENGTH`, `INVALID_PARAMETER_SYNTAX`, `INVALID_CURRENCY_CODE` | schema / validation |

### Codes you asked about that are NOT in the specs (names from search snippets or memory; confirm at https://developer.paypal.com/api/rest/reference/orders/v2/errors/ and https://developer.paypal.com/api/rest/reference/payments/v2/errors/)
| Code | Evidence |
|---|---|
| `INSTRUMENT_DECLINED` (422) | [SEARCH] community post and negative-testing docs list it as a valid mock code for capture; "funding instrument declined, ask buyer to choose another". Real-world on authorize/capture of orders. |
| `AUTHORIZATION_ALREADY_CAPTURED` | [SEARCH] listed in delay-capture negative-test table. |
| `DUPLICATE_INVOICE_ID` | [SEARCH] used in the official negative-testing example against order capture. |
| `TRANSACTION_REFUSED`, `INTERNAL_SERVER_ERROR` | [SEARCH] sample code lists them as capture mock codes. |
| `ORDER_NOT_APPROVED`, `ORDER_ALREADY_AUTHORIZED`, `ORDER_ALREADY_CAPTURED`, `ORDER_EXPIRED` | UNVERIFIED (memory; docs not reachable). |
| `AUTHORIZATION_VOIDED` | UNVERIFIED when written. **Sandbox 7 Nov: confirmed**, HTTP 422 on capture after void (section 14 item 6). |
| `PERMISSION_DENIED` / `NOT_AUTHORIZED` | UNVERIFIED. |
| `DUPLICATE_REQUEST` | UNVERIFIED. |
| `CANNOT_BE_VOIDED` | Not in the v2 spec; use `PREVIOUSLY_CAPTURED`. |
| `PAYER_CANNOT_PAY` | Only seen in a third-party doc [SEARCH]; UNVERIFIED. |

Adapter recommendation: map to a small domain enum (`AUTH_EXPIRED`, `AUTH_ALREADY_FINAL`, `OVER_CAPTURE`, `DECLINED`, `NEEDS_BUYER_ACTION`, `IN_PROGRESS`, `TRANSIENT`, `OTHER`) and keep the raw `issue` + `debug_id` for logs. Unknown 422 issue -> `OTHER` plus a reconcile GET.

---

## 11. Webhooks

### Event types (most relevant)
Event names appear in the official sample payload for `PAYMENT.AUTHORIZATION.CREATED` ([SPEC] notifications_webhooks_v1 verify request example) and `PAYMENT.CAPTURE.DENIED` was confirmed by [SEARCH] https://developer.paypal.com/api/rest/webhooks. The rest are from the well-known catalogue at https://developer.paypal.com/api/rest/webhooks/event-names (page not read; names UNVERIFIED but stable and long-standing):

| Event | Use |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | buyer approved the order (payer can now be authorized) |
| `PAYMENT.AUTHORIZATION.CREATED` | authorization created |
| `PAYMENT.AUTHORIZATION.VOIDED` | voided (also fired when an authorization expires, [SEARCH]) |
| `PAYMENT.CAPTURE.COMPLETED` | capture done |
| `PAYMENT.CAPTURE.PENDING` | capture pending |
| `PAYMENT.CAPTURE.DENIED` | capture denied |
| `PAYMENT.CAPTURE.REFUNDED` | capture refunded |
| `PAYMENT.CAPTURE.REVERSED` | reversal / chargeback (UNVERIFIED name) |
| `CHECKOUT.ORDER.COMPLETED` | order completed (UNVERIFIED) |

Event envelope (from the spec example): `id` (event id, use as the dedupe key), `create_time`, `resource_type` (e.g. `authorization`), `event_type`, `summary`, `resource{id, ...}`, `links`. The `resource` is the authorization / capture object (`resource.id` = authorization or capture id; for captures `resource.supplementary_data.related_ids` may have `order_id` / `authorization_id` -- UNVERIFIED).

### Verify signature (online verification)
`POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature` (bearer token) [SPEC notifications_webhooks_v1]

Request body, all seven fields required:
| Body field | Source |
|---|---|
| `auth_algo` | header `PAYPAL-AUTH-ALGO` (e.g. `SHA256withRSA`) |
| `cert_url` | header `PAYPAL-CERT-URL` |
| `transmission_id` | header `PAYPAL-TRANSMISSION-ID` |
| `transmission_sig` | header `PAYPAL-TRANSMISSION-SIG` |
| `transmission_time` | header `PAYPAL-TRANSMISSION-TIME` |
| `webhook_id` | the ID of YOUR registered webhook (Developer Dashboard / `GET /v1/notifications/webhooks`), NOT the client id |
| `webhook_event` | the parsed JSON body of the notification, unmodified |

Response `200`: `{ "verification_status": "SUCCESS" | "FAILURE" }` [SPEC enum]. Only act on `SUCCESS`.

Implementation notes ([SEARCH] https://developer.paypal.com/api/rest/webhooks/rest and the troubleshooting page):
- Read the raw body (`await req.text()` in a Next.js route handler) and `JSON.parse` it for `webhook_event`; do not re-serialize in a way that changes content. (Some failures are caused by body-parser mutation.)
- Header names are case-insensitive; HTTP/2 lowercases them (`paypal-transmission-id`).
- Sandbox webhooks need a public URL (tunnel or deployed host). In the sandbox, the Developer Dashboard "Webhooks simulator" / `POST /v1/notifications/simulate-event` ([SPEC] path exists) can send mock events, but simulated events fail real signature verification (UNVERIFIED). For local development, offer a flag that skips verification in dev only.
- Delivery / retry [SEARCH] https://developer.paypal.com/api/rest/webhooks: a non-2xx response causes retries, up to 25 times over 3 days; then the delivery is marked Failed (can be resent from the dashboard or `POST /v1/notifications/webhooks-events/{event_id}/resend`, [SPEC] 202). Events can arrive more than once and out of order: dedupe on `event.id`, make handlers idempotent, return 200 quickly and process asynchronously. Always reconcile state by GET rather than trusting event order.
- Treat webhooks as a confirmation channel for: PENDING -> final captures, refunds that were PENDING, and authorizations voided/expired by PayPal. Do not make the happy path depend on them (judges' environments may not have a public webhook URL).

---

## 12. Browser-side approval of an AUTHORIZE order

Constraint recap: Next.js 16 App Router; server bearer token must never reach the browser; must work in a judge's browser.

Key fact for all options: **the order's `intent` is set server-side in `POST /v2/checkout/orders`**. The browser SDK only receives an order id. The v6 session APIs have no `intent` parameter ([SDK] types contain no intent field); in v5 the SDK URL needs `intent=authorize` to match the order.

### (a) JS SDK v5 (legacy "paypal.Buttons")
- Script: `https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&intent=authorize&currency=USD` ([SDK] paypal-js README shows `https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&currency=EUR`; the `intent` query parameter is documented at https://developer.paypal.com/sdk/js/configuration/ -- [SEARCH] only, not read). Use the same URL for sandbox: sandbox is selected by using a **sandbox client id** (v5 convention; the host is the same). Any `data-` attributes optional.
- Methods: `paypal.Buttons({ createOrder, onApprove, onCancel, onError }).render('#el')`. `createOrder: () => fetch('/api/paypal/orders', {method:'POST'}).then(r=>r.json()).then(d=>d.id)` (returns the order id string). `onApprove: (data) => ...` with `data.orderID`; then call your server to authorize.
- Support status: [SEARCH] https://developer.paypal.com/pay-later/upgrade: v5 still receives security patches, no new features, no sunset date announced. The official `paypal-js` README labels the v5 loader "legacy". Works with intent=authorize (it is the classic documented flow, https://developer.paypal.com/docs/checkout/standard/customize/authorization/ -- [SEARCH]).
- Server endpoint shapes expected: `POST /api/paypal/orders` -> `{ id }`; `POST /api/paypal/orders/{id}/authorize`.
- Pros: simplest, huge amount of sample code, popup UX works in any modern browser. Cons: legacy, no new features. In React you would use `@paypal/react-paypal-js` `PayPalScriptProvider` with `options={{ clientId, intent: "authorize", currency: "USD" }}` (the v8 line of the package; API details UNVERIFIED here).

### (b) JS SDK v6 (current, "createInstance")
Verified from official source [SDK] github.com/paypal/paypal-js:
- Script URL is built in `src/v6/index.ts`: `https://www.sandbox.paypal.com/web-sdk/v6/core` for sandbox, `https://www.paypal.com/web-sdk/v6/core` for production. `loadCoreSdkScript({ environment: "sandbox" | "production" })` from `@paypal/paypal-js/sdk-v6` returns the `paypal` namespace (or `null` on the server). `environment` is required; "`clientId` does not determine which environment is loaded in v6".
- `const sdk = await paypal.createInstance({ clientId | clientToken, components: ["paypal-payments"], locale?, pageType?: "checkout", clientMetadataId?, partnerAttributionId?, testBuyerCountry? })`. Exactly one of `clientId` or `clientToken` (types enforce `never` on the other).
- `await sdk.findEligibleMethods()` then `eligibility.isEligible("paypal")` before showing the button (README example).
- `const session = sdk.createPayPalOneTimePaymentSession({ onApprove, onCancel?, onError?, onComplete?, onShippingAddressChange?, onShippingOptionsChange?, commit?, orderId?, savePayment?, testBuyerCountry? })`.
  - `onApprove(data)`: `data = { fundingSource, orderId, payerId?, billingToken? }`, returns `Promise<void>`.
  - `onCancel(data)`: `{ orderId? }`. `onError(err)`: `PayPalError` with `code`, `name`, `isRecoverable`. `onComplete({ paymentSessionState: "approved"|"canceled"|"error" })`.
- `session.start(presentationModeOptions?, paymentSessionPromise?: Promise<{ orderId: string }>)`. Default `{ presentationMode: "auto" }`. Modes in types: `"auto"`, `"popup"`, `"modal"`, `"redirect"` (with `autoRedirect?: { enabled: boolean }`), `"payment-handler"`, `"direct-app-switch"`. Also `session.cancel()`, `session.destroy()`, `session.hasReturned()`, `session.resume()` (for redirect return). `start()` resolves `void | { redirectURL?: string }`.
- Order creation: the order id is supplied as `Promise<{ orderId }>` in `start()`'s second argument (README example: `session.start({ presentationMode: "popup" }, createOrderOnServer)` where the server fetch returns `{ orderId: "..." }`). Note the JSON key is `orderId`, not `id`.
- Intent: not an SDK concern in v6 (no field). Whether v6 accepts orders with `intent: AUTHORIZE` in all presentation modes is not stated in anything we could read -- UNVERIFIED but expected (the order is the contract); confirm with a sandbox run. A [SEARCH] check of the v6 docs found no statement either way.
- Auth: `clientId` is the standard path for one-time PayPal payments ([SEARCH] https://developer.paypal.com/sdk/js/set-up, which describes the client token as for Fastlane; docs.paypal.ai says it is required for vaulting / Fastlane -- docs conflict). We therefore use `clientId` (public), and no server token reaches the browser. If we ever needed `clientToken`, mint it server-side with `response_type=client_token`.
- Support status: v6 is the current SDK, and paypal-js README says "For new integrations, use the V6 SDK" ([SDK] verified).
- Server endpoints it expects: `POST /api/paypal/orders` -> `{ orderId }`; `POST /api/paypal/orders/{orderId}/authorize` after `onApprove`.
- Packages: `@paypal/paypal-js` (`/sdk-v6` subpath) and a React package `@paypal/react-paypal-js` with v6 storybook ([SDK] repo README lists `react-paypal-js-storybook/v6`); the React API was not read, so use the vanilla loader in a client component.

### (c) Server-only redirect (no browser SDK)
- Create the order server-side with `experience_context.return_url` / `cancel_url`, take the `payer-action` (or `approve`) link, and send the browser there: `https://www.sandbox.paypal.com/checkoutnow?token=<ORDER_ID>`. [SPEC] link shape.
- After approval PayPal redirects to `return_url?token=<ORDER_ID>&PayerID=<payer_id>` (query names `token` and `PayerID` are the long-standing convention; UNVERIFIED in the v2 spec. **Sandbox 7 Nov: `token` confirmed**, `PayerID` not recorded, section 14 item 4). Your return route (Route Handler) calls `POST /authorize` with the `token` as order id, then redirects the user to the outing page.
- Cancel: `cancel_url?token=<ORDER_ID>`.
- The spec warns that without `return_url` a non-SDK flow breaks ("We're sorry, Things don't appear to be working at the moment" after approval).
- Official support: this is the documented Orders v2 redirect pattern. No JS dependency, no CSP/popup issues, survives popup blockers.

### Recommendation: (c) server-only redirect as the primary path, with v6 as an optional enhancement
Reasons:
1. Works in any judge's browser (no popup blockers, no third-party script, no CSP/`next/script` issues, no hydration issues in Next 16).
2. Zero secrets in the browser; the only public value is the order id in the URL, which is single-use and payer-bound.
3. It is the only option whose request/response shapes are fully verified from the official OpenAPI spec (`payer-action` link, `experience_context`, authorize).
4. Intent AUTHORIZE is trivially honoured (server-set). With v5/v6 an intent/SDK mismatch is a risk we cannot test here.

Add (b) v6 as an optional "popup" polish only after the redirect flow is proven in sandbox (use `presentationMode: "popup"` with `clientId`, same server endpoints). Avoid (a): it is the legacy line and brings no benefit over (b).

Next.js implementation sketch (server-side only; re-read `node_modules/next/dist/docs/` first per AGENTS.md since this Next version has breaking changes):
- `POST /api/paypal/orders` (Route Handler): create order, store `{outingId, payerId, orderId, status: 'CREATED'}`, return `{ approveUrl }`.
- `GET /api/paypal/return?token=...`: authorize, store authorization id + expiration, redirect.
- `GET /api/paypal/cancel?token=...`: mark cancelled, redirect.
- Cron / server action at the deadline: capture / void / refund.

As built, the routes differ from this sketch: `POST /api/outings/:id/payments` creates the order, PayPal sends the buyer back to `GET /api/payments/paypal/return` or `GET /api/payments/paypal/cancel`, and the deadline work runs in the worker (`npm run worker`) or through `POST /api/cron/tick`.

---

## 13. Sandbox setup and negative testing

### Accounts [fetched] https://github.com/paypaldev/getting-started-with-paypal-sandbox (official PayPal dev repo)
1. Sign in to https://developer.paypal.com/dashboard/ with a real PayPal login; switch to the **Sandbox** environment.
2. Default accounts are auto-created: one **Business** (seller, has the REST app) and one **Personal** (buyer). Emails look like `sb-xxxx@business.example.com` / `sb-xxxx@personal.example.com`.
3. Testing Tools -> Sandbox Accounts -> Create Account (Account Type Personal or Business, Country) or "Create Custom Account" for custom balance / card.
4. Each account has a generated email and password; manage via `...` -> View/Edit Account (balance, currency, password). A Personal account needs a balance to pay with its PayPal balance.
5. API credentials: Apps & Credentials -> Sandbox tab -> Default Application or Create App -> copy Client ID and Secret. Use separate sandbox / live keys.
6. Buyer approval pages live on `https://www.sandbox.paypal.com`; log in as the Personal account. Create several Personal accounts to demo multiple payers.

### Negative testing with `PayPal-Mock-Response`
Source: [SEARCH] https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/ (also https://developer.paypal.com/docs/api-basics/sandbox/request-headers/). The page itself could not be read; the format below is stated consistently by several search summaries, and the first example matches the long-standing documented format.

- Header (sandbox host only; ignored / rejected on live): 
```
PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}
```
- Official example pattern (order capture + `DUPLICATE_INVOICE_ID`):
```bash
curl -v -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER_ID/capture \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H 'PayPal-Mock-Response: {"mock_application_codes":"DUPLICATE_INVOICE_ID"}'
```
- For our compensation demo (capture fails -> refund the already-captured peers):
```bash
curl -X POST https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH_ID/capture \
  -H "Content-Type: application/json" -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "PayPal-Request-Id: capture-test-1" \
  -H 'PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}' \
  -d '{"amount":{"currency_code":"USD","value":"10.00"},"final_capture":true}'
```
  Expected: HTTP `422` with `name: UNPROCESSABLE_ENTITY` and `details[0].issue: INSTRUMENT_DECLINED` (community post shows that response shape, [SEARCH]). Exactly which Payments v2 endpoints accept the header is UNVERIFIED: [SEARCH] says the supported list includes "capturing an authorized payment" and "showing authorized payment details", and one community user got `INVALID_NEGATIVE_TESTING_INPUT` ("URL must be supported by negative testing") for an unsupported URL, so test each endpoint (void, refund, reauthorize) and fall back to a code-level fake if it is rejected.
- Codes named in sources: `INSTRUMENT_DECLINED`, `TRANSACTION_REFUSED`, `INTERNAL_SERVER_ERROR`, `DUPLICATE_INVOICE_ID` (capture); `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_ALREADY_CAPTURED` (delay-capture negative-test table) [SEARCH]. Full per-endpoint list is on https://developer.paypal.com/tools/sandbox/negative-testing/error-codes/ (UNVERIFIED URL) / the Payments v2 and Orders v2 errors pages.
- Known caveats [SEARCH]: one community report of a mock code with no effect (capture still `COMPLETED`); a 403 report using the header (see https://www.paypal-community.com/t5/Sandbox-Environment/PayPal-Mock-Response-header-not-working-got-403-error-instead/td-p/3184342). Do not make the demo depend solely on this: implement a server-side `MOCK_PAYPAL_FAIL_PAYER=<id>` switch in our adapter that adds the header per payer (and a pure in-process fake fallback).
- Alternative: the business sandbox account has a "Negative Testing" toggle in the Developer Dashboard (account settings) that makes the account return errors instead of approvals [SEARCH]; coarse, affects all calls.
- Amount-based failures: no official "magic amount" for PayPal-wallet REST payments is documented in anything we read; UNVERIFIED. (Community thread: a very large amount causes `INSTRUMENT_DECLINED`, https://www.paypal-community.com/t5/REST-APIs/Sandbox-and-REST-API-Large-amount-causes-instrument-declined/td-p/1163832 -- [SEARCH] title only.)

---

## 14. Open items to confirm in sandbox (first hour of implementation)

Results from the owner's sandbox runs on 7 Nov 2026 (`scripts/paypal-smoke.ts`; evidence in `docs/evidence/`, summary in `docs/evidence/README.md`) are marked **Sandbox 7 Nov**.

1. After capture of $10 with `final_capture: true` against a $20 authorization: GET authorization status, and whether the $10 remainder is released automatically. If not, call void. **Sandbox 7 Nov: answered.** The $10 capture is `COMPLETED`, the authorization reads `CAPTURED` (not `PARTIALLY_CAPTURED`), and no void is needed for the remainder.
2. Whether the sandbox Business account needs any partial-capture setting. **Sandbox 7 Nov: not needed** for the default sandbox Business account; under-capture worked with no settings changed.
3. Create order with `experience_context` + AUTHORIZE: exact `status` (`PAYER_ACTION_REQUIRED` vs `CREATED`) and link rel (`payer-action` vs `approve`). **Sandbox 7 Nov: status is `PAYER_ACTION_REQUIRED`**; an approval link was returned and worked (the adapter prefers `payer-action`, falls back to `approve`; which rel was used is not recorded).
4. Return-URL query params (`token`, `PayerID`). **Sandbox 7 Nov: `token` confirmed on both.** The cancel redirect carried `?token=<order id>` (seen in the browser), and three approvals in the full app outing completed through `/api/payments/paypal/return`, which rejects a return without `token` (`MISSING_TOKEN`). `PayerID` was not recorded and the app does not use it.
5. Which of capture / void / refund accept `PayPal-Mock-Response`; actual response for void on VOIDED / CAPTURED authorization. Still open (`--mock-decline` not run yet).
6. Exact 422 issue codes for: authorize with unapproved order, authorize twice, capture after void, capture after expiry. **Sandbox 7 Nov: capture after void → HTTP 422 `AUTHORIZATION_VOIDED`** (the adapter already handles this code). The others are still open.
7. Idempotency replay status codes on authorize / capture (200 vs 201) and what happens with a reused key on a different payload. **Sandbox 7 Nov: replaying a capture with the same `PayPal-Request-Id` returns the same capture** (HTTP status not recorded); reuse with a different payload is still open.
8. Webhook event names list from https://developer.paypal.com/api/rest/webhooks/event-names, and whether the webhook `resource` for capture events carries `supplementary_data.related_ids.authorization_id`.
9. Allow `developer.paypal.com` in the session network settings if a follow-up pass should read the docs directly.

## 15. Source index

Fetched and read directly:
- https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/checkout_orders_v2.json
- https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/payments_payment_v2.json
- https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/notifications_webhooks_v1.json
- https://raw.githubusercontent.com/paypal/paypal-js/main/packages/paypal-js/README.md
- https://raw.githubusercontent.com/paypal/paypal-js/main/packages/paypal-js/src/v6/index.ts
- https://raw.githubusercontent.com/paypal/paypal-js/main/packages/paypal-js/types/v6/index.d.ts
- https://raw.githubusercontent.com/paypal/paypal-js/main/packages/paypal-js/types/v6/components/paypal-payments.d.ts
- https://raw.githubusercontent.com/paypal/paypal-js/main/packages/paypal-js/types/v6/components/base-component.d.ts
- https://raw.githubusercontent.com/paypaldev/getting-started-with-paypal-sandbox/main/README.md

Seen only via WebSearch summaries (page not readable here):
- https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/
- https://developer.paypal.com/checkout/delay-capture
- https://developer.paypal.com/payment-methods/auth-honor
- https://developer.paypal.com/checkout/extend-authorization
- https://developer.paypal.com/checkout/void-authorized-payment
- https://developer.paypal.com/api/rest/integration/payments-api/v1-v2-migration
- https://developer.paypal.com/api/rest/authentication , https://developer.paypal.com/reference/get-an-access-token/
- https://developer.paypal.com/api/rest/reference/idempotency , https://developer.paypal.com/api/rest/requests/
- https://developer.paypal.com/api/rest/webhooks , https://developer.paypal.com/api/rest/webhooks/rest , https://developer.paypal.com/api/rest/webhooks/event-names
- https://developer.paypal.com/v5-v6 , https://developer.paypal.com/sdk/js/set-up , https://developer.paypal.com/pay-later/upgrade
- https://developer.paypal.com/api/nvp-soap/do-capture-nvp/ , https://developer.paypal.com/api/deprecated/payments/v1/authorization-capture
- https://developer.paypal.com/api/rest/reference/orders/v2/errors/ , https://developer.paypal.com/api/rest/reference/payments/v2/errors/ (error pages: names only from snippets)
