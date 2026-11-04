# Handoff to Codex

> Living document. Updated at every milestone by the Claude Code cloud session. If you are reading this after the cloud session ended, the last commit that touched this file is the source of truth.

## 1. Where things are

- Repository: https://github.com/Baymoor/PayPal-AI-Hackathon-2026
- Branch: `claude/wizardly-rubin-16wxoj` — everything committed and pushed; no PR opened (owner asked for milestone pushes). Run `git log -1` for the exact HEAD.
- The app boots with no external keys (labelled FIXTURE payments + FIXTURE AI). Real PayPal sandbox and real Claude are implemented but **not yet exercised** against the live services (the cloud container could not reach PayPal and had no runtime Anthropic key).

## 2. Feature status

Legend: **REAL_SANDBOX** = exercised against PayPal sandbox · **REAL_AI** = exercised against Anthropic API · **IMPLEMENTED** = code + automated tests against mocks/fixtures, not yet exercised against the real external service · **FIXTURE_ONLY** = deliberately simulated, labelled in UI · **IN_PROGRESS** · **NOT_IMPLEMENTED**

| Area | Status | Notes |
|---|---|---|
| Domain: integer money, equal split, caps, terms hash, deadline validation, settle/cancel decision, state machines | IMPLEMENTED | `lib/domain/*`, tests/domain |
| Postgres schema + migrations | IMPLEMENTED | `lib/db/schema.ts`, `drizzle/0000–0002` |
| Job queue, payment operation outbox planner, audit log | IMPLEMENTED | `lib/jobs/queue.ts`, `lib/payments/plan.ts` |
| Signed cookie sessions, hashed invite tokens, access checks | IMPLEMENTED | `lib/auth/*`, `lib/services/access.ts`, tests/access |
| Settlement engine (freeze, reconcile, sequential capture, compensation, void/refund recovery, worker, cron route, webhooks) | IMPLEMENTED | `lib/settlement/*`, `lib/jobs/*`, tests/settlement (concurrent workers, timeouts) |
| PayPal REST adapter (sandbox, server-only redirect approval) | IMPLEMENTED — **not verified against PayPal** | tested with mocked fetch only; cloud container cannot reach PayPal |
| FIXTURE payment simulator (persistent, failure injection) | FIXTURE_ONLY | labelled "Fixture — not real PayPal" |
| Outing services, read models, HTTP API, demo seed | IMPLEMENTED | tests/services; worker settles the seeded demo |
| AI (Anthropic structured output + labelled fixture) | IMPLEMENTED — **REAL_AI not verified** | no runtime key in container; mocked SDK tests |
| Consumer UI | IMPLEMENTED | built from Claude Design mockups; verified end to end in Chromium (production build) |
| Merchant AG Studio dashboard (custom Booking Readiness widget, cross-filter, NL filter, drill-down, retry) | IMPLEMENTED | trial mode (no licence key) |
| Independent audit of payments/settlement (Fable) | DONE | 2 high, 2 medium, 5 low defects found; all fixed with regression tests (tests/audit) |
| Second audit: privacy/access/consent + brief test-coverage map (Fable) | DONE | 2 medium defects fixed (merchant session expiry, no cancel after deadline); every brief §11 scenario mapped to a test (tests/audit2) |
| End-to-end browser flow, production build, Playwright e2e | DONE (FIXTURE modes) | `npm run test:e2e`: karaoke settle, required-holdout cancel, organizer cancel, demo hub — 4/4 |
| UX/a11y polish + /how-it-works explainer | DONE | axe: 0 violations on consumer screens (one third-party AG Charts landmark label remains) |
| One-click demo scenarios (settle-soon, holdout, capture-failure, big-group) | DONE (FIXTURE) | `/demo`; `POST /api/demo/scenario`, `POST /api/demo/tick`; compensation e2e |
| Real-AI verification script | READY, NOT RUN | `npx tsx scripts/ai-smoke.ts` with OUTINGS_ANTHROPIC_API_KEY |
| AG Studio depth: Money flow custom widget, Money page, Studio KPIs, saved views, grid → drill-down links | DONE | trial mode |
| `/setup` diagnostics (merchant-only) | DONE | tests PayPal OAuth / Claude without exposing secrets |
| AI plan draft (organizer) | IMPLEMENTED — REAL_AI not verified | `POST /api/outings/:id/plan-draft`; every field validated (`validatePlanDraft`), invalid fields dropped with notes; organizer confirms |
| Third audit: code added after audit 2 (demo scenarios, /setup, AI plan draft, headers, hardening) (Fable) | DONE | 1 medium (scenario button rewrote the shared catalogue) + 1 low (HSTS at runtime) fixed with tests (tests/audit3); AI draft no longer overrides organizer choices |
| Security headers (nonce CSP, HSTS in prod, frame/sniff/permissions) | DONE | `proxy.ts`, `lib/security/headers.ts`; 0 CSP violations across pages in a production build |
| Raw demo footage | DELIVERED TO OWNER (not in repo) | 6 Playwright-recorded clips from the production build + shot list, FIXTURE labels visible |
| PayPal sandbox proof (auth → $10 under-capture → void → refund) | NOT VERIFIED | run `npx tsx scripts/paypal-smoke.ts` locally with sandbox credentials |
| Deployment + scheduler | DOCUMENTED, NOT DEPLOYED | `docs/DEPLOYMENT.md`, `render.yaml` |

