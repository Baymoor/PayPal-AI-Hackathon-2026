# Judge guide

Outings is an independent project for the PayPal AI Hackathon 2026. It is not a PayPal product and uses **PayPal sandbox** only; no real money moves.

**What it is.** A group plans an outing, votes privately on a budget, and each person authorizes only their *maximum* share through PayPal. A server-side deadline job then either captures each person's exact share (penny-exact, never above their maximum) or voids every hold.
**Why it matters.** Splitting a group booking today means one friend fronts the money and chases everyone. Here the money goes straight to the experience merchant and nobody is charged unless the whole agreed group commits.

Read this before you start: some parts of the demo are **FIXTURE** (simulated and labelled as such on screen). Section 5 lists exactly which, and section 6 lists what has not been verified against the real services.

## 1. Fastest way to evaluate (about 10 minutes)

| Minutes | Do this |
|---|---|
| 0-1 | Skim section 5 (fixture vs real). Optionally open **`/how-it-works`** and try the split calculator (same `lib/domain/money.ts` functions the server uses). |
| 1-4 | Section 3: the consumer click path at `/demo`. Start a deadline scenario (3a) first so it is due by the time you finish. |
| 4-6 | Section 3a: watch the deadline settle, cancel and compensate. Section 4: the merchant dashboard at `/merchant` (Bookings page, Money page, saved views). |
| 6-9 | Section 7: read `decideSettlement`, `equalSplit`, and the compensation tests. |
| 9-10 | Run `npm run typecheck && npm test` (section 8), or check the CI result. |

## 2. Run it locally

Requirements: Node >= 22.12, npm, Postgres 16.

First create the Postgres role and databases that `.env.example` points at, as a Postgres superuser (for example `sudo -u postgres psql` on Linux or `psql postgres` with Homebrew). The role must own the databases because the migrations create schemas:

```sql
CREATE ROLE outings LOGIN PASSWORD 'outings';
CREATE DATABASE outings OWNER outings;
CREATE DATABASE outings_test OWNER outings;  -- for npm test
```

```bash
npm ci
cp .env.example .env.local
npm run db:migrate && npm run db:seed
npm run dev               # http://localhost:3000
npm run worker            # second terminal: deadline/settlement worker
```

The scripts (`db:migrate`, `db:seed`, `demo:reset`, `worker`) read `.env.local` and then `.env`, like Next.js. Variables set in the shell take precedence. Keep `DEMO_FIXTURES_ENABLED=true`, which enables the labelled FIXTURE payment and AI modes, the demo seed, and persona switching. `SESSION_SECRET` and `CRON_SECRET` may stay empty locally. Without `SESSION_SECRET` the app uses a random secret per process, so demo sessions reset when the dev server restarts; set it with `openssl rand -hex 32` to keep them. Without `CRON_SECRET`, `POST /api/cron/tick` is open, but only in demo mode outside production. If you run on another port (`npm run dev -- -p 3001`), set `APP_BASE_URL` to match, because the fixture approval links are built from it. `npm run demo:reset` truncates every app table and re-seeds; `npm run db:seed` replaces only the fixture outings.

A hosted demo URL: **TODO: add the hosted URL once deployed (see [DEPLOYMENT.md](DEPLOYMENT.md)). Until then, run locally.**

## 3. The 3-minute consumer click path

0. Optional: open **`/how-it-works`** (linked from the landing page). It explains the flow, what happens at the deadline and where AI stops, and has an interactive **split calculator**: change the total, payer count and sponsored guests and see the penny-exact split, the cap and the estimate, computed by the real `equalSplit`, `perPayerCap` and `estimatedShare`.
   ![How it works](screenshots/how-it-works.png)

![Brief](screenshots/brief.png)

1. Open **`/demo`**. It lists personas for the seeded outing "Maya's birthday karaoke" (a $100 fixed-total private karaoke room at The Sound Room, capacity 10) and a second "Friday game night" outing for budget poker. Both pages show FIXTURE badges.
2. **Budget poker** (the game night persona set). Switch between personas and cast votes. Each voter sees only their own vote. The API never returns other people's amounts, before or after the reveal. The organizer reveals once at least 3 people have voted, and the reveal shows an aggregate distribution only (no names).
   ![Budget poker](screenshots/budget-poker.png) ![Reveal](screenshots/reveal.png)
