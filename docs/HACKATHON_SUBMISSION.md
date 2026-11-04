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
| Run it yourself | [README](../README.md), [JUDGE_GUIDE.md](JUDGE_GUIDE.md) |

## Inspiration

Booking something for a group (a karaoke room, a game night, a birthday dinner) usually means one friend pays up front and spends weeks chasing everyone else. People hesitate to commit because they do not know their share until the headcount is final, and the organizer carries the financial risk. We wanted payment itself to be the commitment mechanism: each person says "I am in for up to this much", and money moves only if the whole agreed group is in.

## What it does

1. **Brief.** The organizer describes the plan in plain language. Claude extracts structured preferences with schema-validated output.
2. **Budget poker.** Everyone privately suggests a total budget. Votes stay private until the organizer reveals an aggregate (at least 3 votes, no names), enforced by the API. A vote is never a payment.
3. **Proposal.** The organizer picks a quote from a small merchant-owned catalogue (for example, a private karaoke room, $100 fixed total, up to 10 people) and can cover one guest of honour.
4. **Commit.** Each payer reviews the exact terms and authorizes their *maximum* share through PayPal: $100 across 5 payers is $20. More payers lower the estimated share ($10 with 10 payers) but not the hold. A sponsored guest accepts attendance and pays $0.
5. **Deadline.** A durable server job freezes the roster. If every required person committed, it captures each exact share (penny-exact, never above the cap). Otherwise it cancels and voids every hold. If a capture fails mid-way it stops, voids the rest, refunds completed captures, and shows the recovery.
6. **Merchant view.** The experience merchant sees bookings, readiness and money by stage in an AG Studio dashboard, and can ask natural-language, read-only questions.

Payments go directly to the experience merchant; the organizer never receives the group's money.

## How we built it

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript, Tailwind |
| Data | Postgres 16 with Drizzle ORM; durable job queue and payment-operation outbox |
| Payments | PayPal REST sandbox: Orders v2 (intent AUTHORIZE) and Payments v2 (authorize, capture, void, refund), server-only OAuth, `PayPal-Request-Id` on every mutation, webhook verification |
| AI | Anthropic Claude with structured outputs, validated by zod; labelled deterministic fixture when no key is set |
| Merchant UI | AG Studio with AG Grid (Community for the drill-down grid) |
| Worker | `npm run worker` loop, or an authenticated `POST /api/cron/tick` from any scheduler |
| Tests | Vitest unit and integration suites against a real Postgres database (see [TESTING.md](TESTING.md)) |

The money logic lives in a small pure domain layer (integer minor units, equal split, cap, terms hash, settle-or-cancel decision) so it can be tested exhaustively. Provider calls never run inside a database transaction, and every provider mutation has a durable outbox row with a stable request id.

## How PayPal is central

PayPal authorization is the product, not a checkout button bolted on at the end.

- **Authorize, then capture later.** Authorizations let a person commit without being charged until the group is confirmed. That is exactly the "I am in, if you are in" semantics a group booking needs.
- **Cap versus share.** The hold is the maximum share; the capture is the real allocated share. Capturing less than the authorized amount with `final_capture` is how the design lets the share fall when more friends join. **TODO: confirm under-capture ($20 authorization, $10 capture) and remainder release in the PayPal sandbox by running `scripts/paypal-smoke.ts`; until then this is implemented and unit-tested against mocks but not verified against PayPal.**
- **Void and refund.** Cancellation voids holds; partial capture failure refunds completed captures.
- **Idempotency and unknown outcomes.** Timeouts are treated as UNKNOWN and reconciled by reading PayPal state before any retry, with the same `PayPal-Request-Id`.
- **Webhooks** are signature-verified, deduplicated by event id, and only trigger a re-read of provider state.

Status today: the adapter is implemented from the official OpenAPI specs and tested with a mocked `fetch`. **TODO: PayPal sandbox proof (evidence file in `docs/evidence/`).**

## How AI is used, and not used

**Used for:** extracting structured preferences from the brief; ranking catalogue offers against budget and capacity; summarizing the aggregate budget reveal; explaining deterministic outcomes; turning a merchant question into a validated read-only dashboard filter; and (optionally) answering inside AG Studio's agent panel through a server proxy.

**Never used for:** deciding amounts, eligibility, deadlines, who is charged, or any provider operation. Settlement is decided by plain deterministic code (`decideSettlement`). Model output is schema-validated; invented catalogue ids, budgets not in the source text, and out-of-range suggestions are dropped or clamped. Pasted text is wrapped as untrusted data. Dashboard AI can only produce a filter from a whitelist of read-only fields. If no key is set, the app uses a clearly labelled FIXTURE parser and never presents it as model output.

