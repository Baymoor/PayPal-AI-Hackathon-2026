# Build contracts and file ownership

This is the coordination contract for parallel implementation. Domain rules: `docs/PRODUCT_SPEC.md`. Do not change shared files you do not own; propose changes to the coordinator instead.

## Shared, coordinator-owned (read-only for workers)

| File | Purpose |
|---|---|
| `lib/domain/money.ts` | integer money, `equalSplit`, `perPayerCap`, `estimatedShare`, parsing/formatting |
| `lib/domain/policy.ts` | `buildCommitmentTerms`, `hashTerms`, `validateCommitmentDeadline`, `decideSettlement`, `isInfeasible` |
| `lib/domain/state-machine.ts` | legal transitions for outing / payment / operation |
| `lib/domain/types.ts` | enums + constants (48 h window, 3-vote reveal minimum, …) |
| `lib/db/schema.ts`, `drizzle/*` | Postgres schema + migrations (coordinator generates migrations) |
| `lib/db/client.ts` | `getDb()`, `createDb(url)`, `Db`, `Tx`, `DbOrTx` |
| `lib/env.ts` | `config()`, payment/AI mode detection, `publicModeSummary()` |
| `lib/payments/provider.ts` | `PaymentProvider` port |
| `lib/payments/plan.ts` | `planPaymentOperation(tx, …)` — durable outbox row + `*_PENDING` + PROCESS_OPERATIONS job |
| `lib/jobs/queue.ts` | `enqueueJob`, `claimDueJobs`, `completeJob`, `failJob`, `settleJobKey`, `operationsJobKey` |
| `lib/audit.ts` | `recordAudit` |
| `lib/auth/tokens.ts`, `lib/auth/session.ts` | invite tokens (hashed), signed cookie sessions read from `Request` |
| `lib/ai/types.ts` | AI port + zod schemas |
| `lib/contracts/views.ts` | `OutingView`, `MerchantBookingRow`, `MerchantOutingDetail` DTOs |
| `package.json`, lockfile | dependencies are already installed; ask before adding any |

## Work packages