3. **Sponsored guest** (organizer view of the karaoke outing). The organizer covers Maya, the birthday guest. $100 over 5 payers gives **$20 each**, and Maya pays $0. Maya still has to accept attendance.
   ![Sponsor](screenshots/sponsor.png)
4. **Invitation and commit**. Switch to **Noor**, the one required payer who has not committed in the seed. Open the invitation, read the exact terms, and commit. The copy reads "Authorize up to $20. Your final share may be lower." The consent is bound to a hash of the terms.
   ![Invitation](screenshots/invitation.png)
5. **Fixture approval**. Pressing the pay button opens our own clearly labelled "Fixture, not real PayPal" approval page. Approve it. With real sandbox credentials this step is a redirect to PayPal instead (section 6).
6. **Waiting**. Noor sees "$20 authorized, estimated final share $10 if 10 people pay, not charged yet". The hold stays $20 even when the estimate drops.
   ![Waiting](screenshots/waiting.png)
7. **Worker tick, then confirmed**. The seeded deadline is about 2 hours away, so use the scenarios in section 3a to watch settlement in about 2 minutes. At the deadline the worker freezes the roster, captures each exact share with `final_capture`, and the outing becomes **Confirmed**.
   ![Confirmed](screenshots/confirmed.png)
8. **Cancelled path**. If a required person never commits, the same job cancels the outing and voids every hold. The seed already contains a confirmed and a cancelled outing so you can see both without waiting.
   ![Cancelled](screenshots/cancelled.png)

### 3a. Watch a deadline settle (one-click scenarios, about 2 minutes each)

On `/demo`, the **Watch a deadline settle** section creates a fresh demo outing at The Sound Room ($100 private karaoke room, capacity 10, Maya sponsored, Friday 19:00) whose commitment deadline is 1, 1.5, 2 (default) or 5 minutes away. Pick a scenario and press **Start (closes in 2 min)**. The panel that appears shows a countdown against the server clock, every person with an **Open as …** button, a **Process due work now** button, and **Open merchant drill-down**.

