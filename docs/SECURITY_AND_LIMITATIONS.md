# Security and limitations

Scope: a hackathon demo that uses PayPal **sandbox** only. This is a summary of what the code does and does not do. It has not had an external security review. Two internal, independent audits were run during the build (payments/settlement; privacy/access/consent); every confirmed defect was fixed with a regression test in `tests/audit` and `tests/audit2` (see [HANDOFF_TO_CODEX.md](HANDOFF_TO_CODEX.md)).

## Threat model summary

| Area | What we do | Where |
|---|---|---|
| Sessions | Participant and merchant sessions are HMAC-signed cookies (`outings_p`, `outings_m`), `HttpOnly`, `SameSite=Lax`, `Secure` in production. Merchant sessions expire 12 h after login (checked on every request, not only by cookie lifetime). | `lib/auth/session.ts` |
| Invitation tokens | 256-bit random tokens, shown once, stored only as SHA-256 hashes. The `/i/:token` route verifies the hash and sets the session. Demo-only deterministic tokens exist for fixture outings. | `lib/auth/tokens.ts` |
| Server-side authorization | Route handlers are thin: session, then an access check (`requireParticipant`, `requireOrganizer`, `requireMerchant`), then a service. Participants see only their own outing; merchants only their own outings; nobody can act on another participant's consent, attempt or hold. Random and sequential ids are rejected. | `lib/services/access.ts`, `tests/access` |
| CSRF | State-changing routes check that `Origin` matches the host (plus `SameSite=Lax`). A request with no `Origin` header is allowed through (non-browser clients), so this is defence in depth, not a complete CSRF defence. | `assertSameOrigin` in `lib/http.ts` |
| Rate limits | Token buckets per client IP and route for outing creation, AI calls, votes, mutations, merchant login, invites and demo endpoints. In-memory and per instance (see limitations). The client IP honours `TRUSTED_PROXY_HOPS`: with N trusted proxies it is the N-th `X-Forwarded-For` entry from the right (then `X-Real-IP`); with 0 (default) no forwarding header is trusted and callers share one bucket per route. | `lib/rate-limit.ts`, [DEPLOYMENT.md](DEPLOYMENT.md) |
| Prompt injection | User and merchant text is passed as delimited untrusted data; instructions inside it are ignored. The model only extracts facts, and its output is validated by schema: invented offering ids, unstated budgets and out-of-range suggestions are dropped or clamped; URLs are stripped. The model cannot set policy, amounts or deadlines. Dashboard queries are limited to a whitelist of read-only filter fields and can never call capture, void or refund. | `lib/ai/prompts.ts`, `lib/ai/validate.ts`, tests: "prompt injection" in `tests/services` and `tests/access` |
| Secrets | PayPal credentials, the Anthropic key, `SESSION_SECRET`, `CRON_SECRET` and the AG Studio key are read server-side from the environment and never committed (`.env.example` holds names only). The PayPal base URL is hard-coded to the sandbox host. `/api/health` reports modes, not values. The Studio licence key is configuration only. | `lib/env.ts` |
| Webhooks | `POST /api/webhooks/paypal` verifies the signature through PayPal and rejects everything when `PAYPAL_WEBHOOK_ID` is not set. Events are deduplicated by event id, stored redacted, and only trigger a re-read of provider state. **Signature verification is tested against a mocked PayPal only.** | `lib/webhooks/paypal.ts`, `tests/settlement/webhook.test.ts` |
| Payee | The PayPal payee for orders and the expected payee when verifying an authorization come from the merchant's own row (`merchants.paypal_merchant_id`), falling back to `PAYPAL_MERCHANT_ID`. An authorization paid to anyone else is never admitted and its hold is voided. FIXTURE attempts carry no payee. | `expectedPayeeFor` in `lib/services/payments.ts`, `tests/payments/payee.test.ts` |
| Organizer cancel | An organizer cannot cancel after the commitment deadline; the booking is settled against the stored deadline. | `lib/services/outings.ts`, `tests/audit2` |
| Scheduler endpoint | `/api/cron/tick` requires `Authorization: Bearer $CRON_SECRET`. | `app/api/cron/tick/route.ts` |
| PII in logs and prompts | Audit events avoid full provider ids; webhook payloads are redacted for nested PII keys; error text is truncated; server errors log the message only. Model prompts receive sanitized data and never private votes or per-person amounts. | `lib/audit.ts`, `lib/webhooks/paypal.ts` |
| Private votes | Budget votes are returned only to their own voter. The reveal exposes an aggregate distribution with no names, and only with 3 or more votes. | `lib/services/views.ts`, `tests/access` |

## HTTP security headers

Built in `lib/security/headers.ts`; the static ones are set by `next.config.ts` `headers()` on every route, the Content-Security-Policy per request by `proxy.ts` (nonce-based, per the Next.js CSP guide).

| Header | Value | Notes |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-<per-request>' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self' https://www.sandbox.paypal.com https://www.paypal.com; base-uri 'self'; object-src 'none'` | Fresh nonce on every request. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `/i/:token` responses (redirect and error page) send `no-referrer`. |
| `X-Content-Type-Options` | `nosniff` | |
| `X-Frame-Options` | `DENY` | Same intent as `frame-ancestors 'none'` for old browsers. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | The app uses none of these. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Only when `NODE_ENV=production` and `APP_BASE_URL` is `https:`; evaluated when the server starts. |

