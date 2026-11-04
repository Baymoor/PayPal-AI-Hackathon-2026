# PayPal sandbox evidence

**Status: nothing in this folder is verified until the project owner runs the smoke test below with real sandbox credentials.** The Outings PayPal adapter (`lib/payments/paypal.ts`) was written from the official OpenAPI specs (see `docs/research/PAYPAL.md`) and is unit-tested only against a mocked `fetch`; the build containers cannot reach `api-m.sandbox.paypal.com`. A JSON file appears here only after a real run.

## What the smoke test proves

`scripts/paypal-smoke.ts` drives the real adapter (same code the app uses) against the **PayPal REST sandbox** — never live:

| Flow | Steps | Open question it answers (PAYPAL.md §14) |
|---|---|---|
| `capture` | AUTHORIZE order $20 → buyer approval → authorize → capture **$10** with `final_capture: true` → replay the capture with the same `PayPal-Request-Id` → GET authorization → void the remainder if it is still `PARTIALLY_CAPTURED` | Is under-capture supported? What status does the authorization have afterwards, and is the $10 remainder released automatically? Is capture idempotent on the request id? |
| `void` | AUTHORIZE $20 → approval → authorize → (optional `--mock-decline`: capture with `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}`) → void → GET → capture after void | Does void work and read back `VOIDED`? Which issue code does capture-after-void return? Is the negative-testing header honoured on capture? |
| `refund` | AUTHORIZE $20 → approval → authorize → capture $20 → refund $20 → GET refund | Full refund path and refund status (`COMPLETED` / `PENDING`). |

Each flow needs one buyer approval in the browser, so a full run asks you to approve three times.

## How to run (owner's machine)

1. In the PayPal Developer Dashboard (**Sandbox**), have one Business account with a REST app and at least one Personal (buyer) account with a balance. Copy the app's Client ID and Secret.
2. From the repo root:

   ```bash
   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npx tsx scripts/paypal-smoke.ts
   # options:
   #   --mock-decline              add the INSTRUMENT_DECLINED negative-testing capture to the void flow
   #   --approval-timeout=600      seconds to wait for each approval (default 600)
   #   --only=capture,void,refund  run a subset
   ```

   Values are also read from `.env.local` if present. `PAYPAL_MERCHANT_ID` (optional) is sent as the payee.
3. For each flow the script prints a `https://www.sandbox.paypal.com/checkoutnow?token=…` link. Open it, log in as the **Personal** sandbox buyer and approve. You will then land on `example.com` — that is expected (the script polls the order until it is `APPROVED`).
4. The script writes `docs/evidence/paypal-sandbox-<timestamp>.json` and exits non-zero if any expectation was not met.

## What the evidence file contains

- Per step: name, timestamp, `ok`, the expectation and whether it was met, and on failure the adapter's `kind` / issue `code` / HTTP status / PayPal `debug_id`.
- Statuses and integer minor-unit amounts.
- **Redacted**: provider ids are truncated (first 3 / last 4 characters). No buyer emails or names, no access tokens, client secrets or approval links are written.
- `findings`: `underCaptureSupported`, `captureReplayIdempotent`, `authorizationStatusAfterFinalPartialCapture`, `remainderNeededExplicitVoid`, `captureAfterVoidIssue`, `mockDeclineHonoured`, `refundStatus`, `failedSteps`.

Review the file before committing it. If under-capture is not supported, do **not** disguise a refund as a lower capture — document the reauthorization fallback instead (PRODUCT_SPEC §7).
