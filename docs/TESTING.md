# Testing

Test runner: Vitest (`vitest.config.ts`). Files run serially because the integration suites share one Postgres test database.

## Setup and commands

```bash
createdb -O outings outings_test   # as a Postgres superuser; or point TEST_DATABASE_URL at any empty database the role owns
export TEST_DATABASE_URL=postgres://outings:outings@localhost:5432/outings_test   # read from the shell, not .env.local
npm run typecheck
npm test                                  # all suites
npx vitest run tests/domain               # one suite
npx vitest run tests/settlement/operations.test.ts -t "concurrent"   # one file or test name
```

The default `TEST_DATABASE_URL` is `postgres://outings:outings@localhost:5432/outings_test`. Each integration file calls `useTestDb()` (`tests/helpers/db.ts`), which migrates the database and truncates every table before each test. Use a separate database per parallel job. CI (`.github/workflows/ci.yml`) runs migrate, typecheck, lint and tests against Postgres 16.

## Current results

Last verified run (owner's Windows 11 machine, Postgres 16 in Docker, 7 Nov 2026, FIXTURE modes): **361 Vitest tests in 29 files pass**; eslint and `tsc` clean; `next build` passes; **6/6 Playwright end-to-end tests pass** (karaoke settle, holdout cancel, organizer cancel, demo hub, capture-failure compensation, big-group under-capture). The PayPal sandbox smoke test (`scripts/paypal-smoke.ts`) passed all expectations the same day, and one full outing settled through the app in `PAYPAL_SANDBOX` mode matched PayPal's records (`scripts/paypal-verify-outing.ts`; see [evidence/README.md](evidence/README.md)). Not verified: real Claude (`scripts/ai-smoke.ts`).

Newer test files: `tests/services/demo-scenarios.test.ts` (one-click scenarios through the real services and worker), `tests/services/rate-limit.test.ts` (`TRUSTED_PROXY_HOPS` and client-IP keying), `tests/services/merchant-format.test.ts` (merchant timezone in rows and formatting), `tests/payments/payee.test.ts` (PayPal payee from the merchant row, payee mismatch is voided), `tests/audit2/*` (access and terms/time audit regressions), `tests/e2e/compensation.spec.ts`.

## The pyramid

| Suite | Needs Postgres | What it covers | Run |
|---|---|---|---|
| `tests/domain` | No | Pure rules: integer money, `equalSplit`, caps and estimates, decimal parsing; `decideSettlement` (canonical splits, ALL_REQUIRED, fail-closed cases), terms hash, deadline validation, state machines. | `npx vitest run tests/domain` |
| `tests/ai` | No | Fixture parser, output validation (invented ids, unstated budgets, clamping, URL stripping), AI selection by config, Anthropic client against a **mocked SDK** (schema, refusal, truncation, transport errors). | `npx vitest run tests/ai` |
| `tests/payments` | Yes (service, routes, payee) | FixtureProvider semantics and failure injection; payee taken from the merchant row; PayPal adapter against a **mocked `fetch`** (OAuth cache, UNKNOWN classification, issue-code mapping, capture/void/refund, webhook verification call); payment start, approval return, late-authorization race rule, withdraw; payment routes. | `npx vitest run tests/payments` |
| `tests/settlement` | Yes | Deadline gating and idempotency; canonical splits end to end through the engine; ALL_REQUIRED cancellations; early cancel; worker sweep; exactly-once capture under concurrent workers; UNKNOWN reconciliation; compensation; retries and attention; late holds; webhook intake. | `npx vitest run tests/settlement` |
| `tests/services` | Yes (except `rate-limit` and `merchant-format`) | Outing lifecycle services, budget poker rules, catalogue grounding, capacity and sponsorship, opening collection, prompt injection in the brief; read models (OutingView, merchant views, operation retry, re-seeding); demo scenarios; `TRUSTED_PROXY_HOPS` rate-limit keying; merchant timezone formatting. | `npx vitest run tests/services` |
| `tests/access` | Yes | Route-handler level: scoped sessions, tampered/cross-outing/random ids, organizer-only endpoints, cross-origin rejection, vote privacy, merchant scoping, read-only dashboard AI, demo endpoints, health. | `npx vitest run tests/access` |
| `tests/audit` | Postgres | Regression tests for defects found by the independent payments/settlement audit (orphaned holds, fail-closed reads, clean-up state, provider mixing, captured-vs-void conflicts, outing-id leakage; see the status table in [HANDOFF_TO_CODEX.md](HANDOFF_TO_CODEX.md)). | `TEST_DATABASE_URL=… npx vitest run tests/audit` |
| `tests/audit2` | Postgres | Second audit (privacy/access/consent): merchant session expiry, no cancel after deadline, vote-is-not-consent, UTC storage of Copenhagen wall times, guest capacity, fixture labelling, plus brief-coverage gap tests. | `TEST_DATABASE_URL=… npx vitest run tests/audit2` |
| `tests/e2e` | built app + Postgres | Playwright in Chromium against the production build (`karaoke.spec.ts`, `cancellation.spec.ts`, `demo.spec.ts`, `compensation.spec.ts`): full karaoke flow to CONFIRMED with all pages closed, required-holdout cancellation with holds voided, organizer cancel, demo hub, and the capture-failure scenario (decline, refunds and voids, REFUND_PENDING to COMPLETE). Worker driven via `POST /api/cron/tick`; the compensation spec uses `POST /api/demo/scenario` and `/api/demo/tick`. Truncates and re-seeds `E2E_DATABASE_URL` (else the shell's `DATABASE_URL`, else the default `outings` database; `.env.local` is ignored). Needs `npx playwright install chromium` once and a free port 3400. | `E2E_DATABASE_URL=… npm run test:e2e` |

Not covered by any automated test: behaviour against the real PayPal sandbox and the real Anthropic API. The PayPal side has a manual proof script (`scripts/paypal-smoke.ts`, see `docs/evidence/README.md`); no real run has been recorded.

## Scenario to test mapping

Scenarios from the build brief, mapped by test name (file paths under `tests/`).

| Scenario | Test file | Test name (abridged) |
|---|---|---|
| $100 / 5 payers = $20 each | `domain/money.test.ts`; `domain/policy.test.ts`; `settlement/deadline.test.ts` | "$100 / 5 payers = $20 each"; "$100 / 5 payers -> SETTLE $20 each"; "$100 / 5 payers -> five $20 captures -> CONFIRMED" |
| $100 / 10 payers = $10 each, under-capture of a $20 hold | `domain/money.test.ts`; `domain/policy.test.ts`; `settlement/deadline.test.ts` | "$100 / 10 payers..." ("captured below the $20 hold"; "ten $10 final captures (under-capture)") |
| Sponsored guest: 6 attendees, 5 payers at $20, guest $0 | `domain/policy.test.ts`; `settlement/deadline.test.ts`; `services/merchant-views.test.ts` | "6 attendees incl. 1 sponsored guest -> 5 payers at $20, guest $0"; "shows a pre-quote estimate with a sponsored guest" |
| Penny split $100 / 3 = 33.34, 33.33, 33.33 | `domain/money.test.ts`; `domain/policy.test.ts`; `settlement/deadline.test.ts` | "$100 / 3 payers..." |
| Shares always sum to the total, differ by at most one cent | `domain/money.test.ts` | "always sums exactly to the total and differs by at most one cent" |
| Cap $20 and estimate vs hold | `domain/money.test.ts`; `services/merchant-views.test.ts` | "$100 with min 5 payers -> $20 cap"; "estimate falls as payers join..." |
| Never capture above the cap or authorized amount | `domain/policy.test.ts`; `settlement/operations.test.ts`; `payments/fixture.test.ts` | "never allocates above the consented cap"; "refuses to plan a capture above the authorized amount, and the DB refuses to record one"; "captures at most the authorized amount" |
| Budget poker privacy | `access/access.test.ts` | "never exposes other people's vote amounts, before or after reveal" |
| Reveal needs 3 votes, aggregate has no names | `services/outings.test.ts` | "requires >= 3 votes to reveal and stores an aggregate without names" |
| Vote is not a payment; only voters can vote while budgeting | `access/access.test.ts`; `services/outings.test.ts` | "only participants of the outing can vote, and only while budgeting"; "validates vote amounts and state" |
| Consent bound to terms; changed terms need new consent | `domain/policy.test.ts`; `services/outings.test.ts`; `payments/service.test.ts`; `payments/routes.test.ts` | "any material change produces a different hash"; "rejects stale consent after the terms change..."; "409 TERMS_CHANGED" |
| Client-sent amounts are ignored | `payments/routes.test.ts` | "ignores any client amount: the hold is the consented cap" |
| ALL_REQUIRED: one holdout cancels, holds voided | `domain/policy.test.ts`; `settlement/deadline.test.ts` | "a single required holdout cancels even when enough others authorized"; "a required holdout cancels; every hold is voided; cleanup becomes COMPLETE only after the provider confirmed" |
| Optional guests never block or silently pay | `domain/policy.test.ts` | "an optional non-responder does not block and does not become a payer" |
| Never settle before the deadline; late job uses stored deadline | `domain/policy.test.ts`; `settlement/deadline.test.ts` | "refuses to evaluate before the deadline"; "never settles before the stored deadline"; "a late-running job evaluates against the stored deadline..." |
| Deadline job runs without a browser; lost job is swept | `settlement/deadline.test.ts` | "settles an overdue COLLECTING outing even when its job was lost" (see also manual proof in `DEPLOYMENT.md`) |
| Settlement is idempotent | `settlement/deadline.test.ts` | "is idempotent: a second run finds the snapshot and plans nothing new" |
| Commitment window <= 48 h, deadline before activity | `domain/policy.test.ts`; `services/outings.test.ts` | "rejects windows over 48h"; "validates the deadline window, availability and minPayers" |
| Late approval/authorization is voided, never admitted | `domain/policy.test.ts`; `payments/service.test.ts`; `settlement/operations.test.ts` | "late authorization ... is not admitted"; "race rule: settlement froze the roster while authorize was in flight -> recorded late + VOID"; "a late hold is voided, never admitted" |
| Unverifiable or expired authorization fails closed | `domain/policy.test.ts`; `settlement/deadline.test.ts` | "unverified authorization ... fails closed (UNVERIFIABLE)"; "an expired authorization of a required payer cancels (fail closed)"; "fails closed when the provider cannot be read" |
| Sequential capture, partial failure, compensation | `settlement/operations.test.ts` | "stops, voids the rest, refunds completed captures, never confirms; refund PENDING is polled to COMPLETE" |
| Refund pending is shown, not claimed complete | `settlement/operations.test.ts`; `services/merchant-views.test.ts` | "a PENDING refund stays visible as REFUND_PENDING..."; "separates authorized holds from allocated, captured and refunded money" |
| UNKNOWN (timeout) reconciled before retry, same request id | `settlement/operations.test.ts`; `payments/paypal.test.ts`; `payments/service.test.ts` | "timeout AFTER a successful capture -> UNKNOWN -> reconciled ... no second capture"; "timeout BEFORE the provider acted ... re-sent with the same requestId"; "HTTP %i -> UNKNOWN" |
| Exactly-once sending with concurrent workers | `settlement/operations.test.ts`; `payments/fixture.test.ts` | "two concurrent worker ticks send each capture exactly once"; "concurrent captures with the same requestId produce exactly one capture" |
| Crashed worker (stale in-flight op) | `settlement/operations.test.ts` | "a stale IN_FLIGHT operation (crashed worker) is treated as UNKNOWN and reconciled" |
| Exhausted retries need attention; manual re-queue | `settlement/operations.test.ts`; `services/merchant-views.test.ts`; `access/access.test.ts` | "exhausted retries leave the op FAILED/UNKNOWN and the outing NEEDS_ATTENTION..."; "retries only existing FAILED/UNKNOWN operations..."; "participants cannot retry operations..." |
| Payer withdrawal voids the hold, required withdrawal cancels | `payments/service.test.ts`; `payments/routes.test.ts` | "a required payer's withdrawal voids their hold and schedules an early cancel"; "withdraws the caller" |
| Organizer cancel / required decline cancel early | `settlement/deadline.test.ts`; `services/outings.test.ts` | "organizer cancel before the deadline cancels unconditionally and voids holds"; "a required decline enqueues the early-cancel job..." |
| PayPal AUTHORIZE order, exact decimals, sandbox-only host | `payments/paypal.test.ts` | "sends an AUTHORIZE order for the exact decimal amount..."; "refuses to talk to anything but the sandbox API" |
| Approval link must be on paypal.com | `payments/paypal.test.ts` | "accepts the legacy `approve` link and rejects approval links that are not on paypal.com" |
| Capture uses `final_capture=true` | `payments/paypal.test.ts` | "capture sends amount as a decimal string with final_capture=true..." |
| Webhooks verified, deduplicated, redacted | `settlement/webhook.test.ts`; `payments/paypal.test.ts` | "rejects an unverified delivery and stores nothing"; "...duplicate is a no-op"; "redacts nested PII keys"; "posts transmission headers + webhook id..." |
| Server-side access: sessions, tampering, cross-outing | `access/access.test.ts` | "rejects missing, tampered, cross-outing and random/sequential ids"; "an invitee cannot call any organizer endpoint" |
| Invite tokens hashed at rest | `services/outings.test.ts` | "creates the organizer as a required payer with sortKey 1 and hashes invite tokens" |
| CSRF same-origin check | `access/access.test.ts`; `payments/routes.test.ts` | "rejects cross-origin mutations"; "needs a session (401) and a same-origin request (403)" |
| Prompt injection changes no policy or amounts | `ai/ai.test.ts`; `services/outings.test.ts`; `access/access.test.ts` | "injected brief yields no payment fields..."; "changes no policy or amounts"; "a hostile brief changes no policy or amounts" |
| AI output validated; invented inventory/amounts rejected | `ai/ai.test.ts`; `services/outings.test.ts` | "drops invented offering ids..."; "drops a budget the model invented..."; "keeps only real, active catalogue offerings that fit the group; prices come from the DB" |
| AI failure never blocks or invents; no silent fallback | `ai/ai.test.ts`; `services/outings.test.ts` | "throws AiOutputError ... never falls back"; "stores the outing without extraction when the AI fails..." |
| NL dashboard query is read-only | `ai/ai.test.ts`; `access/access.test.ts` | "sanitizes dashboard values and drops mismatched filters"; "the dashboard AI query returns a read-only filter and cannot move money" |
| Canonical dashboard question | `ai/ai.test.ts` | "canonical dashboard question" |
| Merchant sees only own outings; login rules | `access/access.test.ts` | "need a merchant session and are scoped to the merchant's own outings"; "login is password-checked; demo login only in demo mode..." |
| Fixture is labelled and disabled when demo is off | `payments/fixture.test.ts`; `payments/service.test.ts`; `access/access.test.ts` | "is labelled as a fixture..."; "the fixture approval is 404 when demo fixtures are disabled"; "health reports modes without secrets" |
| Demo seed replaces only fixture outings | `services/merchant-views.test.ts` | "re-seeding replaces only fixture outings" |
| Capacity, sponsorship limits, catalogue availability | `services/outings.test.ts`; `settlement/deadline.test.ts`; `domain/policy.test.ts` | "enforces capacity for invitees once an offering is selected"; "allows at most one sponsored guest, never the organizer, and only before collection"; "cancels when the merchant offering is no longer available" |

If a test is renamed, search for the quoted fragment with `grep -rn "fragment" tests`.