## 3. Commands

```bash
npm ci
```

```bash
cp .env.example .env.local   # then fill in values; create the Postgres role and databases as in the README quick start
```

```bash
npm run db:migrate && npm run db:seed
```

```bash
npm run dev        # http://localhost:3000
```

```bash
npm run worker     # deadline/settlement worker (separate terminal)
```

```bash
npm run typecheck && npm test
```

```bash
E2E_DATABASE_URL=postgres://outings:outings@localhost:5432/outings_e2e npm run test:e2e   # Playwright against a production build (wipes that db)
```

Last results (cloud session, 4 Nov 2026): `npx tsc --noEmit` clean · `npx eslint .` 0 problems · `npx vitest run` 28 files / **346 passed** · `npm run test:e2e` **6/6 passed** (karaoke settle, holdout cancel, organizer cancel, demo hub, capture-failure compensation, big-group \$10-from-\$20 under-capture) · `next build` passes.

First local run with real keys: sign in at `/merchant/login`, open **`/setup`** — it shows which env vars are set (names only) and has buttons to test PayPal sandbox OAuth and a real Claude call.

## 4. Environment variable names

`DATABASE_URL`, `APP_BASE_URL`, `SESSION_SECRET`, `CRON_SECRET`, `DEMO_FIXTURES_ENABLED`, `MERCHANT_DASHBOARD_PASSWORD`, `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`, `AG_STUDIO_LICENSE_KEY`, `OUTINGS_ANTHROPIC_API_KEY`, `OUTINGS_AI_MODEL`. Values are never committed.

## 5. PayPal capabilities

Proven against sandbox: **none yet** (network policy of the cloud container blocks PayPal hosts). Unverified until the owner runs the smoke script: AUTHORIZE order creation, buyer approval via redirect, authorize, under-capture with `final_capture=true` ($20 → $10), void, refund, webhook signature verification, `PayPal-Mock-Response` negative testing. See `docs/research/PAYPAL.md` §14 for the exact list.

## 6. Known gaps and next tasks

### Next five tasks (priority order)

1. **Prove PayPal sandbox.** Create the sandbox REST app + 2 Personal buyers, set `PAYPAL_CLIENT_ID/SECRET`, run `npx tsx scripts/paypal-smoke.ts` (and `--mock-decline`). Fix any adapter mismatches (unverified assumptions listed below), commit the redacted evidence in `docs/evidence/`, then run one full outing in `PAYPAL_SANDBOX` mode with two buyers and flip the status rows to REAL_SANDBOX.
2. **Prove real Claude.** Set `OUTINGS_ANTHROPIC_API_KEY`, run `npx tsx scripts/ai-smoke.ts`, commit the evidence, create one outing through `/new` with the real model.
3. **Deploy** (Render blueprint `render.yaml` or the `Dockerfile`): Postgres, web, worker (or a scheduler on `/api/cron/tick`), HTTPS `APP_BASE_URL`, PayPal webhook → `/api/webhooks/paypal` with `PAYPAL_WEBHOOK_ID`, AG Studio trial key. Prove a deadline settles with every browser closed on the hosted URL; keep it free and up through **15 Dec 2026**.
4. **Submission:** record the < 3 min video from `docs/DEMO_SCRIPT.md` (label fixture footage; show real sandbox/Claude only if actually recorded), fill the TODOs in `docs/HACKATHON_SUBMISSION.md`, make the repo public, submit on Devpost by **11 Nov** (hard deadline 12 Nov 21:00 CET).
5. **Hardening:** a shared (Postgres-backed or edge) rate limiter for multi-instance hosting; the AG Studio data source (`components/merchant/studioData.ts`) still formats in the `NEXT_PUBLIC_MERCHANT_TIMEZONE` fallback. Switch it to `merchantTz(row)` from `components/merchant/format.ts`, as the drill-down already does. Optional: PayPal JS SDK v6 popup on top of the redirect flow. Done: trusted-proxy-aware rate-limit keys (`TRUSTED_PROXY_HOPS`; set it when deploying, see [DEPLOYMENT.md](DEPLOYMENT.md)); payee taken from `merchants.paypal_merchant_id` with `PAYPAL_MERCHANT_ID` as fallback, for both order creation and authorization verification; `merchantTimezone` carried in `MerchantBookingRow`.