| Scenario | Do this | What you should see |
|---|---|---|
| **The last payer commits in time** | Open as **Noor**, review the terms and authorize $20 before the countdown ends. Wait for "Deadline passed", then press **Process due work now** (or let `npm run worker` do it). | Confirmed. Five payers captured $20 each, Maya $0, never above anyone's $20 maximum. |
| **A required guest holds out** | Do nothing as Noor. After the deadline, process due work. | Cancelled ("A required guest didn't commit before the deadline"), no booking payment collected, all four holds released. |
| **A capture fails mid-settlement** | After the deadline, process due work, open as **Ben**, then process again a few seconds later. | Never confirmed. Alex, Ben and Freya are captured, Jules's capture is declined, Noor's capture is skipped. Jules's and Noor's holds are released and the three captures refunded. First pass: "Booking not confirmed. A payment failed; completed payments are being refunded." (clean-up: refund pending, because the response to Ben's refund was lost). Second pass: the refund is read back from the provider, not sent twice, and the clean-up is complete. The merchant drill-down lists three succeeded Refund operations and two Release hold operations. |
| **Ten friends share the room** | Start it, open as **Kai** (the tenth payer), review the terms and authorize $20: "estimated final share $10". Wait for "Deadline passed", then press **Process due work now**. | Confirmed. All ten payers each authorized a $20 maximum and are each charged exactly $10 (total $100) from their $20 hold; the rest of each hold is released (under-capture, final capture). Fixture simulator, not real PayPal. |

What is real and what is simulated here:

- **Real code paths.** Collection is opened by the real `openCollection` service (deadline validation, availability, `buildCommitmentTerms` / `hashTerms`, the deadline job). Maya's acceptance, each payer's consent and each hold go through the real `respond`, `consent`, `startPayment` and `approveFixturePayment` services. Settlement, capture, compensation and reconciliation are the unmodified engine (`runWorkerTick`). Only the earlier history (brief, private votes, reveal, proposal) is seeded, with the labelled FIXTURE parser.
- **Simulated.** Every scenario hold, capture, void and refund is **FIXTURE** ("Fixture, not real PayPal"), even when PayPal sandbox keys are configured. The capture-failure scenario tells the simulator to decline Jules's capture and to drop the response to Ben's refund (`setFixtureFailure`: `DECLINE`, `TIMEOUT_AFTER`). Nothing here is evidence about PayPal's own behaviour.
- **"Process due work now"** (`POST /api/demo/tick`) runs one pass of the same worker the scheduler runs. It only processes work that is already due: the engine freezes and settles against the stored deadline using the database clock, so pressing it early changes nothing (try it). It exists only in demo mode, and only outside production unless `DEMO_ALLOW_PUBLIC_TICK=true` is set; on a hosted demo the background worker settles within seconds anyway.
- Scenario runs also appear under "Every other outcome" and in the merchant dashboard. **Reset demo data** removes them.

To build a settlement yourself instead, create an outing at `/new` with a "Commit by" time 1 to 2 minutes ahead (the minimum window is 1 minute), have the required people commit, and let `npm run worker` run (`npm run worker:once` runs a single tick).

## 4. The merchant dashboard (AG Studio)

1. Open **`/merchant`** and use the one-click **demo login** (demo mode only; otherwise the password is `MERCHANT_DASHBOARD_PASSWORD`).
2. The dashboard is a two-page AG Studio report. Switch pages with the **Bookings / Money** tabs.
   - **Bookings** page: KPI value widgets (open, closing today, captured, refunds pending), bookings by status, money by stage, the custom **Booking Readiness** widget (how close each open outing is to being bookable), and an AG Grid bookings table. Clicking a bar, slice or readiness row cross-filters everything on the page, including the KPIs.
   - **Money** page: KPIs, the custom **Money flow** widget (per outing, where each authorized dollar went: kept, refund due, refunded, still on hold), captured vs refunded, and holds outstanding. Authorized holds are never counted as revenue. After running the capture-failure scenario (3a), find that outing here: it shows captured money moving into refund due, then refunded.
   ![Merchant dashboard](screenshots/merchant-dashboard.png) ![Merchant money](screenshots/merchant-money.png)
   - **Saved views** dropdown: "Closing today with missing required", "Recovery in progress", "Confirmed this week". Each applies a visible plain-language rule through Studio's report state; choose "all bookings" to clear it.
3. Ask the natural-language box: **"Show outings closing today with missing required participants."** The model (or the labelled fixture parser) returns a validated, read-only filter. It cannot capture, void or refund anything.
4. Click an outing name in the Bookings table (or **View details** in Booking Readiness) to open the **drill-down**. Clicking elsewhere in a row cross-filters the page instead. Scenario outings started twice have the same title, so their names are not links; open those from **Open merchant drill-down** on `/demo`. The drill-down shows per-participant status, the authorized vs allocated vs captured vs refunded money (kept as separate figures), the payment operations, and a retry for failed operations that already exist.
   ![Merchant drill-down](screenshots/merchant-drilldown.png) ![Payments](screenshots/merchant-drilldown-payments.png)

## 5. Fixture vs real

| Piece | Default without keys | With keys |
|---|---|---|
| Payments | **FIXTURE** simulator (persistent, with failure injection), labelled "Fixture, not real PayPal" | PayPal **sandbox** via Orders v2 and Payments v2, set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (and `PAYPAL_WEBHOOK_ID` for webhooks) |
| AI | **FIXTURE** deterministic parser, labelled; never shown as model output | Anthropic Claude via `OUTINGS_ANTHROPIC_API_KEY` (optional `OUTINGS_AI_MODEL`, default `claude-sonnet-5-5`) |
| AG Studio | Trial mode (evaluation watermark off localhost). The Studio agent panel is available only with the Anthropic key | `AG_STUDIO_LICENSE_KEY` |
| Seeded outings | All flagged `isFixture`, created through the real fixture provider and real `decideSettlement` | n/a |
| Deadline scenarios (`/demo`) | `isFixture` outings opened, consented and authorized through the real services; settled by the real worker; failures injected into the simulator | Still FIXTURE (scenarios never use PayPal sandbox) |
| Deadline job, settlement, splitting, consent, access control | Real code in both modes | Same |

`GET /api/health` reports the active modes without secrets.

To use real sandbox payments: create a sandbox REST app (Business merchant) and at least two Personal buyer accounts in the PayPal Developer Dashboard, set the variables above, and set `APP_BASE_URL` to the URL PayPal can redirect back to. The proof script is `npx tsx scripts/paypal-smoke.ts` (authorize $20, capture $10, void, refund). It writes redacted evidence to `docs/evidence/`. The matching check for Claude is `npx tsx scripts/ai-smoke.ts`, run by the owner with `OUTINGS_ANTHROPIC_API_KEY` set; no run is recorded yet.

## 6. What has and has not been verified

Read [HANDOFF_TO_CODEX.md](HANDOFF_TO_CODEX.md) for the authoritative status matrix. In short:

- **Automated tests** cover the domain rules, the settlement engine and the PayPal adapter (the adapter against a mocked `fetch` only).
- **Not yet verified against PayPal:** nothing has been exercised against the PayPal sandbox from the build environment. Under-capture ($20 authorization, $10 capture) and remainder release, redirect-return parameters, webhook signature verification, and the `PayPal-Mock-Response` header are all unverified. The list is in [research/PAYPAL.md](research/PAYPAL.md) section 14. TODO: update this section after running the smoke script.
- **Not yet verified against Anthropic:** no runtime key was available while building; tests use a mocked SDK. TODO: record a real call.
- **Verified in the build environment (FIXTURE modes only):** 344 Vitest tests in 28 files, Playwright specs (karaoke settle, holdout cancel, organizer cancel, demo hub, capture-failure compensation), eslint and `tsc` clean, `next build` passes. Two independent audits are done and their fixes have regression tests in `tests/audit` and `tests/audit2`.
- **Not verified:** the real PayPal sandbox and real Claude (`scripts/ai-smoke.ts` has not been run). TODO: hosted URL, demo video URL and AG Studio trial expiry are not recorded.

## 7. Where the hard parts are in the code

| Hard part | Look at | Test that proves it |
|---|---|---|
| Penny-exact split: `base = floor(total/N)`, the first `total % N` payers get +1 cent in a stable order | `equalSplit`, `perPayerCap`, `estimatedShare` in `lib/domain/money.ts` | `tests/domain/money.test.ts` ("always sums exactly to the total...") |
| The settle-or-cancel decision, fail closed on anything unverifiable | `decideSettlement` in `lib/domain/policy.ts` | `tests/domain/policy.test.ts` (two `describe` blocks: canonical examples, ALL_REQUIRED and fail-closed rules) |
| Consent bound to exact terms | `buildCommitmentTerms`, `hashTerms` (SHA-256 of canonical JSON) in `lib/domain/policy.ts` | "any material change produces a different hash"; `tests/services/outings.test.ts` "rejects stale consent after the terms change" |
| Deadline job, freeze, snapshot, planning operations | `lib/settlement/deadline.ts` | `tests/settlement/deadline.test.ts` |
| Sequential capture, partial failure, compensation (void the rest, refund the captured) | `lib/settlement/operations.ts` (`processDueOperations`, `finalizeOuting`, `recomputeCleanup`) | `tests/settlement/operations.test.ts` "partial group capture failure"; end to end through the demo scenario: `tests/services/demo-scenarios.test.ts` and the browser test `tests/e2e/compensation.spec.ts` |
| UNKNOWN outcomes reconciled before any retry; same `PayPal-Request-Id` | `lib/settlement/operations.ts`, `lib/settlement/reconcile.ts`, `lib/payments/paypal.ts` | "UNKNOWN outcomes are reconciled before any retry", "two concurrent worker ticks send each capture exactly once" |
| Late authorizations are voided, never admitted | `lib/settlement/reconcile.ts`, `lib/services/payments.ts` | `tests/payments/service.test.ts` race-rule tests |
| Private budget votes | `lib/services/views.ts`, `lib/services/outings.ts` | `tests/access/access.test.ts` "never exposes other people's vote amounts" |
| AI never decides money | `lib/ai/*` (output validated and clamped), `lib/ai/validate.ts` | `tests/ai/ai.test.ts` validation block; prompt-injection tests in `tests/services` and `tests/access` |

Architecture diagrams and the invariants list are in [ARCHITECTURE.md](ARCHITECTURE.md); the full test map is in [TESTING.md](TESTING.md); limits and threat model are in [SECURITY_AND_LIMITATIONS.md](SECURITY_AND_LIMITATIONS.md).

## 8. Run the tests

```bash
npm run typecheck
npm test
```

Integration tests need Postgres at `TEST_DATABASE_URL` (default `postgres://outings:outings@localhost:5432/outings_test`, created in section 2). `npm test` reads it from the shell, not from `.env.local`. CI (`.github/workflows/ci.yml`) runs migrate, typecheck, lint and tests against Postgres 16.
