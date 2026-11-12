# Testing

584 Vitest tests in 48 files (most against a real Postgres) and 9 Playwright browser tests pin the money, consent and access rules. Two scripts checked the real PayPal sandbox, and a smoke script checked real Claude on the live demo.

Related: [README](../README.md) · [judge guide](JUDGE_GUIDE.md) · [architecture invariants](ARCHITECTURE.md) · [security and limitations](SECURITY_AND_LIMITATIONS.md) · [PayPal sandbox evidence](evidence/README.md)

## Run it

You need Node 22.12+ and Postgres 16. The defaults below match CI.

```bash
# Postgres 16 with an empty outings_test database (same as CI)
docker run -d --name outings-test-db -p 5432:5432 -e POSTGRES_USER=outings \
  -e POSTGRES_PASSWORD=outings -e POSTGRES_DB=outings_test postgres:16

npm ci
npm run typecheck && npm run lint
npm test                                  # all 47 Vitest files
npx vitest run tests/settlement           # one folder; add -t "fragment" for one test

# Browser tests wipe their database, so they get their own
docker exec outings-test-db createdb -U outings outings_e2e
npx playwright install chromium           # once
E2E_DATABASE_URL=postgres://outings:outings@localhost:5432/outings_e2e npm run test:e2e
```

- **Vitest** reads `TEST_DATABASE_URL` from the shell (default `postgres://outings:outings@localhost:5432/outings_test`), never from `.env.local`. Each integration file calls `useTestDb()` ([db.ts](../tests/helpers/db.ts)), which migrates and truncates every table before each test. Files run one at a time ([vitest.config.ts](../vitest.config.ts)).
- **Playwright** (`npm run test:e2e`) builds the app and serves it on port 3400 in FIXTURE modes (simulated payments, sample AI), with PayPal and Anthropic keys blanked. A second server on port 3500 runs the same build with the judge sign-in switched on. It **truncates and re-seeds** `E2E_DATABASE_URL` (else `DATABASE_URL`, else the `outings` database), so never point it at a database you care about, or at the Vitest one ([playwright.config.ts](../playwright.config.ts), [env.ts](../tests/e2e/env.ts)).
- **CI** ([ci.yml](../.github/workflows/ci.yml)) runs migrate, typecheck, lint, Vitest and `next build` on Postgres 16. It does not run Playwright.

## What is tested where

