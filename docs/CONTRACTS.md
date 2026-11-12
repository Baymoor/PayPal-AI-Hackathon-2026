# Module contracts and HTTP API

Where each rule lives, which module owns it, and the HTTP API the client talks to. Domain rules in full: `docs/PRODUCT_SPEC.md`. Money is integer minor units everywhere (`lib/domain/money.ts`), and the AI never decides it.

## Shared core modules

Everything else builds on these, so change them on purpose: services, routes and UI all depend on their shapes.

| File | Purpose |
|---|---|
| `lib/domain/money.ts` | integer money, `equalSplit`, `perPayerCap`, `estimatedShare`, parsing and formatting |
| `lib/domain/policy.ts` | `buildCommitmentTerms`, `hashTerms`, `validateCommitmentDeadline`, `decideSettlement`, `isInfeasible` |
| `lib/domain/state-machine.ts` | legal transitions for outing, payment and operation |
| `lib/domain/types.ts` | enums and constants (48 h window, 3-vote reveal minimum, …) |
| `lib/db/schema.ts`, `drizzle/*` | Postgres schema and migrations |
| `lib/db/client.ts` | `getDb()`, `createDb(url)`, `Db`, `Tx`, `DbOrTx` |
| `lib/env.ts` | `config()`, payment and AI mode detection, `publicModeSummary()` |
| `lib/payments/provider.ts` | `PaymentProvider` port |
| `lib/payments/plan.ts` | `planPaymentOperation(tx, …)`: durable outbox row, `*_PENDING` status and a PROCESS_OPERATIONS job |
| `lib/jobs/queue.ts` | `enqueueJob`, `claimDueJobs`, `completeJob`, `failJob`, `settleJobKey`, `operationsJobKey` |
| `lib/audit.ts` | `recordAudit` |
| `lib/auth/tokens.ts`, `lib/auth/session.ts` | invite tokens (stored hashed), signed cookie sessions read from `Request` |
| `lib/auth/judge.ts` | judge sign-in: `judgeGateEnabled()`, `requireJudge(req)` (401 `JUDGE_LOGIN_REQUIRED`), `isJudgeRequest(req)`, the `outings_judge` cookie |
| `lib/ai/types.ts` | AI port and zod schemas |
| `lib/contracts/views.ts` | `OutingView`, `MerchantBookingRow`, `MerchantOutingDetail` DTOs |
| `package.json`, lockfile | dependencies, pinned by the lockfile; add new ones deliberately |

## Modules by area

