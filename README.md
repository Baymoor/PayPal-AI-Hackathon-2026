# Outings

> **Plan together. Commit individually. Pay only when everyone is in.**

**A group outing without anyone fronting the money.** Friends vote privately on a budget, each person authorizes only their maximum share with PayPal, and at the deadline the server either books it and charges each exact share, or releases every hold.

Built for the **PayPal AI Hackathon 2026**. PayPal **sandbox** only: no real money moves.

![Outings landing page](docs/screenshots/landing.png)

**Judges:** the [judge guide](docs/JUDGE_GUIDE.md) gets you through the whole product in about 10 minutes.

## Why

| Today | With Outings |
|---|---|
| One friend pays the venue, then chases everyone for weeks. | Nobody fronts anything. Each person's money goes to the venue through PayPal. |
| Nobody wants to be the one who says "that's too expensive". | **Budget poker:** everyone privately says what they would personally pay, and the reveal shows only how many chose each amount. |
| Half the group commits, the booking falls through, refunds get messy. | Nobody is charged unless every required person commits by the deadline. |

## How it works

```mermaid
flowchart LR
  A["Brief<br/>Claude reads the plan"] --> B["Budget poker<br/>private votes"]
  B --> C["Pick a venue<br/>Claude ranks, organizer decides"]
  C --> D["Commit<br/>each payer authorizes their maximum"]
  D --> E{"Deadline<br/>server job"}
  E -->|"every required person committed"| F["Capture each exact share<br/>release the rest of each hold"]
  E -->|"someone required is missing"| G["Void every hold<br/>nobody is charged"]
```

1. **Brief.** The organizer types the plan in their own words, or picks one of five starters. Claude extracts the activity, date, group size and budget.
2. **Budget poker.** Everyone privately says what they would personally pay. The vote amounts fit the outing (a $60 padel court for four gets $8 to $30 each). The app then compares that with each venue: a fixed total divided by the people paying, so covering a guest raises everyone else's share. The API never returns anyone else's vote, and the reveal needs at least 3 votes.
3. **Pick a venue.** Claude ranks the venues' offerings against the brief and the agreed budget. The organizer can cover a guest of honour.
4. **Commit.** Each payer reviews the exact terms and authorizes their maximum through PayPal: a $100 room split by 5 payers is a $20 hold. More payers lower the estimate; nothing is charged yet.
5. **Deadline.** A durable server job, not a browser timer and not the AI, freezes the roster and decides. It captures penny-exact shares with `final_capture`, or voids every hold. If a capture fails midway it releases the rest and refunds what was taken.

Venues see every booking and every dollar in an [AG Studio](docs/research/AG_STUDIO.md) dashboard.

| | | |
|---|---|---|
| ![Brief](docs/screenshots/brief.png) | ![Budget poker](docs/screenshots/budget-poker.png) | ![Invitation](docs/screenshots/invitation.png) |
| ![Waiting](docs/screenshots/waiting.png) | ![Confirmed](docs/screenshots/confirmed.png) | ![Merchant dashboard](docs/screenshots/merchant-dashboard.png) |

## Where AI helps, and where it stops

Claude reads the brief, suggests budget vote amounts, ranks venues, summarizes the vote, drafts the organizer's plan and turns a venue's question into a dashboard filter. **It never decides money.** Every output is schema-validated and [re-checked](lib/ai/validate.ts) against real data before it is shown, and every payment decision is made by [deterministic rules](lib/domain/policy.ts). Details: [architecture](docs/ARCHITECTURE.md).

## What is real

| Piece | Status |
|---|---|
| PayPal Orders v2 (authorize, under-capture, void, refund) | **Verified in the PayPal sandbox**, including one full outing settled through the app ([evidence](docs/evidence/README.md)) |
| Deadline engine, splitting, consent, access control | Real code in every mode; 440 automated tests, most against a real Postgres, plus 6 browser tests ([testing](docs/TESTING.md)) |
| Claude | Real API when `OUTINGS_ANTHROPIC_API_KEY` is set; otherwise a deterministic parser labelled **Sample AI text (no model call)**. Real calls not yet verified. |
| Payments without PayPal keys | A simulator labelled **Simulated · not real PayPal** on every screen |
| Venues | Five fictional Copenhagen venues with a demo catalogue. A confirmed outing means the group's money was collected for the venue, not that a real venue reserved anything. |

Limits and the threat model: [security and limitations](docs/SECURITY_AND_LIMITATIONS.md).

## Run it (about 5 minutes)

Needs Node 22.12 or newer and Postgres 16.

```bash
npm ci
cp .env.example .env.local
# as a Postgres superuser:
#   CREATE ROLE outings LOGIN PASSWORD 'outings';
#   CREATE DATABASE outings OWNER outings;
npm run db:migrate && npm run db:seed
npm run dev        # http://localhost:3000
npm run worker     # second terminal: the deadline worker
```

Then open `/new`, pick a starter, and use the **Acting as** bar to play every person from one browser. The [judge guide](docs/JUDGE_GUIDE.md) has the full path, PayPal sandbox setup and the test commands.

## Built with

Next.js 16 · TypeScript (strict) · Postgres 16 with Drizzle · PayPal Orders v2 and Payments v2 · Claude (structured outputs) · AG Studio and AG Grid · Vitest and Playwright

## Docs

- **For judges:** [judge guide](docs/JUDGE_GUIDE.md) · [architecture](docs/ARCHITECTURE.md) · [security and limitations](docs/SECURITY_AND_LIMITATIONS.md) · [testing](docs/TESTING.md) · [PayPal evidence](docs/evidence/README.md)
- **For builders:** [product spec](docs/PRODUCT_SPEC.md) · [module contracts and API](docs/CONTRACTS.md) · [design system](docs/design/DESIGN_SYSTEM.md) · [PayPal research](docs/research/PAYPAL.md) · [deployment](docs/DEPLOYMENT.md) · [status](docs/HANDOFF_TO_CODEX.md) · [provenance](docs/PROVENANCE.md)

## License

MIT, see [LICENSE](LICENSE). AG Studio is commercial software used under its evaluation trial; AG Grid Community is MIT. Third-party notices: [provenance](docs/PROVENANCE.md).
