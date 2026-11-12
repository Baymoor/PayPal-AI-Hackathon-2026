# Judge guide

Outings lets a group book an outing without anyone fronting the money: private budget vote, PayPal holds of each person's maximum, and a server deadline that books it or releases everything. This guide walks you through it in about 10 minutes, from one browser.

Three things to know first. Payments are **PayPal sandbox** only. Without API keys the app runs in **simulated** modes ("fixture" in the code) that are labelled on every screen ("Simulated · not real PayPal", "Sample AI text (no model call)"); [section 6](#6-real-simulated-and-verified) lists exactly what is real. And on the live demo you [sign in as a judge](#sign-in-as-a-judge) before creating an outing; the `/demo` stories need no sign-in.

## 1. The 10-minute path

| Minutes | Do | You'll see |
|---|---|---|
| 0-3 | [Plan your own outing](#3-plan-your-own-outing-in-one-browser) from a starter, playing every person | Private budget poker, AI venue ranking, consent to exact terms |
| 3-6 | [Watch a deadline settle](#4-watch-a-deadline-settle) | Penny-exact capture, a cancellation, and a failed capture being unwound |
| 6-8 | [Open the venue's dashboard](#5-the-venues-dashboard) | Bookings and money in AG Studio, a safe natural-language filter |
| 8-10 | [Read the hard parts](#7-where-the-hard-parts-are) | The code and tests behind each money rule |

Optional: `/how-it-works` explains the flow and has a split calculator running the server's own [money functions](../lib/domain/money.ts).

![How it works](screenshots/how-it-works.png)

## 2. Run it

Follow [Run it in the README](../README.md#run-it-about-5-minutes) (Node 22.12+, Postgres 16, about 5 minutes). Then:

- Keep `DEMO_FIXTURES_ENABLED=true` in `.env.local`. It turns on the fixture modes, the demo data and judge mode.
- `SESSION_SECRET` and `CRON_SECRET` may stay empty locally. Without `CRON_SECRET` the deadline tick is open, but only in demo mode outside production.
- On another port, set `APP_BASE_URL` to match: approval and invitation links are built from it.
- `npm run demo:reset` wipes and re-seeds everything; `npm run db:seed` replaces only the demo outings.
- The judge sign-in is off unless `JUDGE_PASSWORD` is set, so locally you can skip it.

**Real PayPal sandbox (optional).** Create a sandbox REST app and a Personal buyer account in the PayPal Developer Dashboard, set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, and approve payments as the **Personal** account (PayPal refuses a business paying itself; a private window helps). `npx tsx scripts/paypal-smoke.ts` proves the adapter and writes redacted [evidence](evidence/README.md).

**Real Claude (optional).** Set `OUTINGS_ANTHROPIC_API_KEY` (default model `claude-sonnet-5-5`, override with `OUTINGS_AI_MODEL`). `npx tsx scripts/ai-smoke.ts` checks every AI call.

## 3. Plan your own outing in one browser

### Sign in as a judge

On the live demo, open `/judge/login` and sign in with username `judge` and the password given to judges with the submission. `/new` sends you there when you are not signed in, and brings you back afterwards. Your outings then use real Claude and the PayPal sandbox. Without a sign-in you can still play every `/demo` story, open invitation links and use the venue dashboard's demo sign-in.

### Plan it

Judge mode (demo mode only, and separate from the sign-in) lets you play every person without invitation links or private windows.

1. **Brief.** Open `/new`, enter a name and click a starter: *Karaoke for Maya's birthday*, *Movie night*, *Wine tasting with the girlies*, *Gym session at the new gym with the boys* or *Padel doubles*. Each matches a fictional venue with one price for the group. The right panel shows what the AI understood.
   ![Brief](screenshots/brief.png)
2. **Invite.** Start budget poker, then tap names under **Demo friends** (or type them). Invitation links are still created and still work.
3. **Vote.** Each person says what they would personally pay, and the amounts fit the outing: padel offers $8 to $30 each, wine tasting $25 to $100 each. Vote, then use the **Acting as** bar: press **Switch** next to the next person and follow its **Next:** line. The bar shows who has voted, never the amount.
   ![Budget poker](screenshots/budget-poker.png)
4. **Reveal.** Back as the organizer, reveal once 3 in 4 people have voted (never fewer than 3; the button says how many are needed). You see only how many votes each amount got, the range and the median; no names. Agree the suggested budget, pick another, or run another round.
   ![Reveal](screenshots/reveal.png)
5. **Pick and open.** The AI ranks the venues against the brief and the budget (with sample AI text, the starter's own venue comes first). Optionally cover a guest of honour, then open commitments with a deadline 1 minute to 48 hours away.
   ![Sponsor and open](screenshots/sponsor.png)
6. **Commit.** Switch to each payer, review the exact terms ("Authorize up to $20. Your final share may be lower.") and approve. Without PayPal keys this is the labelled simulated approval page; with keys it is PayPal's sandbox checkout. Consent is bound to a hash of the terms, so any change to price, date or deadline requires consent again.
   ![Invitation](screenshots/invitation.png) ![Waiting](screenshots/waiting.png)
7. **Deadline.** After it passes, `npm run worker` (or **Run the deadline now** on `/demo`) settles the outing: confirmed with each exact share captured, or cancelled with every hold released.
   ![Confirmed](screenshots/confirmed.png) ![Cancelled](screenshots/cancelled.png)

With real PayPal, don't switch people while PayPal's page is open: the return only completes for the person who started the payment.

## 4. Watch a deadline settle

On `/demo`, **Watch a deadline settle** creates a fresh karaoke outing ($100 room, Maya covered, 5 payers at $20) whose deadline is 1 to 5 minutes away. Pick a story, press **Start**, and use the **Open as …** and **Run the deadline now** buttons.

| Story | Do | Result |
|---|---|---|
| Last payer commits in time | Open as Noor, authorize $20 before the countdown ends, then run the deadline | Confirmed: five payers charged $20, Maya $0 |
| A required guest holds out | Do nothing, then run the deadline | Cancelled: no payment collected, all holds released |
| A payment fails at the deadline | Run the deadline, then again a few seconds later | Never confirmed: Jules's payment is declined, the other holds released and the three collected shares refunded; one refund needs a second try, and it is read back, not sent twice |
| Ten friends share the room | Open as Kai, authorize $20 (estimate $10), then run the deadline | Confirmed: each of ten payers charged exactly $10 from a $20 hold |

The stories need no sign-in. They always use the payment simulator and sample AI text, even on the live demo where PayPal sandbox and Claude keys are set, so nobody spends real API calls on them. The services and the settlement engine are the real ones; only the payment provider is the simulator, with failures injected on purpose. **Run the deadline now** runs the same worker as the scheduler and can't settle early: the deadline is checked against the database clock.

**Reset demo data** re-seeds the standard demo outings but leaves any story started recently, so you never cut short another judge's run. Older runs are cleaned up.

## 5. The venue's dashboard

1. Open `/merchant/login`, choose a venue in the demo login (The Sound Room holds the seeded outings and scenarios) and sign in.
2. **Bookings** and **Money** pages in AG Studio: KPIs, bookings by status, the custom *Booking Readiness* and *Money flow* widgets, and an AG Grid table. Clicking a chart cross-filters the page. Holds are never counted as revenue.
   ![Merchant dashboard](screenshots/merchant-dashboard.png) ![Merchant money](screenshots/merchant-money.png)
3. Ask: *"Show outings closing today with missing required participants."* The AI returns a validated, read-only filter; it cannot move money. Signed in as a judge, Claude reads the question and the AG Studio assistant answers; without a sign-in the filter uses the sample parser and the assistant asks you to sign in.
4. Click an outing name for the drill-down: each person's status, money authorized vs allocated vs captured vs refunded, the payment operations, and a retry for failed ones.
   ![Merchant drill-down](screenshots/merchant-drilldown.png)

## 6. Real, simulated, and verified

| Piece | Without keys | With keys | Verified |
|---|---|---|---|
| Payments | Simulator, labelled "Simulated · not real PayPal" | PayPal sandbox, Orders v2 | **Yes, 7 Nov 2026:** authorize, $10-of-$20 final capture, idempotent replay, void, refund, and one full outing settled through the app ([evidence](evidence/README.md)) |
| AI | Deterministic parser, labelled "Sample AI text (no model call)" | Claude, structured outputs, on outings you create (demo outings stay on the sample parser) | **Yes, 11 Nov 2026**, on the hosted demo: a full `scripts/ai-smoke.ts` run passed 12 of 13 checks, and the one that failed (venue ranking) was fixed and then passed 3 of 3 reruns. The automated tests use a mocked SDK |
| Deadline, splitting, consent, access | Real code | Real code | 584 automated tests and 9 browser tests ([testing](TESTING.md)) |
| Demo outings and stories on `/demo` | Simulated payments and sample AI, always | Simulated payments and sample AI, always | Real services, simulated provider |

Not verified: PayPal webhook signatures against real deliveries (webhooks are not configured on the live server, so `/api/health` shows `"webhookVerification":false`), and PayPal negative testing. The hosted demo is live at https://outings.baymoor.dev, and its worker settles outings at the deadline with every browser closed (checked on 10 and 11 Nov 2026). `GET /api/health` shows the active modes without secrets. Limits and threat model: [security and limitations](SECURITY_AND_LIMITATIONS.md).

## 7. Where the hard parts are

| Rule | Code | Proof |
|---|---|---|
| Penny-exact split: the first `total % N` payers get one extra cent | [money.ts](../lib/domain/money.ts) `equalSplit` | [money.test.ts](../tests/domain/money.test.ts) |
| Settle or cancel, failing closed on anything unverifiable | [policy.ts](../lib/domain/policy.ts) `decideSettlement` | [policy.test.ts](../tests/domain/policy.test.ts) |
| Consent bound to the exact terms | [policy.ts](../lib/domain/policy.ts) `hashTerms` | [outings.test.ts](../tests/services/outings.test.ts) |
| Deadline freeze and snapshot | [deadline.ts](../lib/settlement/deadline.ts) | [deadline.test.ts](../tests/settlement/deadline.test.ts) |
| Sequential capture, then void the rest and refund on failure | [operations.ts](../lib/settlement/operations.ts) | [operations.test.ts](../tests/settlement/operations.test.ts), [compensation.spec.ts](../tests/e2e/compensation.spec.ts) |
| Unknown outcomes reconciled before any retry | [reconcile.ts](../lib/settlement/reconcile.ts), [paypal.ts](../lib/payments/paypal.ts) | [operations.test.ts](../tests/settlement/operations.test.ts) |
| Private budget votes | [views.ts](../lib/services/views.ts) | [access.test.ts](../tests/access/access.test.ts) |
| AI suggests, rules decide | [validate.ts](../lib/ai/validate.ts), [budget-options.ts](../lib/domain/budget-options.ts) | [ai.test.ts](../tests/ai/ai.test.ts), [budget-options.test.ts](../tests/domain/budget-options.test.ts) |
| Judge mode can't cross outings or hijack a payment | [judge-persona.ts](../lib/demo/judge-persona.ts) | [judge-persona.test.ts](../tests/services/judge-persona.test.ts) |
| Demo outings never call Claude, and never claim to | `aiModeForOuting` in [lib/ai/index.ts](../lib/ai/index.ts) | [ai-mode-per-outing.test.ts](../tests/services/ai-mode-per-outing.test.ts) |

Diagrams and invariants: [architecture](ARCHITECTURE.md).

## 8. Run the tests

```bash
npm run typecheck
npm test
```

`npm test` needs Postgres at `TEST_DATABASE_URL` (default database `outings_test`, read from the shell). Browser tests run the production build on port 3400 and wipe their database:

```bash
npx playwright install chromium
E2E_DATABASE_URL=postgres://outings:outings@localhost:5432/outings_e2e npm run test:e2e
```

CI runs migrate, typecheck, lint and tests on Postgres 16 ([ci.yml](../.github/workflows/ci.yml)). More: [testing](TESTING.md).