| Area | Files |
|---|---|
| Settlement engine | `lib/settlement/**`, `lib/jobs/runner.ts`, `lib/jobs/handlers.ts`, `lib/webhooks/**`, `app/api/cron/tick/route.ts`, `app/api/webhooks/paypal/route.ts`, `scripts/worker.ts`, `tests/settlement/**` |
| Payments | `lib/payments/paypal.ts`, `lib/payments/fixture.ts`, `lib/payments/index.ts`, `lib/services/payments.ts`, `app/api/payments/**`, `app/api/outings/[id]/payments/route.ts`, `app/api/outings/[id]/withdraw/route.ts`, `scripts/paypal-smoke.ts`, `tests/payments/**` |
| Outings services and API | `lib/services/outings.ts`, `lib/services/views.ts`, `lib/services/merchant.ts`, `lib/services/access.ts`, `lib/services/catalogue.ts`, `lib/http.ts`, `lib/rate-limit.ts`, `app/api/outings/**` (except payments and withdraw), `app/api/merchant/**`, `app/api/demo/**`, `app/api/health/route.ts`, `app/i/[token]/route.ts`, `scripts/seed.ts`, `lib/demo/**`, `tests/services/**`, `tests/access/**` |
| AI | `lib/ai/anthropic.ts`, `lib/ai/fixture.ts`, `lib/ai/index.ts`, `lib/ai/validate.ts`, `lib/ai/prompts.ts`, `tests/ai/**` |
| Consumer UI | `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `app/new/**`, `app/o/**`, `app/demo/**`, `components/**` (except `components/merchant/**`), `tests/e2e/**` |
| Merchant dashboard | `app/merchant/**`, `components/merchant/**` |

## Service layer conventions

- Services take `db: DbOrTx` (or use `getDb()`), a `now: Date` from the server, and an explicit actor; they throw `ServiceError(code, httpStatus, message)` from `lib/http.ts`.
- Route handlers are thin: read the session from `Request` (`readParticipantSession(req)` / `readMerchantSession(req)`), call `lib/services/access.ts` to authorize, call the service, return JSON. Next 16: `params` is a Promise, so `export async function POST(req: Request, ctx: { params: Promise<{ id: string }> })`.
- Never trust client-supplied money, terms, or ids of other participants. The browser sends intent (e.g. `offeringId`, the `termsHash` it reviewed); the server recomputes everything.
- Use server time (`new Date()` in services, `now()` in SQL). Never the client clock.

## HTTP API (JSON; errors `{ error: { code, message } }`)

Error extras (additive; clients must ignore unknown keys):
- `INVALID_INPUT` from schema validation (400) also carries `fields: string[]`, the dot-joined paths of the invalid fields; its `message` is a plain-language sentence, never validator wording. `INVALID_INPUT` thrown by services keeps its specific message and has no `fields`.
- `TEMPORARILY_UNAVAILABLE` (503) comes with a `retry-after` header (seconds) when the database or another backing service is briefly unreachable; the request changed nothing.
- `JUDGE_LOGIN_REQUIRED` (401): the judge gate is on (`JUDGE_PASSWORD` set) and the request has no valid `outings_judge` cookie. The request changed nothing; the client sends the visitor to `/judge/login`.
- PayPal `return` / `cancel` routes are browser navigations and always answer with a redirect, never JSON: missing session, malformed or unknown `attempt` → `/?payment=signin`; a refused approval → `/o/<id>?payment=failed&reason=<lowercased error code>`.

Participant (cookie `outings_p`):

| Method & path | Who | Effect |
|---|---|---|
| `POST /api/outings` `{organizerName, brief}` | anyone with the judge gate off; a signed-in judge with it on, else 401 `JUDGE_LOGIN_REQUIRED` (rate-limited) | creates DRAFT outing + organizer participant, runs AI brief extraction (stored with provenance), sets session cookie → `{outingId}` |
| `GET /api/outings/:id` | participant | `OutingView` |
| `POST /api/outings/:id/start-budget` | organizer | DRAFT → BUDGETING |
| `POST /api/outings/:id/invitees` `{names[], required?}` | organizer | adds invitees (≤ capacity once known; only optional during COLLECTING) → `{invites:[{participantId, displayName, link}]}` (links shown once) |
| `POST /api/outings/:id/budget/vote` `{amountMinor}` | participant | upsert own vote for current round (BUDGETING, not revealed) |
| `POST /api/outings/:id/budget/reveal` | organizer | needs 75% of the group to have voted (rounded up), and at least 3 votes; stores aggregate + AI summary |
| `POST /api/outings/:id/budget/round` | organizer | new budget round (clears reveal) |
| `POST /api/outings/:id/budget/agree` `{amountMinor}` | organizer | sets the proposed budget in the outing's unit: per person, or a group total on outings created before per-person voting (not a payment), → PROPOSED, AI ranks catalogue |
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

AI calls for an outing (brief extraction, reveal summary, catalogue ranking, plan draft) follow `aiModeForOuting(outing)` in `lib/ai/index.ts`: demo (`isFixture`) outings always use the FIXTURE AI, even with an Anthropic key, and their `ai_runs` rows and `OutingView.outing.aiMode` say FIXTURE; real outings use `config().aiMode`.

Merchant (cookie `outings_m`): `POST /api/merchant/login {password}`, `POST /api/merchant/demo-login {venue?}` (demo only; `venue` is one of the five demo venue slugs, default The Sound Room; any other slug is 404), `POST /api/merchant/logout`, `GET /api/merchant/bookings` → `MerchantBookingRow[]`, `GET /api/merchant/outings/:id` → `MerchantOutingDetail`, `POST /api/merchant/operations/:opId/retry` (re-queue an existing FAILED/UNKNOWN op only), `POST /api/merchant/ai/query {question}` → validated `DashboardQuery` (read-only; with the judge gate on, only a signed-in judge's question goes to Claude, everyone else gets the FIXTURE sample parser), `POST /api/merchant/ai/studio` (AG Studio assistant proxy; with the judge gate on, 401 `JUDGE_LOGIN_REQUIRED` without a judge sign-in).

Judge sign-in (cookie `outings_judge`; the gate is on only when `JUDGE_PASSWORD` is set, username `JUDGE_USERNAME`, default `judge`): `POST /api/judge/login {username, password}` → `{ok: true}` and the cookie (`INVALID_CREDENTIALS` 401 for a wrong username or password alike, `RATE_LIMITED` 429 after repeated failures, `LOGIN_DISABLED` 503 with the gate off), `POST /api/judge/logout` clears it, `GET /api/judge/session` → `{gateEnabled, signedIn}`. Gated: the `/new` page (redirects to `/judge/login?next=/new`), `POST /api/outings`, the AG Studio assistant and the Claude path of the merchant filter. Not gated: `/`, `/how-it-works`, `/demo` and its APIs, `/i/:token`, the demo merchant dashboard, `/setup` (owner password).

System: `POST /api/cron/tick` (`Authorization: Bearer $CRON_SECRET`) runs due jobs and due payment operations; `POST /api/webhooks/paypal` verifies + dedupes + reconciles; `GET /api/health` → `publicModeSummary()`.

Demo (all 404 unless `DEMO_FIXTURES_ENABLED=true`):
- `POST /api/demo/reset` re-seeds the standard demo outings and keeps any `/demo` story started recently (`DEMO_SCENARIO_KEEP_MS`, measured from the button press: a story's `createdAt` is backdated by `DEMO_SCENARIO_HISTORY_MS`). It and `GET /api/demo/personas` return `{outingId, personas, budgetOutingId, budgetPersonas, merchant, outings}`.
- `POST /api/demo/persona {participantId}`: any participant of a fixture outing, or, in judge mode, any participant of an outing this browser's session already holds; every refusal is the same 404; audited as `DEMO_PERSONA_SWITCHED` with ids only.
- `POST /api/demo/scenario {kind, deadlineSeconds?}` creates a fresh fixture story (`settle-soon`, `holdout`, `capture-failure`, `big-group`; deadline 60 to 600 s, default 120) in COLLECTING; `GET /api/demo/scenario?outingId=` reports its status and money clean-up.
- `POST /api/demo/tick {outingId?}` runs one worker tick now. It only processes due work, so it can never settle early; in production it also needs `DEMO_ALLOW_PUBLIC_TICK=true` (403 otherwise).

Demo / judge mode (`DEMO_FIXTURES_ENABLED=true` only; real deployments must set it to `false`):
- `OutingView.outing.demoMode` tells the client to show the "acting as" bar (`components/outing/JudgeBar.tsx`, to-dos from the pure `lib/demo/judge.ts`) and the tap-to-add demo friends on the invite step. In judge mode any participant of an outing can act as any other participant of that outing, organizer included; see `lib/demo/judge-persona.ts` for the threat model.
- `/new` shows five starter briefs (`lib/demo/starters.ts`); each maps to a made-up FIXED_TOTAL demo venue (`lib/demo/venues.ts`, and The Sound Room in `lib/demo/seed.ts`).

Budget vote amounts: votes are PER_PERSON ("what would you personally pay?"), and `OutingView.budget.options` holds five whole-dollar amounts sized for each outing by `lib/domain/budget-options.ts`:
- The AI may suggest five per-person amounts with the brief extraction. They are used only if valid (whole dollars, strictly increasing, at least $1, largest ≤ 10× smallest) and they include the anchor below, unless that anchor is only the default.
- Otherwise the options are a ladder (0.5×, 0.75×, 1×, 1.5×, 2×, rounded to whole dollars) around the anchor: the brief's per-person budget, else its total ÷ people paying (rounded up), else the lower median per-person cost of matching catalogue offerings, else $20. Around $20 that gives the default list, $10/$15/$20/$30/$40.
- The result is stored with provenance in `outings.brief_extraction` and re-checked on every read; a per-person outing whose stored options fail the check gets the default list.
- Outings created before per-person voting (`budget_unit = TOTAL`) and without stored options get `LEGACY_TOTAL_OPTIONS_MINOR`, $50/$75/$100/$150/$200 for the whole group.
- Votes themselves stay any positive amount up to `MAX_BUDGET_MINOR` ($100,000).

## Pages

`/` landing · `/how-it-works` the flow and a split calculator · `/judge/login` judge sign-in (only when `JUDGE_PASSWORD` is set) · `/new` brief (step 1; judge sign-in when the gate is on) · `/o/[id]` participant hub (stage-driven: budget poker, reveal, proposal/sponsor/open for organizer, invitation/commit, waiting, result) · `/o/[id]/pay/fixture?attempt=` simulated approval (FIXTURE only, loudly labelled) · `/demo` stories, persona switcher and reset (demo only) · `/merchant` AG Studio dashboard · `/merchant/outings/[id]` drill-down · `/merchant/login` · `/setup` owner diagnostics (password sign-in only).

## More shared modules and rules

- `lib/http.ts`: `ServiceError`, `handle()`, `json()`, `readJson(req, zodSchema)`, `errorResponse()`, `assertSameOrigin(req)`.
- `lib/services/access.ts`: `requireParticipant(db, req, outingId)`, `requireOrganizer`, `requireMerchant(req)`, `requireMerchantOuting`, `assertUuid`.
- `lib/payments/index.ts` exports `getPaymentProvider(name?: PaymentProviderName): PaymentProvider`, defaulting to `config().paymentMode`; attempts store their provider name and the engine resolves the provider per attempt.
- `lib/ai/index.ts` exports `getOutingsAi(): OutingsAi` (ANTHROPIC if key, else FIXTURE if demo, else throws `AiUnavailableError`), `getFixtureOutingsAi(): OutingsAi` (the FIXTURE AI whatever the mode) and `aiModeForOuting(outing): AiMode` (isFixture → FIXTURE in demo mode, else DISABLED; otherwise `config().aiMode`). Services pick the AI per outing from these.
- `fixture_provider_objects` table: persistent state for the FIXTURE payment simulator (shared by web + worker).
- Race rule (payments ↔ settlement): any code that records an authorization must lock the outing row (`SELECT … FOR UPDATE`) in the same transaction; if a settlement snapshot already exists and the attempt is not among its allocations, it must immediately plan a VOID. The settlement decision transaction also locks the outing row and reads attempts inside it.
- Early cancellation: enqueue `SETTLE_DEADLINE` with payload `{ early: true, reason: "REQUIRED_DECLINED" | "ORGANIZER_CANCELLED" }` and dedupe key `settle-early:<outingId>`. `ORGANIZER_CANCELLED` cancels unconditionally; `REQUIRED_DECLINED` goes through `decideSettlement({ early: true })`.
