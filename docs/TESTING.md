# Testing

543 Vitest tests in 45 files (most against a real Postgres) and 8 Playwright browser tests pin the money, consent and access rules; the real PayPal sandbox is checked by two scripts, and real Claude by a smoke script run on the hosted demo.

Related: [README](../README.md) · [judge guide](JUDGE_GUIDE.md) · [architecture invariants](ARCHITECTURE.md) · [security and limitations](SECURITY_AND_LIMITATIONS.md) · [PayPal sandbox evidence](evidence/README.md)

## Run it

You need Node 22.12+ and an empty Postgres 16 database; the defaults below match CI.

```bash
# Postgres 16 with an empty outings_test database (same as CI)
docker run -d --name outings-test-db -p 5432:5432 -e POSTGRES_USER=outings \
  -e POSTGRES_PASSWORD=outings -e POSTGRES_DB=outings_test postgres:16

npm ci
npm run typecheck && npm run lint
npm test                                  # all 42 Vitest files
npx vitest run tests/settlement           # one folder; add -t "fragment" for one test

npx playwright install chromium           # once
E2E_DATABASE_URL=postgres://outings:outings@localhost:5432/outings_test npm run test:e2e
```

- Vitest reads `TEST_DATABASE_URL` from the shell (default `postgres://outings:outings@localhost:5432/outings_test`), never from `.env.local`. Each integration file calls `useTestDb()` ([db.ts](../tests/helpers/db.ts)), which migrates and truncates every table before each test; files run serially ([vitest.config.ts](../vitest.config.ts)).
- `npm run test:e2e` builds the app, serves it on port 3400 in FIXTURE modes with PayPal and Anthropic keys blanked, and **truncates and re-seeds** `E2E_DATABASE_URL` (else `DATABASE_URL`, else the `outings` database) ([playwright.config.ts](../playwright.config.ts), [env.ts](../tests/e2e/env.ts)).
- CI ([ci.yml](../.github/workflows/ci.yml)) runs migrate, typecheck, lint, Vitest and `next build` on Postgres 16; it does not run Playwright.

## What is tested where

Each row is a risk, the files that pin it, and one test name to find with your editor's search or `grep -rnF`.

