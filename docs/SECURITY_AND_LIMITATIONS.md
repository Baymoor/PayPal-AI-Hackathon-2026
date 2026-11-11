# Security and limitations

Outings is a hackathon build on the PayPal **sandbox** only; this page lists what the code enforces, where, which test pins it, and what is not done or not verified.

There has been no external security review. Three internal audits ran during the build (payments and settlement; privacy, access and consent; code added later); every confirmed defect was fixed with a regression test in [tests/audit](../tests/audit), [tests/audit2](../tests/audit2) and [tests/audit3](../tests/audit3) (status in [HANDOFF_TO_CODEX.md](HANDOFF_TO_CODEX.md)). Database resilience, judge mode, the demo venues, per-outing vote amounts, the judge sign-in, per-outing AI mode and the gentler demo reset came after the third audit: they have tests, not an audit. The payment invariants (integer money, caps, consent hash, exactly-once capture, compensation) are in the [architecture invariants table](ARCHITECTURE.md).

Related: [README](../README.md) · [judge guide](JUDGE_GUIDE.md) · [testing](TESTING.md) · [PayPal sandbox evidence](evidence/README.md) · [deployment](DEPLOYMENT.md)

## Controls

Every route handler runs session, then access check, then service; hidden buttons are never access control.

| Area | What the code does | Code | Test |
|---|---|---|---|
| Sessions | HMAC-signed cookies `outings_p` and `outings_m`: `HttpOnly`, `SameSite=Lax`, `Secure` in production. Merchant sessions expire 12 h after sign-in, checked on every request. | [session.ts](../lib/auth/session.ts) | [access-audit2.test.ts](../tests/audit2/access-audit2.test.ts) |
| Judge sign-in | On only when `JUDGE_PASSWORD` is set. Then `/new`, `POST /api/outings` (401 `JUDGE_LOGIN_REQUIRED`), the AG Studio assistant and Claude behind the venue's plain-language filter need the signed `outings_judge` cookie from `/judge/login`; everyone else gets the sample parser in that filter. Constant-time check, one answer for a wrong username or password, a lockout after repeated failures. Not gated: home, `/how-it-works`, `/demo`, invitation links, the demo merchant dashboard and `/setup` (its own owner password). | [judge.ts](../lib/auth/judge.ts) | [judge-login.test.ts](../tests/access/judge-login.test.ts), [judge-login.spec.ts](../tests/e2e/judge-login.spec.ts) |
| Model budget on demo outings | Demo outings (seeded, and every `/demo` story) always use the sample AI, even with an Anthropic key, so an anonymous visitor never triggers a model call; their `ai_runs` rows and screens say FIXTURE / sample. Real outings use the deployment's AI. | `aiModeForOuting` in [lib/ai/index.ts](../lib/ai/index.ts), `callAi` in [outings.ts](../lib/services/outings.ts) | [ai-mode-per-outing.test.ts](../tests/services/ai-mode-per-outing.test.ts) |
| Invitation links | 256-bit random tokens, shown once, stored only as SHA-256. `/i/:token` sends `Referrer-Policy: no-referrer`. Deterministic tokens exist only for seeded fixture outings. | [tokens.ts](../lib/auth/tokens.ts), [route](../app/i/[token]/route.ts) | [outings.test.ts](../tests/services/outings.test.ts) |
| Authorization | `requireParticipant`, `requireOrganizer`, `requireMerchant`: participants see only their outing, merchants only their own bookings; tampered, random and cross-outing ids are rejected. | [access.ts](../lib/services/access.ts) | [access.test.ts](../tests/access/access.test.ts) |
| Private votes | Vote amounts go only to their voter. The reveal needs 75% of the group and at least 3 votes, and shows an anonymous distribution. A vote creates no consent or payment. | [views.ts](../lib/services/views.ts) | [access.test.ts](../tests/access/access.test.ts), [access-audit2.test.ts](../tests/audit2/access-audit2.test.ts) |
| CSRF | Mutations require `Origin` to match the host, on top of `SameSite=Lax`. A request without `Origin` passes, so this is defence in depth. | `assertSameOrigin` in [http.ts](../lib/http.ts) | [access.test.ts](../tests/access/access.test.ts) |
| Rate limits | Token buckets per client IP and route (create, AI, vote, mutation, merchant login, invite, demo). Client IP follows `TRUSTED_PROXY_HOPS`. | [rate-limit.ts](../lib/rate-limit.ts) | [rate-limit.test.ts](../tests/services/rate-limit.test.ts) |
| Scheduler | `/api/cron/tick` needs `Authorization: Bearer $CRON_SECRET` (constant-time compare). Without `CRON_SECRET` it is open only outside production with demo fixtures on; otherwise 503. | [cron route](../app/api/cron/tick/route.ts) | [access-audit2.test.ts](../tests/audit2/access-audit2.test.ts) |
| Webhooks | Signature verified through PayPal; without `PAYPAL_WEBHOOK_ID` every delivery is rejected. Deduplicated by event id, stored redacted, and only triggers a re-read of PayPal state. | [paypal.ts](../lib/webhooks/paypal.ts) | [webhook.test.ts](../tests/settlement/webhook.test.ts) (mocked PayPal) |
| PayPal host and payee | The adapter refuses any API base but the sandbox. Orders are paid to the merchant row's `paypal_merchant_id`, else `PAYPAL_MERCHANT_ID`; an authorization to anyone else is never admitted and is voided. | [paypal.ts](../lib/payments/paypal.ts), `expectedPayeeFor` in [payments.ts](../lib/services/payments.ts) | [paypal.test.ts](../tests/payments/paypal.test.ts), [payee.test.ts](../tests/payments/payee.test.ts) |
| Prompt injection | User and merchant text is wrapped as delimited untrusted data; output is schema-validated and cannot set amounts, policy or deadlines. Dashboard and AG Studio AI get read-only tools only. | [prompts.ts](../lib/ai/prompts.ts), [validate.ts](../lib/ai/validate.ts) | [ai.test.ts](../tests/ai/ai.test.ts), [access.test.ts](../tests/access/access.test.ts) |
| Secrets | PayPal, Anthropic, session, cron and AG Studio keys are read server-side from the environment; [.env.example](../.env.example) has no secret values. `/api/health` reports modes, not values. | [env.ts](../lib/env.ts) | [access.test.ts](../tests/access/access.test.ts) |
| PII | Audit events avoid full provider ids; webhook payloads are redacted; server errors log the message only. Prompts get names and public catalogue data, never per-person amounts. | [audit.ts](../lib/audit.ts) | [plan-draft.test.ts](../tests/services/plan-draft.test.ts), [webhook.test.ts](../tests/settlement/webhook.test.ts) |
| Fixture labelling | Simulated payments and AI are labelled end to end ("Simulated · not real PayPal", "Sample AI text"; FIXTURE in the code), per outing; a fixture outing never uses real PayPal or Claude, and a real outing never uses the payment simulator. | [fixture.ts](../lib/payments/fixture.ts), [index.ts](../lib/payments/index.ts) | [access-audit2.test.ts](../tests/audit2/access-audit2.test.ts), [payments-audit.test.ts](../tests/audit/payments-audit.test.ts) |

