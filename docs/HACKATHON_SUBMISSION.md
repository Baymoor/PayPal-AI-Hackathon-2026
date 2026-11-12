# Devpost submission notes

The long version of the Devpost "About" text for the PayPal AI Hackathon 2026 (deadline 12 Nov 2026, 21:00 CET), plus the full [AI tool disclosure](#ai-tool-disclosure). In a hurry? The [README](../README.md) is the short version, with pictures.

Where something is not verified, it says so.

## Name and tagline

**Outings** (working name; an independent project that uses the PayPal sandbox, not a PayPal product)

*Turn a group plan into an approved, fairly shared booking. Everyone authorizes their maximum, the server settles at the deadline, and nobody fronts the money.*

## Links

| Item | Value |
|---|---|
| Live demo | https://outings.baymoor.dev, kept up through 21 Dec 2026 |
| Public repository | https://github.com/Baymoor/PayPal-AI-Hackathon-2026 (MIT licence) |
| Demo video (YouTube, under 3 min) | Recorded by the owner. The link goes on the Devpost page, not in this repo |
| Judge sign-in | `/judge/login`, username `judge`. The password comes with the Devpost submission and is never written in this repo |
| Run it yourself | [README](../README.md), [judge guide](JUDGE_GUIDE.md) |

## Inspiration

Booking something for a group (a karaoke room, a game night, a birthday dinner) usually means one friend pays up front and spends weeks chasing everyone else. People hesitate to commit because they don't know their share until the headcount is final, and the organizer carries the risk.

We wanted payment itself to be the commitment: each person says "I'm in for up to this much", and money moves only if the whole agreed group is in.

## What it does

The six steps, with screenshots, are in the [README](../README.md). The details worth spelling out, plus the venue's side:

| Step | The detail |
|---|---|
| **Brief** | Plain language, or one of five starters (karaoke, movie night, wine tasting, gym session, padel). Claude extracts structured preferences with schema-validated output. |
| **Budget poker** | Everyone privately says what they would personally pay, from five per-person amounts sized to the outing. Claude suggests the amounts; the server accepts them only if they are valid and include what the brief's budget means per person, else builds them from the brief or the venue's price per person. A vote is never a payment. |
| **Reveal** | Opens once 75% of the group has voted (rounded up, never below 3 votes). It shows how many chose each amount, never who, and the API enforces it. The median is suggested, and the organizer can ask everyone to vote again. |
| **Proposal** | Claude ranks the catalogue against the brief and the agreed budget. Every venue card shows each person's real share: booking total divided by people paying. The organizer picks a quote, can let Claude draft the rest of the plan for review, and can cover one guest of honour. |
| **Commit** | Each payer reviews the exact terms and authorizes their *maximum* share through PayPal. $100 across 5 payers is a $20 hold. More payers lower the estimated share ($10 with 10 payers) but not the hold. A covered guest accepts and pays $0. |
| **Deadline** | A durable server job freezes the roster. Everyone required committed: it captures each exact share (penny-exact, never above the cap). Otherwise it cancels and voids every hold. A capture fails midway: it stops, voids the rest, refunds completed captures and shows the recovery. |
| **Merchant view** | The venue sees bookings, readiness and money in a two-page AG Studio report, with saved views and read-only questions in plain language. |

Payments go directly to the experience merchant. The organizer never receives the group's money.

The catalogue is 8 offerings at 5 made-up venues in Copenhagen. One of them, a pottery evening priced per attendee, can be ranked but not booked.

**Four things that help evaluators:**

| Extra | What it is |
|---|---|
| Judge sign-in (`/judge/login`) | Needed on the live demo to create your own outing (real Claude, PayPal sandbox) on `/new`, to use the AG Studio assistant, and to get Claude behind the dashboard's filter box. The `/demo` stories, invitation links and the demo venue dashboard stay open to everyone. |
| Judge mode | Demo mode only. One browser plays every person: tap-to-add demo friends, an **Acting as** bar that switches person in one click and shows who still needs to act, and a "Next:" hint. |
| `/how-it-works` | The flow, plus an interactive split calculator that runs the real `lib/domain/money.ts` functions. |
| `/demo` | Four one-click stories (settles on time, one holdout, capture fails, ten-person group). Each opens a fresh demo outing with a deadline a few minutes away, so you can watch a settlement, a cancellation and a mid-settlement capture failure (COMPENSATING, refunds and voids, then CANCELLED with REFUND_PENDING moving to COMPLETE). |

Demo outings, seeded or started on `/demo`, always use simulated payments ("Simulated · not real PayPal") and sample AI ("Sample AI text (no model call)"), even on the live site. They never touch PayPal or Claude.

## How we built it

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind |
| Data | Postgres 16 with Drizzle ORM; durable job queue and payment-operation outbox |
| Payments | PayPal REST sandbox: Orders v2 (intent AUTHORIZE) and Payments v2 (capture, void, refund), server-only OAuth, `PayPal-Request-Id` on every mutation. Webhook verification is in the code but not configured on the live demo |
| AI | Claude Sonnet 5.5 with structured outputs, validated by zod. A deterministic stand-in labelled "Sample AI text (no model call)" when no key is set and, always, on demo outings |
| Merchant UI | AG Studio with AG Grid (Community for the drill-down grid) |
| Worker | `npm run worker` loop, or an authenticated `POST /api/cron/tick` from any scheduler |
| Hosting | One DigitalOcean droplet, Docker Compose, Caddy ([deployment](DEPLOYMENT.md)) |
| Tests | 584 Vitest tests in 48 files, most against a real Postgres, plus 9 Playwright browser tests ([testing](TESTING.md)) |

The money logic lives in a small pure domain layer (integer minor units, equal split, cap, terms hash, settle-or-cancel decision), so it can be tested exhaustively. Provider calls never run inside a database transaction, and every provider mutation has a durable outbox row with a stable request id. More in the [architecture](ARCHITECTURE.md).

## How PayPal is central

PayPal authorization is the product, not a checkout button bolted on at the end.

- **Authorize, then capture later.** A hold lets a person commit without being charged until the group is confirmed. That is exactly the "I'm in, if you're in" a group booking needs.
- **Cap versus share.** The hold is the maximum share; the capture is the real share. Capturing less than the hold with `final_capture` is how the share can fall when more friends join.
- **Void and refund.** Cancellation voids holds. A partial capture failure refunds the completed captures.
- **Idempotency and unknown outcomes.** A timeout is UNKNOWN. The engine reads PayPal's state before any retry, and retries with the same `PayPal-Request-Id`.
- **Webhooks.** The code verifies the signature, deduplicates by event id and only re-reads PayPal's state. It is not configured on the live demo (`/api/health` shows `webhookVerification:false`) and has never seen a real delivery, so we don't claim it.

**Verified in the PayPal sandbox on 7 Nov 2026** ([evidence](evidence/README.md)):

- **The adapter** (`scripts/paypal-smoke.ts`): authorize, a $10 final capture from a $20 hold (the authorization then reads `CAPTURED` and PayPal releases the other $10 with no extra call), an idempotent capture replay on the same `PayPal-Request-Id`, void (a capture afterwards is refused with `AUTHORIZATION_VOIDED`), and full capture plus refund.
- **One full outing through the app** in `PAYPAL_SANDBOX` mode: three participants each approved a $50 hold through the app's PayPal redirect. At the deadline the server captured $33.34, $33.33 and $33.33 (exactly $100.00) with nobody lifting a finger, and PayPal's own records match the app's for every payer. All three approvals used the one sandbox buyer account, so this proves the app's per-person flow, not three different PayPal buyers.

**Not verified:** webhook signatures against a real delivery, and PayPal negative testing (`PayPal-Mock-Response`).

## How AI is used, and not used

**Used for:** extracting structured preferences from the brief; suggesting five budget vote amounts that fit the outing; ranking catalogue offers against budget and capacity; drafting the organizer's plan for review; summarizing the aggregate budget reveal; explaining deterministic outcomes; turning a merchant question into a validated read-only dashboard filter; and answering inside AG Studio's agent panel through a server proxy.

**Never used for:** deciding amounts, eligibility, deadlines, who is charged, or any provider operation. Settlement is decided by plain deterministic code (`decideSettlement`). Model output is schema-validated; invented catalogue ids, budgets not in the source text and out-of-range suggestions are dropped or clamped. Pasted text is wrapped as untrusted data. Dashboard AI can only produce a filter from a whitelist of read-only fields.

**Sample AI.** When no key is set, and always on demo outings, a deterministic parser answers instead. It is labelled "Sample AI text (no model call)" and never presented as model output.

**Real Claude, verified on 11 Nov 2026** on the live demo: a full `scripts/ai-smoke.ts` run passed 12 of 13 checks. The one that failed (venue ranking) was fixed and then passed 3 of 3 reruns. The run's output files were not committed, so there is nothing to link. The automated tests use a mocked SDK.

## AG Studio usage

- **Two pages in one Studio report.** "Bookings" has Studio value/KPI widgets, bookings-by-status and money-by-stage charts, the Booking Readiness widget and an AG Grid bookings table. "Money" has KPI widgets, the Money flow widget, and captured-vs-refunded and holds-outstanding charts.
- **Two custom widgets.** "Booking Readiness" shows how close each open outing is to being bookable. "Money flow" (`components/merchant/MoneyFlowWidget.tsx`, arithmetic in `moneyFlow.ts`) shows where each authorized dollar went per outing: kept, refund due, refunded, still on hold. Integer minor units, derived exactly from the booking row; released holds are not drawn because they are not in the row.
- **Cross-filtering.** Charts, custom widgets, grid and the KPI value widgets filter each other. The KPIs are real Studio widgets, so they follow the filters.
- **Saved views.** "Closing today with missing required", "Recovery in progress" and "Confirmed this week", applied through Studio's report state (`components/merchant/savedViews.ts`).
- **Read-only questions in plain language.** "Show outings closing today with missing required participants" resolves to a validated filter over whitelisted fields, never a write.
- **Studio agent proxy.** `app/api/merchant/ai/studio/route.ts` streams Studio's agent requests to Claude on the server, so the browser never sees the key. It needs `OUTINGS_ANTHROPIC_API_KEY` and, on the live demo, a judge sign-in. The 11 Nov real-Claude run includes its two checks, and both passed.
- **Drill-down.** Per-participant state and payment operations, with retry limited to existing failed operations.

**Licensing.** The live demo runs AG Studio in trial mode, with no licence key yet. AG Grid's [6 Nov 2026 post](https://www.ag-grid.com/blog/build-a-payments-dashboard-without-building-a-dashboard/) says hackathon entries need no licence and that AG Grid supplies the key for the judging period. AG Grid Community is MIT.

## Challenges

- PayPal has no atomic group capture, so we designed for partial failure first: stop, void the rest, refund the captured, and show it honestly.
- A timeout leaves the true state unknown. The engine reads provider state before any retry rather than guessing.
- A late buyer approval can race the deadline freeze. Late authorizations are recorded and voided, never admitted, and unverifiable ones fail closed.
- Votes had to be private in the API, not just in the UI.
- The first build environment could not reach PayPal. The adapter was built from PayPal's OpenAPI specifications and mocks, then verified against the real sandbox once the project moved to a local machine. One assumption, the return-URL `token`, was only confirmed there.

## Accomplishments

- A penny-exact split with an immutable stable order, tested across the canonical cases ($20 each, $10 each, $20 with a $0 sponsored guest, 33.34/33.33/33.33).
- A settlement engine tested for concurrency (two workers, exactly-once capture), timeouts, compensation and late holds.
- A consent model where any change to price, date, merchant, sponsorship or deadline invalidates previous consent.
- A merchant dashboard that is a real multi-page AG Studio report with two custom widgets, saved views and cross-filter-aware KPIs, not a table screenshot.
- Three independent audits whose confirmed defects were fixed with regression tests in `tests/audit`, `tests/audit2` and `tests/audit3`.
- Hardening beyond the happy path: rate limiting keyed on `TRUSTED_PROXY_HOPS`, the PayPal payee read from the merchant row, merchant timezone carried in rows, merchant sessions that expire after 12 h, and no organizer cancel after the deadline.
- A compensation path you can watch in one click, covered by a browser test (`tests/e2e/compensation.spec.ts`).
- A live demo whose worker settles outings at the deadline with every browser closed.

**Current results:** 584 Vitest tests (48 files) and 9 Playwright browser tests pass; eslint and `tsc` are clean; `next build` passes. These run with simulated payments and sample AI. Separately, the adapter and one full outing passed against the real PayPal sandbox, and real Claude was checked on the live demo, as described above. Details: [testing](TESTING.md).

## What we learned

Authorize-then-capture is a better primitive for group commitment than prepayment, but only if the product is honest about what a hold is: a real hold exists before settlement, and a refund is not complete until the provider says so. Writing the money rules as pure functions first made the rest of the system far easier to test.

## What's next

- Set up webhooks on the live server and run PayPal negative testing ([PayPal research](research/PAYPAL.md), section 14).
- Real venues onboarded as PayPal merchants, found near the group, instead of demo venues.
- Real invite delivery (email or messaging).
- Booking per-attendee offerings, which today can be ranked but not booked.
- More currencies, a shared (not in-memory) rate limiter, and a PayPal v6 popup flow now that the redirect flow is proven.

## Built with

Next.js 16, React 19, TypeScript, Tailwind CSS, Postgres, Drizzle ORM, zod, PayPal REST (Orders v2, Payments v2, webhooks), Anthropic Claude (structured outputs), AG Studio (with two custom widgets), AG Grid, Vitest, Playwright, lucide-react, Fontsource (Fraunces, Inter), DigitalOcean with Docker Compose and Caddy (the live demo), Render (an alternative deployment blueprint).

## AI tool disclosure

Complete and honest, per hackathon rules.

**Development tools**

- **Claude Code** (Anthropic), in a hosted cloud session. A coordinator agent on **Opus 5.5** planned the work and owned the shared contracts. Subagents did the implementation, research, design and audit: **Opus 5.5** (payments adapter, outing services and HTTP API), **Sonnet 5.5** (design mockups, AG Studio and PayPal research, AI module, consumer UI, merchant dashboard, and documentation), and **Fable 5.1** (settlement engine, and two independent audits: payments/settlement, and privacy/access/consent).
- **Claude Design** for visual mockups, which the consumer UI was built from. Separate exploratory reference images (`docs/design/reference/D01-D05`) are AI-generated and are reference material, not product screenshots.
- **Claude Code in the Claude desktop app** on the owner's machine (from 7 Nov 2026): an **Opus 5.5** session coordinated the PayPal sandbox verification, error handling, themed starters and vote amounts, and documentation, with a **Fable 5.1** subagent for the security-sensitive judge mode; a separate owner-steered UI/UX session ran a **Fable 5.1** design critique and used **Claude Design** for the redesign mockups before building them.
- **Fable 5.2** sessions in Claude Code from 10 Nov 2026, named in the commits' co-author trailers: per-person budget poker, the "Simulated" and "Sample" wording, the AI prompt rewrite, the judge sign-in, the landing page and graphics pass, and the README and docs rewrite, including a docs pass on 12 Nov.
- No other AI coding tool was used. In particular, OpenAI Codex was never used.
- The project owner directed the work, set the product and financial rules, and is responsible for the submission. No code was copied from third-party repositories; the one reference repository consulted has no licence file and was read only (see [PROVENANCE.md](PROVENANCE.md)).

**Runtime AI in the product**

- **Anthropic Claude** via the app's own key `OUTINGS_ANTHROPIC_API_KEY` (default model `claude-sonnet-5-5`), used for brief extraction (including suggested budget vote amounts), offer ranking, the organizer's plan draft, reveal summaries, the merchant natural-language filter and the AG Studio assistant. Without the key, and always on demo outings, the app runs a deterministic parser labelled "Sample AI text (no model call)".
- Real Claude calls verified: **Yes, 11 Nov 2026**, on the live demo: a full `scripts/ai-smoke.ts` run passed 12 of 13 checks, and the one that failed (venue ranking) was fixed and then passed 3 of 3 reruns. The owner ran it inside the hosted web container with the app's own key.

**Services**

- PayPal sandbox only; no real money moves. PayPal sandbox calls verified (7 Nov 2026, `scripts/paypal-smoke.ts`): authorize, under-capture with `final_capture`, capture replay, void, capture-after-void refusal, capture, refund. Full in-app `PAYPAL_SANDBOX` outing verified the same day: three $50 holds, $33.34/$33.33/$33.33 captured at the deadline, matched against PayPal by `scripts/paypal-verify-outing.ts`.