### Unverified PayPal assumptions (see docs/research/PAYPAL.md §14)

`payer-action` vs `approve` link selection; `token` query parameter on return; authorization status/remainder after a partial `final_capture`; exact issue-code names (e.g. PREVIOUSLY_CAPTURED, AUTHORIZATION_ALREADY_CAPTURED); `PayPal-Mock-Response` support on capture/void/refund; idempotency retention window (designed for 6 h).

### Known limitations / minor defects

- Rate limiter is in-memory per process. The client IP is the `TRUSTED_PROXY_HOPS`-th `X-Forwarded-For` entry from the right. The default of 0 trusts no header, so all clients share one bucket per route; set it to 1 behind a single load balancer.
- `OutingView.outing.paymentMode` comes from config, not from the outing's own attempts (fixture outings in a PayPal-configured deployment still use FIXTURE — enforced in `startPayment`).
- Sessions are signed cookies without server-side revocation (merchant sessions expire after 12 h).
- AG Studio: trial watermark off localhost without a key; grid scrolls horizontally below ~1300 px; NL-query focus ring locates widgets by layout order; one axe finding inside AG Charts (third-party landmark label).
- `next dev`/`next build` with a custom `NEXT_DIST_DIR` rewrites `tsconfig.json` includes — restore with `git checkout tsconfig.json`.
- Seeded "Maya's birthday karaoke" closes ~2 h after seeding; use the `/demo` scenarios for a live settlement.
- Budget poker implements TOTAL mode only (no per-person input mode).

## 7. Visual direction

Warm cream / navy ink / coral, Fraunces display + Inter UI. Reference images `docs/design/reference/D01–D05` (+ D06 brief screen described in `docs/design/README.md`). Claude Design canvas: https://claude.ai/artifact/7vF112AViHWwk1iwENUJeq (private to the owner's account). Spec overrides: reveal is aggregate-only (D02 shows names), vote options $50–$200.

## 8. AG Studio licence and deployment

No `AG_STUDIO_LICENSE_KEY` in the cloud container: Studio runs in trial mode (watermark off localhost). The owner must request the 45-day trial and keep the hosted demo working through 15 Dec 2026. Deployment needs: Postgres, a long-running worker or a scheduler calling `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute, HTTPS `APP_BASE_URL` for PayPal return URLs, and a PayPal webhook pointed at `/api/webhooks/paypal`.

## 9. Models used in the cloud session

All three requested models were available and used via subagent routing:

- **Opus 5.5** — coordinator (architecture, domain core, schema, contracts, integration, commits); payments package; outing services/API/seed; end-to-end integration + Playwright; demo scenarios.
- **Fable 5.1** — settlement engine (deadline freeze, reconciliation, sequential capture, compensation, worker, webhooks); independent audit #1 (payments/settlement) + follow-up fixes; independent audit #2 (privacy/access/consent + coverage map).
- **Sonnet 5.5** — Claude Design mockups + design system; AG Studio and PayPal research; AI module; consumer UI; merchant AG Studio dashboard; hackathon docs; UX/a11y polish + /how-it-works; AI smoke script.

## 10. Credits

Owner reported "$150 of $250 left", expiring 5 Nov 2026 08:59 GMT+1 (Cloud session credits). Exact consumption is not visible from inside the container — check the claude.ai billing UI.