Relaxations and why:

- `style-src 'unsafe-inline'`: React `style` attributes and the runtime styles of AG Grid / AG Studio / AG Charts. Scripts stay strict (no `'unsafe-inline'`, no `'unsafe-eval'` in production).
- Nonce means every page renders per request (the root layout awaits `connection()`): no static prerendering or CDN caching of HTML. Most screens show live payment state anyway.
- `next dev` only: `script-src` adds `'unsafe-eval'` (React debugging) and `connect-src` adds `ws: wss:` (HMR).
- `form-action` lists PayPal because the fixture/PayPal flow may post or redirect there; the approval redirect itself uses `window.location`, which CSP does not restrict.

## Payment safety invariants

1. Money is integer minor units, one currency (USD) per outing; no floats.
2. Shares sum exactly to the total and differ by at most one cent, in an immutable stable order.
3. No capture above the consented cap or the authorized amount: checked in the policy, when planning an operation, just before sending, and by a database constraint.
4. Consent is bound to a hash of the exact terms; any change means new consent.
5. Commitments are accepted only while the outing is collecting and before the **server** deadline. The browser clock is display only.
6. Authorizations created after the deadline, or that cannot be verified, are never admitted; they are voided (fail closed).
7. Settlement is decided once per outing under a row lock into an immutable snapshot. Provider calls never run inside an open transaction.
8. Every provider mutation has a durable outbox row and a stable `PayPal-Request-Id`. Timeouts are UNKNOWN and are reconciled from provider state before any retry. Two concurrent workers send each capture exactly once.
9. A failed capture never confirms the booking and never moves its share onto the others; completed captures are refunded and the rest voided.
10. Booking status and payment clean-up are separate. Clean-up is `COMPLETE` only when the provider confirmed every void and refund; otherwise it is shown as pending or needing attention.
11. AI never decides money, eligibility, deadlines or provider operations.

## Limitations (honest list)

- **Sandbox only.** No real money. The PayPal host is hard-coded to the sandbox.
- **PayPal behaviour is unverified.** The adapter is written from the OpenAPI specs and tested against a mocked `fetch`; the build environment could not reach PayPal. Unconfirmed items from [research/PAYPAL.md](research/PAYPAL.md) section 14 include: under-capture ($20 authorization, $10 `final_capture`) and whether the remainder is released automatically; the order status and link relation after creating an AUTHORIZE order with `experience_context`; return-URL query parameters; which of capture, void and refund accept `PayPal-Mock-Response`; exact error codes for authorize/capture edge cases; idempotency replay status codes; and the webhook event names and resource shape.
- **Real Claude is unverified.** Tests use a mocked SDK. Fixture AI is deterministic and not a language model.
- **One merchant, one currency (USD), FIXED_TOTAL pricing** for shared bookings. PER_ATTENDEE items are rejected for shared bookings.
- **No external venue booking, escrow, pooled balances or organizer payouts.**
- **Authorization honour period.** Commitment windows are limited to 48 hours so holds stay inside PayPal's honour period; real-world extension is not implemented.
- **In-memory rate limiter.** Per process, resets on restart, and is not shared across instances. Use an edge or shared limiter in production.
- **CSRF check is lenient** when no `Origin` header is sent.
- **Sessions are signed cookies, not server-side records.** There is no per-session revocation; rotate `SESSION_SECRET` to invalidate all of them.
- **Invitation delivery.** No email, SMS or WhatsApp sending. The organizer receives each link once and shares it by hand.
- **Organizer is a required payer.** Organizer transfer and changing the quote after opening collection are not supported (a change means new terms and renewed consent).
- **AG Studio is commercial software** used under a 45-day evaluation trial (watermark off localhost). The trial must cover the demo window through 15 Dec 2026. AG Grid Community is MIT.
- **Hosted demo and scheduler are documented, not deployed** at the time of writing ([DEPLOYMENT.md](DEPLOYMENT.md)).
- **Rate-limit client IP depends on `TRUSTED_PROXY_HOPS`.** The default (0) trusts no forwarding header, so all callers share one bucket per route: clients cannot spoof their way into fresh buckets, but on a hosted deployment one busy or abusive client can use up a route's limit for everyone. Set it to the number of proxies in front of the app ([DEPLOYMENT.md](DEPLOYMENT.md)). Once it is set, the key is only as trustworthy as that count: too high lets a client choose its key with a forged `X-Forwarded-For`, and too low groups users behind a proxy address. `X-Real-IP` is used only when N > 0 and `X-Forwarded-For` is too short, and must then be set by the trusted proxy.
- **Browser end-to-end tests** (`tests/e2e`) run in FIXTURE modes only; the real PayPal sandbox approval page has not been exercised.
- **Demo mode** (`DEMO_FIXTURES_ENABLED=true`) exposes one-click merchant login and persona switching. Never enable it where real data is held.
- Accessibility and cross-browser testing were not exhaustively performed.