| Risk | Test files | Example test |
|---|---|---|
| Wrong amounts or rounding | [money.test.ts](../tests/domain/money.test.ts), [policy.test.ts](../tests/domain/policy.test.ts) | "$100 / 3 payers = $33.34, $33.33, $33.33 in stable order" |
| Settling early, or with a holdout | [policy.test.ts](../tests/domain/policy.test.ts), [deadline.test.ts](../tests/settlement/deadline.test.ts) | "a single required holdout cancels even when enough others authorized"; "never settles before the stored deadline" |
| Charging the full hold instead of the share | [deadline.test.ts](../tests/settlement/deadline.test.ts), [big-group.spec.ts](../tests/e2e/big-group.spec.ts) | "ten $10 final captures (under-capture)" |
| Double capture after a timeout or crash | [operations.test.ts](../tests/settlement/operations.test.ts), [fixture.test.ts](../tests/payments/fixture.test.ts) | "two concurrent worker ticks send each capture exactly once"; "timeout AFTER a successful capture" |
| Partial capture failure | [operations.test.ts](../tests/settlement/operations.test.ts), [followup.test.ts](../tests/audit/followup.test.ts), [compensation.spec.ts](../tests/e2e/compensation.spec.ts) | "stops, voids the rest, refunds completed captures, never confirms" |
| Claiming money is released when it is not | [settlement-audit.test.ts](../tests/audit/settlement-audit.test.ts), [operations.test.ts](../tests/settlement/operations.test.ts) | "a deadline CANCEL reports VOID_PENDING (not COMPLETE)" |
| Stale consent or client-chosen amounts | [policy.test.ts](../tests/domain/policy.test.ts), [service.test.ts](../tests/payments/service.test.ts), [routes.test.ts](../tests/payments/routes.test.ts) | "ignores any client amount: the hold is the consented cap"; "returns 409 TERMS_CHANGED" |
| Late, unverifiable or misdirected holds | [service.test.ts](../tests/payments/service.test.ts), [payee.test.ts](../tests/payments/payee.test.ts), [payments-audit.test.ts](../tests/audit/payments-audit.test.ts) | "race rule: settlement froze the roster while authorize was in flight" |
| PayPal adapter (mocked `fetch`) | [paypal.test.ts](../tests/payments/paypal.test.ts) | "refuses to talk to anything but the sandbox API" |
| Forged webhooks (mocked PayPal) | [webhook.test.ts](../tests/settlement/webhook.test.ts) | "rejects an unverified delivery and stores nothing" |
| Access, sessions, vote privacy | [access.test.ts](../tests/access/access.test.ts), [access-audit2.test.ts](../tests/audit2/access-audit2.test.ts), [setup-routes.test.ts](../tests/services/setup-routes.test.ts), [setup-access.spec.ts](../tests/e2e/setup-access.spec.ts) | "never exposes other people's vote amounts, before or after reveal" |
| Demo sign-in reaching the owner's `/setup` | [setup-routes.test.ts](../tests/services/setup-routes.test.ts), [access.test.ts](../tests/access/access.test.ts), [setup-access.spec.ts](../tests/e2e/setup-access.spec.ts) | "refuses the one-click demo sign-in (403) and calls nothing" |
| Merchant assistant losing its chat on a data refresh | [studio-instance.test.ts](../tests/ui/studio-instance.test.ts), [merchant-refresh.spec.ts](../tests/e2e/merchant-refresh.spec.ts) | "stays the same when a refresh only moves the countdowns" |
| Judge mode misuse | [judge-persona.test.ts](../tests/services/judge-persona.test.ts), [judge.test.ts](../tests/demo/judge.test.ts) | "refuses with one identical 404"; "a PayPal-style return after switching personas" |
| AI deciding money or obeying injected text | [ai.test.ts](../tests/ai/ai.test.ts), [plan-draft.test.ts](../tests/ai/plan-draft.test.ts), [plan-draft.test.ts](../tests/services/plan-draft.test.ts), [budget-options.test.ts](../tests/domain/budget-options.test.ts), [starters-and-venues.test.ts](../tests/services/starters-and-venues.test.ts) | "drops an AI suggestion that moves the vote away from the budget the brief states" |
| Lifecycle, budget poker, time zones | [outings.test.ts](../tests/services/outings.test.ts), [terms-time-audit2.test.ts](../tests/audit2/terms-time-audit2.test.ts), [merchant-views.test.ts](../tests/services/merchant-views.test.ts), [merchant-format.test.ts](../tests/services/merchant-format.test.ts) | "requires >= 3 votes (and 75% of the group) to reveal and stores an aggregate without names", "waits for 75% of the group before the reveal" |
| Demo data leaking into real data | [demo-scenarios.test.ts](../tests/services/demo-scenarios.test.ts), [demo-catalogue-audit3.test.ts](../tests/audit3/demo-catalogue-audit3.test.ts) | "refuses to book a deactivated offering instead of reactivating it" |
| HTTP hardening | [security-headers.test.ts](../tests/services/security-headers.test.ts), [headers-audit3.test.ts](../tests/audit3/headers-audit3.test.ts), [rate-limit.test.ts](../tests/services/rate-limit.test.ts) | "sends HSTS from the RUNTIME environment" |
| Database outages and error wording | [connection-resilience.test.ts](../tests/db/connection-resilience.test.ts), [validation-errors.test.ts](../tests/services/validation-errors.test.ts), [friendly-error.test.ts](../tests/ui/friendly-error.test.ts) | "survives the server dropping an idle pooled connection"; "answers 503 with a retry hint" |
| The whole flow in a browser | [karaoke.spec.ts](../tests/e2e/karaoke.spec.ts), [cancellation.spec.ts](../tests/e2e/cancellation.spec.ts), [demo.spec.ts](../tests/e2e/demo.spec.ts), [compensation.spec.ts](../tests/e2e/compensation.spec.ts), [big-group.spec.ts](../tests/e2e/big-group.spec.ts) | Karaoke settle, holdout cancel, organizer cancel, demo hub, capture failure, ten-person under-capture |

## Latest results

Vitest and Playwright last ran on 11 Nov 2026 on the owner's Windows 11 machine with Postgres 16 in Docker, in FIXTURE modes; the PayPal scripts ran on 7 Nov 2026 against the real sandbox.

| Check | Result |
|---|---|
| `tsc --noEmit`, `eslint` | Clean |
| Vitest | 543 tests in 45 files pass |
| Playwright (production build, Chromium) | 8/8 pass: karaoke settle, holdout cancel, organizer cancel, demo hub, capture-failure compensation, big-group under-capture, dashboard refresh keeps AG Studio, `/setup` access |
| PayPal adapter, real sandbox ([paypal-smoke.ts](../scripts/paypal-smoke.ts)) | All expectations met: authorize, $10-of-$20 final capture, capture replay idempotent, void then capture refused with `AUTHORIZATION_VOIDED`, capture, refund ([evidence](evidence/README.md)) |
| One full outing through the app, real sandbox ([paypal-verify-outing.ts](../scripts/paypal-verify-outing.ts)) | Three participants, three $50 holds (all approved with one sandbox buyer account), $33.34 / $33.33 / $33.33 captured at the deadline; PayPal's records match the app's (`allMatch: true`) |
| Real Claude ([ai-smoke.ts](../scripts/ai-smoke.ts)) | Run on the hosted demo on 11 Nov 2026: a full run passed 12 of 13 checks; the one that failed (venue ranking) was fixed and then passed 3 of 3 reruns. The Vitest AI tests use a mocked SDK |
| PayPal webhook signatures from real deliveries | **Not run.** Tested against a mocked PayPal only |
| PayPal negative testing (`PayPal-Mock-Response`) | **Not run** |
| Hosted deployment | Live at https://outings.baymoor.dev (DigitalOcean, Docker Compose, Caddy). Checked by hand on 10 and 11 Nov 2026: health endpoint, pages, and a demo deadline settled by the worker with every browser closed |

Next: [what the PayPal evidence files contain](evidence/README.md), or [the limits this does not cover](SECURITY_AND_LIMITATIONS.md).