## Judge mode (demo only)

Judge mode (the **Acting as** bar) is separate from the judge sign-in. It exists only with `DEMO_FIXTURES_ENABLED=true`, and in it any participant of an outing can act as any other participant of that same outing, organizer included, without their invitation link.

- Every refusal (other outing, unknown id, no session, demo off) is the same 404, so the endpoint is not an existence oracle. Each switch is audited as `DEMO_PERSONA_SWITCHED` with ids only.
- A PayPal return still authorizes only the attempt's own participant, so switching mid-approval cannot authorize someone else's hold.
- Real deployments must set `DEMO_FIXTURES_ENABLED=false`.

Code: `authorizePersonaSwitch` in [judge-persona.ts](../lib/demo/judge-persona.ts), [persona route](../app/api/demo/persona/route.ts). Test: [judge-persona.test.ts](../tests/services/judge-persona.test.ts).

## Demo reset (demo only)

Anyone can press **Reset demo data** on `/demo` (`POST /api/demo/reset`, rate-limited). It re-seeds the standard demo outings and deletes older `/demo` stories, but leaves any story started in the last 15 minutes, so one visitor cannot wipe another's run mid-story. Real outings are never touched. Stories are recognised by their exact titles; their backdated history is allowed for when measuring the 15 minutes.

Code: `deleteFixtureOutings` and `seedDemo` in [seed.ts](../lib/demo/seed.ts). Test: [demo-scenarios.test.ts](../tests/services/demo-scenarios.test.ts).

## HTTP security headers

