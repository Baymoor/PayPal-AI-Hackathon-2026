# Handoff to Codex

> Living document. Updated at every milestone by the Claude Code cloud session. If you are reading this after the cloud session ended, the last commit that touched this file is the source of truth.

## 1. Where things are

- Repository: https://github.com/Baymoor/PayPal-AI-Hackathon-2026
- Branch: `claude/wizardly-rubin-16wxoj` (all work pushed; no PR yet — the owner asked for milestone pushes)
- HEAD: see `git log -1` (this file is updated alongside milestone commits)

## 2. Feature status

Legend: **REAL_SANDBOX** = exercised against PayPal sandbox · **REAL_AI** = exercised against Anthropic API · **IMPLEMENTED** = code + automated tests against mocks/fixtures, not yet exercised against the real external service · **FIXTURE_ONLY** = deliberately simulated, labelled in UI · **IN_PROGRESS** · **NOT_IMPLEMENTED**

| Area | Status | Notes |
|---|---|---|
| Domain: integer money, equal split, caps, terms hash, deadline validation, settle/cancel decision, state machines | IMPLEMENTED | `lib/domain/*`, 47 unit tests |
| Postgres schema + migrations | IMPLEMENTED | `lib/db/schema.ts`, `drizzle/` |
| Job queue, payment operation outbox planner, audit log | IMPLEMENTED | `lib/jobs/queue.ts`, `lib/payments/plan.ts` |
| Signed cookie sessions, hashed invite tokens, access checks | IMPLEMENTED | `lib/auth/*`, `lib/services/access.ts` |
| Settlement engine (freeze, reconcile, capture/void/refund, compensation, worker, cron, webhooks) | IN_PROGRESS | Fable 5.1 agent |
| PayPal REST adapter (sandbox) | IN_PROGRESS | **cannot be live-tested from the cloud container** (api-m.sandbox.paypal.com blocked) |
| Fixture payment simulator | IN_PROGRESS | labelled "Fixture — not real PayPal" |
| Outing services, views, HTTP API, seed, access tests | IN_PROGRESS | Opus 5.5 agent |
| AI (Anthropic structured output + labelled fixture) | IN_PROGRESS | no `OUTINGS_ANTHROPIC_API_KEY` in the cloud container → REAL_AI unverified |
| Consumer UI | IN_PROGRESS | Sonnet 5.5 agent, from Claude Design mockups |
| Merchant AG Studio dashboard | IN_PROGRESS | Sonnet 5.5 agent |
| PayPal sandbox proof (auth → $10 under-capture → void → refund) | NOT VERIFIED | run `scripts/paypal-smoke.ts` locally with sandbox credentials |
| Deployment + scheduler | NOT_IMPLEMENTED | see §8 |

## 3. Commands

```bash
npm install
```

```bash
cp .env.example .env.local   # then fill in values
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

Last results: see the milestone commit messages and §10.

## 4. Environment variable names

`DATABASE_URL`, `APP_BASE_URL`, `SESSION_SECRET`, `CRON_SECRET`, `DEMO_FIXTURES_ENABLED`, `MERCHANT_DASHBOARD_PASSWORD`, `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`, `AG_STUDIO_LICENSE_KEY`, `OUTINGS_ANTHROPIC_API_KEY`, `OUTINGS_AI_MODEL`. Values are never committed.

## 5. PayPal capabilities

Proven against sandbox: **none yet** (network policy of the cloud container blocks PayPal hosts). Unverified until the owner runs the smoke script: AUTHORIZE order creation, buyer approval via redirect, authorize, under-capture with `final_capture=true` ($20 → $10), void, refund, webhook signature verification, `PayPal-Mock-Response` negative testing. See `docs/research/PAYPAL.md` §14 for the exact list.

## 6. Known defects / next tasks

To be filled at the end of the cloud session.

## 7. Visual direction

Warm cream / navy ink / coral, Fraunces display + Inter UI. Reference images `docs/design/reference/D01–D05` (+ D06 brief screen described in `docs/design/README.md`). Claude Design canvas: https://claude.ai/artifact/7vF112AViHWwk1iwENUJeq (private to the owner's account). Spec overrides: reveal is aggregate-only (D02 shows names), vote options $50–$200.

## 8. AG Studio licence and deployment

No `AG_STUDIO_LICENSE_KEY` in the cloud container: Studio runs in trial mode (watermark off localhost). The owner must request the 45-day trial and keep the hosted demo working through 15 Dec 2026. Deployment needs: Postgres, a long-running worker or a scheduler calling `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute, HTTPS `APP_BASE_URL` for PayPal return URLs, and a PayPal webhook pointed at `/api/webhooks/paypal`.

## 9. Models used in the cloud session

Coordinator: Opus 5.5. Subagents: Fable 5.1 (settlement engine; later independent audit), Opus 5.5 (payments; outing services/API), Sonnet 5.5 (design mockups, AG Studio + PayPal research, AI module, consumer UI, merchant dashboard). All three requested models were available.

## 10. Credits

Owner reported "$150 of $250 left", expiring 5 Nov 2026 08:59 GMT+1 (Cloud session credits). Exact consumption is not visible from inside the container — check the claude.ai billing UI.