Each row is a risk, the files that pin it, and a test name you can find with your editor's search or `grep -rnF`.

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
| Anonymous visitors creating outings or reaching Claude | [judge-login.test.ts](../tests/access/judge-login.test.ts), [judge-login.spec.ts](../tests/e2e/judge-login.spec.ts) | "returns 401 JUDGE_LOGIN_REQUIRED with the gate on and no judge cookie, and creates nothing" |
| Demo outings spending model budget or claiming Claude | [ai-mode-per-outing.test.ts](../tests/services/ai-mode-per-outing.test.ts) | "reveal summary, venue ranking and plan draft of a seeded demo outing call the sample AI, never Claude"; "says FIXTURE for a demo outing and ANTHROPIC for a real one on the same deployment" |
| One visitor's Reset wiping another's `/demo` run | [demo-scenarios.test.ts](../tests/services/demo-scenarios.test.ts) | "keeps a story started a minute ago, removes a 20-minute-old one and restores the seeded set" |
| AI deciding money or obeying injected text | [ai.test.ts](../tests/ai/ai.test.ts), [plan-draft.test.ts](../tests/ai/plan-draft.test.ts), [plan-draft.test.ts](../tests/services/plan-draft.test.ts), [budget-options.test.ts](../tests/domain/budget-options.test.ts), [starters-and-venues.test.ts](../tests/services/starters-and-venues.test.ts) | "drops an AI suggestion that moves the vote away from the budget the brief states" |
| Lifecycle, budget poker, time zones | [outings.test.ts](../tests/services/outings.test.ts), [terms-time-audit2.test.ts](../tests/audit2/terms-time-audit2.test.ts), [merchant-views.test.ts](../tests/services/merchant-views.test.ts), [merchant-format.test.ts](../tests/services/merchant-format.test.ts) | "requires >= 3 votes (and 75% of the group) to reveal and stores an aggregate without names", "waits for 75% of the group before the reveal" |
| Demo data leaking into real data | [demo-scenarios.test.ts](../tests/services/demo-scenarios.test.ts), [demo-catalogue-audit3.test.ts](../tests/audit3/demo-catalogue-audit3.test.ts) | "refuses to book a deactivated offering instead of reactivating it" |
| HTTP hardening | [security-headers.test.ts](../tests/services/security-headers.test.ts), [headers-audit3.test.ts](../tests/audit3/headers-audit3.test.ts), [rate-limit.test.ts](../tests/services/rate-limit.test.ts) | "sends HSTS from the RUNTIME environment" |
| Database outages and error wording | [connection-resilience.test.ts](../tests/db/connection-resilience.test.ts), [validation-errors.test.ts](../tests/services/validation-errors.test.ts), [friendly-error.test.ts](../tests/ui/friendly-error.test.ts) | "survives the server dropping an idle pooled connection"; "answers 503 with a retry hint" |
| The whole flow in a browser | [karaoke.spec.ts](../tests/e2e/karaoke.spec.ts), [cancellation.spec.ts](../tests/e2e/cancellation.spec.ts), [demo.spec.ts](../tests/e2e/demo.spec.ts), [compensation.spec.ts](../tests/e2e/compensation.spec.ts), [big-group.spec.ts](../tests/e2e/big-group.spec.ts) | Karaoke settle, holdout cancel, organizer cancel, demo hub, capture failure, ten-person under-capture |

## Latest results

Vitest and Playwright last ran on 11 and 12 Nov 2026 on the owner's Windows 11 machine, with Postgres 16 in Docker, in FIXTURE modes. The PayPal scripts ran on 7 Nov 2026 against the real sandbox.

| Check | Result |
|---|---|
| `tsc --noEmit`, `eslint` | Clean |
| Vitest | 584 tests in 48 files pass |
| Playwright (production build, Chromium) | 9/9 pass: karaoke settle, holdout cancel, organizer cancel, demo hub, capture-failure compensation, big-group under-capture, dashboard refresh keeps AG Studio, `/setup` access, judge sign-in |
| PayPal adapter, real sandbox ([paypal-smoke.ts](../scripts/paypal-smoke.ts)) | All expectations met: authorize, $10-of-$20 final capture, capture replay idempotent, void then capture refused with `AUTHORIZATION_VOIDED`, capture, refund ([evidence](evidence/README.md)) |
| One full outing through the app, real sandbox ([paypal-verify-outing.ts](../scripts/paypal-verify-outing.ts)) | Three participants, three $50 holds (all approved with one sandbox buyer account), $33.34 / $33.33 / $33.33 captured at the deadline; PayPal's records match the app's (`allMatch: true`) |
| Real Claude ([ai-smoke.ts](../scripts/ai-smoke.ts)) | Run on the live demo on 11 Nov 2026: a full run passed 12 of 13 checks. The one that failed (venue ranking) was fixed and then passed 3 of 3 reruns. The output files of that run were not committed. The Vitest AI tests use a mocked SDK |
| PayPal webhook signatures from real deliveries | **Not run.** Tested against a mocked PayPal only. Webhooks are not configured on the live server (`/api/health` shows `webhookVerification:false`) |
| PayPal negative testing (`PayPal-Mock-Response`) | **Not run** |
| Live demo | https://outings.baymoor.dev (DigitalOcean, Docker Compose, Caddy). Checked by hand on 10 and 11 Nov 2026: health endpoint, pages, and a demo deadline settled by the worker with every browser closed |

Next: [what the PayPal evidence files contain](evidence/README.md), or [the limits this does not cover](SECURITY_AND_LIMITATIONS.md).