[proxy.ts](../proxy.ts) sets a nonce-based CSP and HSTS per request from the runtime environment; [next.config.ts](../next.config.ts) sets the static headers and turns off `X-Powered-By`. Builders: [headers.ts](../lib/security/headers.ts); tests: [security-headers.test.ts](../tests/services/security-headers.test.ts), [headers-audit3.test.ts](../tests/audit3/headers-audit3.test.ts).

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<per request>' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:;
  connect-src 'self'; frame-ancestors 'none'; form-action 'self' https://www.sandbox.paypal.com https://www.paypal.com;
  base-uri 'self'; object-src 'none'
Referrer-Policy: strict-origin-when-cross-origin      (no-referrer on /i/:token)
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Strict-Transport-Security: max-age=63072000; includeSubDomains   (production with an https APP_BASE_URL only)
```

- `style-src 'unsafe-inline'` is for React `style` attributes and AG Grid, AG Studio and AG Charts runtime styles; scripts allow no inline code and no eval in production.
- `next dev` only adds `'unsafe-eval'` to `script-src` and `ws: wss:` to `connect-src`.
- The nonce makes every page render per request, so HTML is never statically cached.

## Not verified

These statements are exactly as strong as the evidence; see [testing](TESTING.md) for what did pass.

- **Real Claude.** The automated tests mock the SDK; [ai-smoke.ts](../scripts/ai-smoke.ts) ran against the real API on the hosted demo on 11 Nov 2026: a full run passed 12 of 13 checks, and the failing venue ranking was fixed and passed 3 of 3 reruns.
- **PayPal webhooks.** Signature verification is tested against a mocked PayPal only; no real delivery has reached the app (no `PAYPAL_WEBHOOK_ID` locally, and PayPal cannot call `localhost`).
- **PayPal negative testing.** `PayPal-Mock-Response` (`--mock-decline`) has not been run; the capture-decline and compensation path is tested with the FIXTURE simulator and a mocked `fetch`. Other open PayPal questions are in [research/PAYPAL.md](research/PAYPAL.md), section 14.
- **The real PayPal approval page** was used by hand on 7 Nov 2026 (smoke script and one full outing, [evidence](evidence/README.md)); the Playwright suite runs in FIXTURE modes only.
- **Hosted deployment.** Live at https://outings.baymoor.dev ([DEPLOYMENT.md](DEPLOYMENT.md)), checked by hand on 10 and 11 Nov 2026 ([testing](TESTING.md)).
- Accessibility and cross-browser testing were not exhaustive.

## Limitations

The build makes these deliberate trade-offs; each is a known gap, not a bug.

- **Sandbox only.** No real money; live PayPal endpoints are not configurable.
- **Demo catalogue.** Five seeded demo merchants, four of them fictional venues; no merchant onboarding. Password sign-in opens The Sound Room only; demo sign-in can open any of the five. The owner's `/setup` diagnostics (settings overview, PayPal and Anthropic test buttons) open only to a password sign-in: the session cookie records how it was opened, and the page and its API routes refuse demo sign-ins.
- **USD and `FIXED_TOTAL` only** for shared bookings; `PER_ATTENDEE` offerings are rejected at opening. No venue booking API, escrow, pooled balance or organizer payout.
- **48-hour commitment window**, so holds stay inside PayPal's honor period; reauthorization is not implemented.
- **In-memory rate limiter**, per process and reset on restart. With the default `TRUSTED_PROXY_HOPS=0` no forwarding header is trusted and all callers share one bucket per route; set it to the number of proxies in front of the app ([DEPLOYMENT.md](DEPLOYMENT.md)). Too high lets a client pick its key with a forged `X-Forwarded-For`.
- **Lenient CSRF check** when no `Origin` header is sent.
- **Stateless sessions.** No per-session revocation; rotating `SESSION_SECRET` signs everyone out.
- **One shared judge password.** No per-judge accounts; changing `JUDGE_USERNAME` or `JUDGE_PASSWORD` signs every judge out.
- **AI on a judge's outing is not gated per call.** The reveal summary, venue ranking and plan draft of a real outing call Claude for whoever presses the button: someone the judge invited could, and in judge mode anyone in the outing can act as its organizer. Per-outing and per-client rate limits and the Console spend cap still apply.
- **No invitation delivery.** The organizer sees each link once and shares it by hand.
- **Organizer is a required payer.** No organizer transfer; changing the quote after opening means new terms and renewed consent.
- **AG Studio is commercial software.** AG Grid's [6 Nov 2026 blog post](https://www.ag-grid.com/blog/build-a-payments-dashboard-without-building-a-dashboard/) says hackathon entries need no licence and that AG Grid provides the key for the judging period. AG Grid Community is MIT.