**TODO: record at least one real Claude call (set `OUTINGS_ANTHROPIC_API_KEY`) before claiming it in the video or here. Tests use a mocked SDK.**

## AG Studio usage

- **Custom widget:** "Booking Readiness", a purpose-built widget showing how close each open outing is to being bookable.
- **Cross-filtering:** the status chart, money-by-stage chart, readiness widget and AG Grid bookings table filter each other.
- **Read-only natural-language query:** "Show outings closing today with missing required participants" resolves to a validated filter over whitelisted fields, never a write.
- **Optional Studio agent proxy:** an adapter route streams Studio's agent requests to Claude on the server; the browser never sees the key. Available only when `OUTINGS_ANTHROPIC_API_KEY` is set.
- **Drill-down:** per-participant state and payment operations, with retry limited to existing failed operations.

AG Studio runs under its evaluation trial. **TODO: add the trial licence key to the hosted deployment and confirm its expiry covers 15 Dec 2026.**

## Challenges

- PayPal has no atomic group capture, so we designed for partial failure first: stop, void the rest, refund the captured, and show it honestly.
- Timeouts leave the true state unknown; the engine reads provider state before any retry rather than guessing.
- Race conditions between a late buyer approval and the deadline freeze; late authorizations are recorded and voided, never admitted, and unverifiable ones fail closed.
- Keeping votes private in the API, not just in the UI.
- Our build environment could not reach PayPal, so provider behaviour was built from specifications and mocks and is listed as unverified until a sandbox run.

## Accomplishments

- A penny-exact split with an immutable stable order, tested across the canonical cases ($20 each, $10 each, $20 with a $0 sponsored guest, 33.34/33.33/33.33).
- A settlement engine tested for concurrency (two workers, exactly-once capture), timeouts, compensation and late holds.
- A consent model where any change to price, date, merchant, sponsorship or deadline invalidates previous consent.
- A merchant dashboard that is a real AG Studio report with a custom widget, not a table screenshot.

## What we learned

Authorization-then-capture is a better primitive for group commitment than prepayment, but only if the product is honest about what a hold is: a real hold exists before settlement, and a refund is not complete until the provider says so. Writing the money rules as pure functions first made the rest of the system far easier to test.

## What's next

Verify the PayPal sandbox behaviours listed in `docs/research/PAYPAL.md` section 14; real invite delivery (email or messaging); multiple merchants and currencies; per-attendee pricing modes; a persistent rate limiter; a PayPal v6 popup flow once the redirect flow is proven.

## Built with

Next.js 16, React 19, TypeScript, Tailwind CSS, Postgres, Drizzle ORM, zod, PayPal REST (Orders v2, Payments v2, webhooks), Anthropic Claude (structured outputs), AG Studio, AG Grid, Vitest, lucide-react, Fontsource (Fraunces, Inter), Render (deployment blueprint).

## AI tool disclosure

Complete and honest, per hackathon rules.

**Development tools**

- **Claude Code** (Anthropic), in a hosted cloud session. A coordinator agent on **Opus 5.5** planned the work and owned the shared contracts. Subagents did the implementation, research, design and audit: **Opus 5.5** (payments adapter, outing services and HTTP API), **Sonnet 5.5** (design mockups, AG Studio and PayPal research, AI module, consumer UI, merchant dashboard, and this documentation), and **Fable 5.1** (settlement engine, and an independent audit of payments and settlement, which was in progress at the time of writing).
- **Claude Design** for visual mockups, which the consumer UI was built from. Separate exploratory reference images (`docs/design/reference/D01-D05`) are AI-generated and are reference material, not product screenshots.
- **OpenAI Codex**, used to continue the work after the cloud session.
- The project owner directed the work, set the product and financial rules, and is responsible for the submission. No code was copied from third-party repositories; the one reference repository consulted has no licence file and was read only (see [PROVENANCE.md](PROVENANCE.md)).

**Runtime AI in the product**

- **Anthropic Claude** via the app's own key `OUTINGS_ANTHROPIC_API_KEY` (default model `claude-sonnet-5-5`), used for brief extraction, offer ranking, reveal summaries, and the merchant natural-language filter. Without the key the app runs a deterministic FIXTURE parser, labelled in the UI.
- Real Claude calls verified: **TODO (not yet verified when this draft was written)**.

**Services**

- PayPal sandbox only; no real money moves. PayPal sandbox calls verified: **TODO**.
