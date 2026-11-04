# Outings

> Turn a group plan into an approved, fairly shared booking. Budget poker, a covered guest of honour, PayPal sandbox authorizations of each person's maximum share, and a server-side deadline that either settles the booking or releases every hold.

Independent project for the **PayPal AI Hackathon 2026**. Uses **PayPal sandbox** payments only — no real money moves. "Outings" is a working name.

## How it works

1. **Brief** — the organizer writes a plain-language plan ("A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share."). Claude extracts structured preferences (activity, date window, group size, budget unit, guest of honour) with schema-validated output.
2. **Budget poker** — everyone privately suggests a TOTAL budget. Votes are private until reveal (enforced by the API), and the reveal shows only the aggregate. A vote is never a payment.
3. **Invite** — Claude ranks a small merchant-owned catalogue; the organizer picks a quote (e.g. *The Sound Room — private karaoke room, $100 fixed total, up to 10 people*), optionally covers one guest of honour, and opens commitments with a deadline ≤ 48 h.
4. **Commit** — each payer reviews the exact terms and authorizes their maximum ($100 / 5 payers = $20) through PayPal (Orders v2, intent AUTHORIZE). More payers lower the *estimated* share ($10 with 10 payers) — nothing is charged yet.
5. **Deadline** — a durable server job (not a browser timer, not an LLM) freezes the roster. If every required person committed: capture each exact share (≤ their maximum, penny-exact) with `final_capture`. Otherwise: cancel and void every hold. If a capture fails mid-way: stop, void the rest, refund completed captures, and show the recovery.

The merchant sees everything in an **AG Studio** dashboard with an AG Grid booking table, a custom *Booking Readiness* widget, and a safe natural-language query.

## Quick start

Requirements: Node ≥ 22.12, npm, Postgres 16.

```bash
npm install
```

```bash
cp .env.example .env.local
```

```bash
createdb outings   # or: psql -c "CREATE DATABASE outings"
```

```bash
npm run db:migrate && npm run db:seed
```

```bash
npm run dev
```

```bash
npm run worker
```

Open http://localhost:3000 (consumer) and http://localhost:3000/merchant (dashboard). Without PayPal or Anthropic keys the app runs in clearly labelled **FIXTURE** modes (`DEMO_FIXTURES_ENABLED=true`): simulated approvals and deterministic AI parsing, never presented as real PayPal or real model output.

### Real PayPal sandbox

1. In the PayPal Developer Dashboard create a sandbox REST app (Business merchant) and at least two Personal buyer accounts.
2. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (and `PAYPAL_WEBHOOK_ID` for webhooks) in `.env.local`.
3. Run the sandbox proof script: `npx tsx scripts/paypal-smoke.ts` (authorize $20 → capture $10 → void → refund), which writes redacted evidence to `docs/evidence/`.

### Real AI

Set `OUTINGS_ANTHROPIC_API_KEY` (and optionally `OUTINGS_AI_MODEL`, default `claude-sonnet-5-5`). This is the app's runtime key, deliberately separate from any Claude Code credentials.

## Tests

```bash
npm run typecheck
```

```bash
npm test
```

Integration tests need a Postgres database at `TEST_DATABASE_URL` (default `postgres://outings:outings@localhost:5432/outings_test`).

End-to-end tests drive real Chromium contexts (one per person) against the **production build** in FIXTURE modes: the canonical karaoke flow from brief to deadline settlement and the merchant dashboard, a required-guest-missing cancellation with voided holds, and the `/demo` persona hub. The deadline is enforced by the server; the tests advance the worker through the scheduler endpoint (`POST /api/cron/tick`).

```bash
npm run test:e2e
```

This builds into `.next-e2e`, starts the app on port 3400, and **resets the database at `DATABASE_URL`** (migrate + `demo:reset`). `E2E_SKIP_BUILD=1` reuses an existing build; `E2E_SCREENSHOTS=1` refreshes `docs/screenshots/`.

## Screenshots

Captured by the e2e suite from the running app (FIXTURE payments and FIXTURE AI, labelled on every screen):

| | | |
|---|---|---|
| ![Brief](docs/screenshots/brief.png) | ![Budget poker](docs/screenshots/budget-poker.png) | ![Invitation](docs/screenshots/invitation.png) |
| ![Waiting](docs/screenshots/waiting.png) | ![Confirmed](docs/screenshots/confirmed.png) | ![Cancelled](docs/screenshots/cancelled.png) |

Organizer and merchant views: [reveal](docs/screenshots/reveal.png) · [sponsor & open](docs/screenshots/sponsor.png) · [merchant dashboard](docs/screenshots/merchant-dashboard.png) · [drill-down](docs/screenshots/merchant-drilldown.png) · [payments](docs/screenshots/merchant-drilldown-payments.png)

## Documentation

- [Product & financial spec](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Module contracts & HTTP API](docs/CONTRACTS.md)
- [Design system](docs/design/DESIGN_SYSTEM.md)
- [PayPal integration research](docs/research/PAYPAL.md) · [AG Studio research](docs/research/AG_STUDIO.md)
- [Source provenance](docs/PROVENANCE.md)
- [Handoff / status](docs/HANDOFF_TO_CODEX.md)

## Known limitations

- PayPal sandbox flows are implemented against the official API specs but **have not yet been exercised against PayPal** from the build environment (see the handoff for the verification checklist).
- One merchant, one currency (USD), fixed-total pricing for shared bookings.
- AG Studio is commercial software used under its evaluation trial; AG Grid Community is MIT.

## License

MIT — see [LICENSE](LICENSE). Third-party notices in [docs/PROVENANCE.md](docs/PROVENANCE.md).