| WP | Owner | Files |
|---|---|---|
| Settlement engine | Fable | `lib/settlement/**`, `lib/jobs/runner.ts`, `lib/jobs/handlers.ts`, `lib/webhooks/**`, `app/api/cron/tick/route.ts`, `app/api/webhooks/paypal/route.ts`, `scripts/worker.ts`, `tests/settlement/**` |
| Payments | Opus A | `lib/payments/paypal.ts`, `lib/payments/fixture.ts`, `lib/payments/index.ts`, `lib/services/payments.ts`, `app/api/payments/**`, `app/api/outings/[id]/payments/route.ts`, `app/api/outings/[id]/withdraw/route.ts`, `scripts/paypal-smoke.ts`, `tests/payments/**` |
| Outings services + API | Opus B | `lib/services/outings.ts`, `lib/services/views.ts`, `lib/services/merchant.ts`, `lib/services/access.ts`, `lib/services/catalogue.ts`, `lib/http.ts`, `lib/rate-limit.ts`, `app/api/outings/**` (except payments/withdraw), `app/api/merchant/**`, `app/api/demo/**`, `app/api/health/route.ts`, `app/i/[token]/route.ts`, `scripts/seed.ts`, `lib/demo/**`, `tests/services/**`, `tests/access/**` |
| AI | Sonnet | `lib/ai/anthropic.ts`, `lib/ai/fixture.ts`, `lib/ai/index.ts`, `lib/ai/validate.ts`, `lib/ai/prompts.ts`, `tests/ai/**` |
| Consumer UI | Sonnet | `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `app/new/**`, `app/o/**`, `app/demo/**`, `components/**` (except `components/merchant/**`), `tests/e2e/**` |
| Merchant dashboard | Sonnet | `app/merchant/**`, `components/merchant/**` |

## Service layer conventions

- Services take `db: DbOrTx` (or use `getDb()`), a `now: Date` from the server, and an explicit actor; they throw `ServiceError(code, httpStatus, message)` from `lib/http.ts`.
- Route handlers are thin: read the session from `Request` (`readParticipantSession(req)` / `readMerchantSession(req)`), call `lib/services/access.ts` to authorize, call the service, return JSON. Next 16: `params` is a Promise — `export async function POST(req: Request, ctx: { params: Promise<{ id: string }> })`.
- Never trust client-supplied money, terms, or ids of other participants. The browser sends intent (e.g. `offeringId`, `termsHash` it reviewed); the server recomputes everything.
- Use server time (`new Date()` in services / `now()` in SQL). Never the client clock.

## HTTP API (JSON; errors `{ error: { code, message } }`)

Participant (cookie `outings_p`):

| Method & path | Who | Effect |
|---|---|---|
| `POST /api/outings` `{organizerName, brief}` | anyone (rate-limited) | creates DRAFT outing + organizer participant, runs AI brief extraction (stored with provenance), sets session cookie → `{outingId}` |
| `GET /api/outings/:id` | participant | `OutingView` |
| `POST /api/outings/:id/start-budget` | organizer | DRAFT → BUDGETING |
| `POST /api/outings/:id/invitees` `{names[], required?}` | organizer | adds invitees (≤ capacity once known; only optional during COLLECTING) → `{invites:[{participantId, displayName, link}]}` (links shown once) |
| `POST /api/outings/:id/budget/vote` `{amountMinor}` | participant | upsert own vote for current round (BUDGETING, not revealed) |
| `POST /api/outings/:id/budget/reveal` | organizer | needs ≥ 3 votes; stores aggregate + AI summary |
| `POST /api/outings/:id/budget/round` | organizer | new budget round (clears reveal) |
| `POST /api/outings/:id/budget/agree` `{amountMinor}` | organizer | sets proposed TOTAL budget (not a payment), → PROPOSED, AI ranks catalogue |
| `POST /api/outings/:id/select` `{offeringId}` | organizer | choose offering (preview) |
| `PATCH /api/outings/:id/participants/:pid` `{payerType?, required?}` | organizer | sponsor / optional toggles (before COLLECTING only) |
| `POST /api/outings/:id/open` `{activityAt, deadlineAt, minPayers}` | organizer | merchant availability check → QuoteVersion (terms + hash) → COLLECTING → schedules SETTLE_DEADLINE job |
| `POST /api/outings/:id/respond` `{response: "ACCEPT"|"DECLINE"}` | participant | attendance (sponsored accept; anyone decline). Required decline → early cancel |
| `POST /api/outings/:id/consent` `{termsHash}` | payer | consent to CURRENT terms before deadline → attendance ACCEPTED |
| `POST /api/outings/:id/payments` | payer with current consent | creates PaymentAttempt + AUTHORIZE order for cap → `{approveUrl}` |
| `GET /api/payments/paypal/return?attempt=&token=` | payer | server authorizes, verifies, flags late → redirect `/o/:id?payment=…` |
| `GET /api/payments/paypal/cancel?attempt=` | payer | abandoned approval → redirect |
| `POST /api/payments/fixture/approve` `{attemptId, outcome}` | payer (FIXTURE mode only) | simulated approval page action |
| `POST /api/outings/:id/withdraw` | payer before deadline | void hold; required → early cancel |
| `POST /api/outings/:id/cancel` | organizer | cancel (voids holds) |
| `GET /i/:token` | anyone with link | verify hashed token → set session → redirect `/o/:id` |

Merchant (cookie `outings_m`): `POST /api/merchant/login {password}`, `POST /api/merchant/demo-login` (demo only), `POST /api/merchant/logout`, `GET /api/merchant/bookings` → `MerchantBookingRow[]`, `GET /api/merchant/outings/:id` → `MerchantOutingDetail`, `POST /api/merchant/operations/:opId/retry` (re-queue an existing FAILED/UNKNOWN op only), `POST /api/merchant/ai/query {question}` → validated `DashboardQuery` (read-only).

System: `POST /api/cron/tick` (`Authorization: Bearer $CRON_SECRET`) runs due jobs and due payment operations; `POST /api/webhooks/paypal` verifies + dedupes + reconciles; `GET /api/health` → `publicModeSummary()`; `POST /api/demo/reset` (demo only).

## Pages

`/` landing · `/new` brief (step 1) · `/o/[id]` participant hub (stage-driven: budget poker, reveal, proposal/sponsor/open for organizer, invitation/commit, waiting, result) · `/o/[id]/pay/fixture?attempt=` simulated approval (FIXTURE only, loudly labelled) · `/demo` persona switcher + reset (demo only) · `/merchant` AG Studio dashboard · `/merchant/outings/[id]` drill-down · `/merchant/login`.

## Added shared modules (coordinator)

- `lib/http.ts`: `ServiceError`, `handle()`, `json()`, `readJson(req, zodSchema)`, `errorResponse()`, `assertSameOrigin(req)`.
- `lib/services/access.ts`: `requireParticipant(db, req, outingId)`, `requireOrganizer`, `requireMerchant(req)`, `requireMerchantOuting`, `assertUuid`.
- `lib/payments/index.ts` (Opus A) MUST export `getPaymentProvider(name?: PaymentProviderName): PaymentProvider` — default from `config().paymentMode`; attempts store their provider name and the engine resolves the provider per attempt.
- `lib/ai/index.ts` (AI WP) MUST export `getOutingsAi(): OutingsAi` (ANTHROPIC if key, else FIXTURE if demo, else throws `AiUnavailableError`).
- `fixture_provider_objects` table: persistent state for the FIXTURE payment simulator (shared by web + worker).
- Race rule (payments ↔ settlement): any code that records an authorization must lock the outing row (`SELECT … FOR UPDATE`) in the same transaction; if a settlement snapshot already exists and the attempt is not among its allocations, it must immediately plan a VOID. The settlement decision transaction also locks the outing row and reads attempts inside it.
- Early cancellation: enqueue `SETTLE_DEADLINE` with payload `{ early: true, reason: "REQUIRED_DECLINED" | "ORGANIZER_CANCELLED" }` and dedupe key `settle-early:<outingId>`. `ORGANIZER_CANCELLED` cancels unconditionally; `REQUIRED_DECLINED` goes through `decideSettlement({ early: true })`.
