# Devpost submission draft

Draft text for the PayPal AI Hackathon 2026 Devpost page (deadline 12 Nov 2026 21:00 CET). Items marked **TODO** depend on verification or deployment that has not happened yet; replace or delete them before submitting. Do not submit claims that are not backed by evidence.

## Name and tagline

**Outings** (working name; an independent project that uses PayPal sandbox, not a PayPal product)

*Turn a group plan into an approved, fairly shared booking. Everyone authorizes their maximum, the server settles at the deadline, and nobody fronts the money.*

## Links

| Item | Value |
|---|---|
| Public repository | https://github.com/Baymoor/PayPal-AI-Hackathon-2026 (MIT licence) |
| Demo video (YouTube, under 3 min) | **TODO: add URL after upload** |
| Hosted demo | **TODO: add URL after deployment; must stay up through 15 Dec 2026** |
| Run it yourself | [README](../README.md), [JUDGE_GUIDE.md](JUDGE_GUIDE.md); real-service checks the owner runs: `scripts/paypal-smoke.ts`, `scripts/ai-smoke.ts` |

## Inspiration

Booking something for a group (a karaoke room, a game night, a birthday dinner) usually means one friend pays up front and spends weeks chasing everyone else. People hesitate to commit because they do not know their share until the headcount is final, and the organizer carries the financial risk. We wanted payment itself to be the commitment mechanism: each person says "I am in for up to this much", and money moves only if the whole agreed group is in.

## What it does

1. **Brief.** The organizer describes the plan in plain language, or starts from one of five examples (karaoke, movie night, wine tasting, gym session, padel). Claude extracts structured preferences with schema-validated output.
2. **Budget poker.** Everyone privately suggests a total budget from five amounts sized to the outing (Claude suggests them; the server accepts them only if they are valid and include any budget the brief states, else builds them from the brief or the venue's price). Votes stay private until the organizer reveals an aggregate (at least 3 votes, no names), enforced by the API. A vote is never a payment.
3. **Proposal.** Claude ranks the venues' offerings against the brief and the agreed budget; the organizer picks a quote (for example, a private karaoke room, $100 fixed total, up to 10 people), can let Claude draft the rest of the plan for review, and can cover one guest of honour.
4. **Commit.** Each payer reviews the exact terms and authorizes their *maximum* share through PayPal: $100 across 5 payers is $20. More payers lower the estimated share ($10 with 10 payers) but not the hold. A sponsored guest accepts attendance and pays $0.
5. **Deadline.** A durable server job freezes the roster. If every required person committed, it captures each exact share (penny-exact, never above the cap). Otherwise it cancels and voids every hold. If a capture fails mid-way it stops, voids the rest, refunds completed captures, and shows the recovery.
6. **Merchant view.** The experience merchant sees bookings, readiness and money in a two-page AG Studio report (Bookings and Money), with saved views, and can ask natural-language, read-only questions.

Three extras help evaluators. **Judge mode** (demo mode only) lets one browser play every person: tap-to-add demo friends, an "Acting as" bar that switches person in one click and shows who still needs to act, and a "Next:" hint. **`/how-it-works`** explains the flow and has an interactive split calculator that runs the real `lib/domain/money.ts` functions. **`/demo`** has one-click scenarios (settle-soon, holdout, capture-failure, big group) that open a fresh fixture outing with a deadline 1 to 5 minutes away, so a settlement, a cancellation and a mid-settlement capture failure (COMPENSATING, refunds and voids, then CANCELLED with REFUND_PENDING moving to COMPLETE) can be watched live. Scenario money is always FIXTURE (the simulator), never PayPal.

Payments go directly to the experience merchant; the organizer never receives the group's money.

## How we built it

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript, Tailwind |
| Data | Postgres 16 with Drizzle ORM; durable job queue and payment-operation outbox |
| Payments | PayPal REST sandbox: Orders v2 (intent AUTHORIZE) and Payments v2 (authorize, capture, void, refund), server-only OAuth, `PayPal-Request-Id` on every mutation, webhook verification |
| AI | Anthropic Claude with structured outputs, validated by zod; a deterministic stand-in labelled "Sample AI text (no model call)" when no key is set |
| Merchant UI | AG Studio with AG Grid (Community for the drill-down grid) |
| Worker | `npm run worker` loop, or an authenticated `POST /api/cron/tick` from any scheduler |
| Tests | 440 Vitest tests in 35 files against a real Postgres database, plus Playwright end-to-end specs (see [TESTING.md](TESTING.md)) |

The money logic lives in a small pure domain layer (integer minor units, equal split, cap, terms hash, settle-or-cancel decision) so it can be tested exhaustively. Provider calls never run inside a database transaction, and every provider mutation has a durable outbox row with a stable request id.

## How PayPal is central

PayPal authorization is the product, not a checkout button bolted on at the end.

- **Authorize, then capture later.** Authorizations let a person commit without being charged until the group is confirmed. That is exactly the "I am in, if you are in" semantics a group booking needs.
- **Cap versus share.** The hold is the maximum share; the capture is the real allocated share. Capturing less than the authorized amount with `final_capture` is how the design lets the share fall when more friends join. Verified in the PayPal sandbox: a $20 authorization captured at $10 with `final_capture: true` completes, the authorization then reads `CAPTURED`, and PayPal releases the remaining $10 with no extra call ([evidence](evidence/README.md)).
- **Void and refund.** Cancellation voids holds; partial capture failure refunds completed captures.
- **Idempotency and unknown outcomes.** Timeouts are treated as UNKNOWN and reconciled by reading PayPal state before any retry, with the same `PayPal-Request-Id`.
- **Webhooks** are signature-verified, deduplicated by event id, and only trigger a re-read of provider state.

Status today: the adapter is implemented from the official OpenAPI specs, tested with a mocked `fetch`, and verified against the PayPal REST sandbox with `scripts/paypal-smoke.ts`: authorize, $10-of-$20 final capture, idempotent capture replay on the same `PayPal-Request-Id`, void (a capture afterwards is refused with `AUTHORIZATION_VOIDED`), and full capture plus refund. One full outing then ran through the app itself in `PAYPAL_SANDBOX` mode: three participants each approved a $50 hold through the app's PayPal redirect (all three approvals used the one sandbox buyer account, so this proves the app's per-person flow, not three different PayPal buyers), and at the deadline the server captured $33.34, $33.33 and $33.33 (exactly $100.00) without anyone taking an action; PayPal's own records match the app's for every payer. Redacted evidence is in [`docs/evidence/`](evidence/README.md). Not yet verified: webhook signature verification (PayPal cannot deliver webhooks to a local machine) and negative testing.

## How AI is used, and not used

**Used for:** extracting structured preferences from the brief; suggesting five budget vote amounts that fit the outing; ranking catalogue offers against budget and capacity; drafting the organizer's plan for review; summarizing the aggregate budget reveal; explaining deterministic outcomes; turning a merchant question into a validated read-only dashboard filter; and (optionally) answering inside AG Studio's agent panel through a server proxy.

**Never used for:** deciding amounts, eligibility, deadlines, who is charged, or any provider operation. Settlement is decided by plain deterministic code (`decideSettlement`). Model output is schema-validated; invented catalogue ids, budgets not in the source text, and out-of-range suggestions are dropped or clamped. Pasted text is wrapped as untrusted data. Dashboard AI can only produce a filter from a whitelist of read-only fields. If no key is set, the app uses a clearly labelled FIXTURE parser and never presents it as model output.

**TODO: record at least one real Claude call (set `OUTINGS_ANTHROPIC_API_KEY`) before claiming it in the video or here. Tests use a mocked SDK.**

## AG Studio usage

- **Two pages in one Studio report:** "Bookings" (Studio value/KPI widgets, bookings-by-status and money-by-stage charts, Booking Readiness widget, AG Grid bookings table) and "Money" (KPI widgets, the Money flow widget, captured-vs-refunded and holds-outstanding charts).
- **Two custom widgets:** "Booking Readiness" shows how close each open outing is to being bookable. "Money flow" (`components/merchant/MoneyFlowWidget.tsx`, arithmetic in `moneyFlow.ts`) shows where each authorized dollar went per outing: kept, refund due, refunded, still on hold. Integer minor units, derived exactly from the booking row; released holds are not drawn because they are not in the row.
- **Cross-filtering:** charts, custom widgets, grid and the KPI value widgets filter each other. The KPIs are real Studio widgets, so they follow the filters.
- **Saved views:** "Closing today with missing required", "Recovery in progress" and "Confirmed this week", applied through Studio's report state (`components/merchant/savedViews.ts`).
- **Read-only natural-language query:** "Show outings closing today with missing required participants" resolves to a validated filter over whitelisted fields, never a write.
- **Optional Studio agent proxy:** `app/api/merchant/ai/studio/route.ts` streams Studio's agent requests to Claude on the server; the browser never sees the key. Available only when `OUTINGS_ANTHROPIC_API_KEY` is set (**TODO: not exercised against real Claude**).
- **Drill-down:** per-participant state and payment operations, with retry limited to existing failed operations.

AG Studio licensing: AG Grid's [6 Nov 2026 post](https://www.ag-grid.com/blog/build-a-payments-dashboard-without-building-a-dashboard/) says hackathon entries need no licence and AG Grid supplies the key for the judging period. **TODO: confirm the key is applied on the hosted build (no watermark).**

## Challenges

- PayPal has no atomic group capture, so we designed for partial failure first: stop, void the rest, refund the captured, and show it honestly.
- Timeouts leave the true state unknown; the engine reads provider state before any retry rather than guessing.
- Race conditions between a late buyer approval and the deadline freeze; late authorizations are recorded and voided, never admitted, and unverifiable ones fail closed.
- Keeping votes private in the API, not just in the UI.
- The first build environment could not reach PayPal, so the adapter was built from PayPal's OpenAPI specifications and mocks, then verified against the real sandbox once the project moved to a local machine (one assumption, the return-URL `token`, was only confirmed there).

## Accomplishments

- A penny-exact split with an immutable stable order, tested across the canonical cases ($20 each, $10 each, $20 with a $0 sponsored guest, 33.34/33.33/33.33).
- A settlement engine tested for concurrency (two workers, exactly-once capture), timeouts, compensation and late holds.
- A consent model where any change to price, date, merchant, sponsorship or deadline invalidates previous consent.
- A merchant dashboard that is a real multi-page AG Studio report with two custom widgets, saved views and cross-filter-aware KPIs, not a table screenshot.
- Three independent audits whose confirmed defects were fixed with regression tests in `tests/audit`, `tests/audit2` and `tests/audit3`.
- Hardening beyond the happy path: rate limiting keyed on `TRUSTED_PROXY_HOPS`, the PayPal payee read from the merchant row, merchant timezone carried in rows, merchant sessions that expire after 12 h, and no organizer cancel after the deadline.
- A compensation path that can be watched in one click and is covered by a browser test (`tests/e2e/compensation.spec.ts`).
- Current verified results: 440 Vitest tests (35 files) pass; 6 Playwright end-to-end tests (karaoke settle, holdout cancel, organizer cancel, demo hub, capture-failure compensation, big-group under-capture) pass; eslint and `tsc` clean; `next build` passes. These run in FIXTURE modes. Separately, against the real PayPal sandbox: the adapter passes `scripts/paypal-smoke.ts`, and one full outing settled through the app with three under-captures that PayPal's records confirm.

## What we learned

Authorization-then-capture is a better primitive for group commitment than prepayment, but only if the product is honest about what a hold is: a real hold exists before settlement, and a refund is not complete until the provider says so. Writing the money rules as pure functions first made the rest of the system far easier to test.

## What's next

Verify webhooks and negative testing against the PayPal sandbox (`docs/research/PAYPAL.md` section 14); real venues onboarded as PayPal merchants instead of demo venues, found near the group; real invite delivery (email or messaging); more currencies; per-attendee pricing modes; a shared (non-in-memory) rate limiter; a PayPal v6 popup flow once the redirect flow is proven.

## Built with

Next.js 16, React 19, TypeScript, Tailwind CSS, Postgres, Drizzle ORM, zod, PayPal REST (Orders v2, Payments v2, webhooks), Anthropic Claude (structured outputs), AG Studio (with two custom widgets), AG Grid, Vitest, Playwright, lucide-react, Fontsource (Fraunces, Inter), Render (deployment blueprint).

## AI tool disclosure

Complete and honest, per hackathon rules.

**Development tools**

- **Claude Code** (Anthropic), in a hosted cloud session. A coordinator agent on **Opus 5.5** planned the work and owned the shared contracts. Subagents did the implementation, research, design and audit: **Opus 5.5** (payments adapter, outing services and HTTP API), **Sonnet 5.5** (design mockups, AG Studio and PayPal research, AI module, consumer UI, merchant dashboard, and this documentation), and **Fable 5.1** (settlement engine, and two independent audits: payments/settlement, and privacy/access/consent).
- **Claude Design** for visual mockups, which the consumer UI was built from. Separate exploratory reference images (`docs/design/reference/D01-D05`) are AI-generated and are reference material, not product screenshots.
- **Claude Code in the Claude desktop app** on the owner's machine (from 7 Nov 2026): an **Opus 5.5** session coordinated the PayPal sandbox verification, error handling, themed starters and vote amounts, and documentation, with a **Fable 5.1** subagent for the security-sensitive judge mode; a separate owner-steered UI/UX session ran a **Fable 5.1** design critique and used **Claude Design** for the redesign mockups before building them.
- **OpenAI Codex**, used to continue the work after the cloud session.
- The project owner directed the work, set the product and financial rules, and is responsible for the submission. No code was copied from third-party repositories; the one reference repository consulted has no licence file and was read only (see [PROVENANCE.md](PROVENANCE.md)).

**Runtime AI in the product**

- **Anthropic Claude** via the app's own key `OUTINGS_ANTHROPIC_API_KEY` (default model `claude-sonnet-5-5`), used for brief extraction (including suggested budget vote amounts), offer ranking, the organizer's plan draft, reveal summaries, and the merchant natural-language filter. Without the key the app runs a deterministic FIXTURE parser, labelled in the UI.
- Real Claude calls verified: **TODO (not verified: the build environment had no key; the owner runs `scripts/ai-smoke.ts`, then record the result here)**.

**Services**

- PayPal sandbox only; no real money moves. PayPal sandbox calls verified (7 Nov 2026, `scripts/paypal-smoke.ts`): authorize, under-capture with `final_capture`, capture replay, void, capture-after-void refusal, capture, refund. Full in-app `PAYPAL_SANDBOX` outing verified the same day: three $50 holds, $33.34/$33.33/$33.33 captured at the deadline, matched against PayPal by `scripts/paypal-verify-outing.ts`.
