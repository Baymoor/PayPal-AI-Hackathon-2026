# Devpost: ready-to-paste fields

Copy each block into the matching Devpost field. Lines marked **[A]** apply only if real Claude has been verified (`npx tsx scripts/ai-smoke.ts` was run with the key and its evidence file is committed under `docs/evidence/`). Lines marked **[B]** apply if it has not. Delete the one that does not apply, and delete every bracket before pasting. The long "About the project" text stays in [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md); this file covers the short fields, the gallery, the limitations paragraph and the YouTube upload.

## Project name (54 characters)

```
Outings — group bookings where nobody fronts the money
```

Shorter alternative if the field is tight: `Outings`

## Elevator pitch / tagline (191 of 200 characters)

```
Plan together. Commit individually. Pay only when everyone is in. Friends each authorize a maximum share with PayPal; at the deadline a server captures the exact share or releases every hold.
```

## Built with (tags)

Type them one by one so Devpost matches its own tag names:

```
next.js, react, typescript, tailwindcss, node.js, postgresql, drizzle-orm, zod, paypal, paypal-rest-api, anthropic, claude, ag-grid, ag-studio, vitest, playwright
```

Once the hosted demo is live, add the platform it runs on. The deployment session chose a DigitalOcean VPS with Docker Compose and Caddy, so that's `digitalocean, docker, caddy`.

## Links ("Try it out")

| Label | URL |
|---|---|
| Source code (MIT) | https://github.com/Baymoor/PayPal-AI-Hackathon-2026 |
| Live demo | https://outings.baymoor.dev (check it runs the final version first) |
| Judge guide | https://github.com/Baymoor/PayPal-AI-Hackathon-2026/blob/main/docs/JUDGE_GUIDE.md |
| PayPal sandbox evidence | https://github.com/Baymoor/PayPal-AI-Hackathon-2026/blob/main/docs/evidence/README.md |

Check that each URL opens in a private window (signed out) before submitting.

## Image gallery, in this order

The pictures are in `docs/screenshots/`, taken from the production build by the browser tests. Devpost recommends 3:2 for gallery images; crop if a thumbnail cuts badly. For the PayPal sandbox proof, screenshot the result table in [evidence/README.md](evidence/README.md) or your own PayPal sandbox dashboard.

| # | File | Caption to paste |
|---|---|---|
| 1 | `landing.png` (also the thumbnail) | Plan together. Commit individually. Pay only when everyone is in. |
| 2 | `budget-poker.png` | Budget poker: everyone privately answers "What would you personally pay?" The API never returns anyone else's vote. |
| 3 | `reveal.png` | The reveal shows how many chose each amount, never who. |
| 4 | `venue-cards.png` | The app turns the agreed $20 into each venue's share: a $100 room is $20 each with 5 paying. |
| 5 | `waiting.png` | Each payer authorizes a maximum. "$20 authorized · estimated final share $20 · not charged yet." (labelled payment simulator) |
| 6 | `confirmed.png` | At the deadline the server charges each exact share, or releases every hold. |
| 7 | `merchant-dashboard.png` | AG Studio, Bookings page: custom Booking Readiness widget, cross-filtering charts, KPIs and grid. |
| 8 | `merchant-money.png` | AG Studio, Money page: where each authorized dollar went. Holds are never revenue. |

## Limitations (paste as its own section, "Limitations and what is real")

> Outings is a sandbox prototype, and we want to be exact about what is real.
>
> **Real PayPal sandbox.** The payment adapter is verified against the PayPal REST sandbox: authorize, a $10 final capture of a $20 hold (PayPal then released the rest), idempotent capture replay, void, and refund. One full outing also ran through the app itself: three payers each authorized $50, and at the deadline the server captured $33.34, $33.33 and $33.33, exactly $100. All three holds were approved from a single sandbox buyer account. Reading every authorization back from PayPal matched the app's records.
>
> **Simulated, and labelled on screen.** The one-click scenarios on `/demo`, including the failed capture and the refund recovery in the video, use our payment simulator ("Simulated · not real PayPal"), not PayPal. PayPal webhook delivery and PayPal's negative-testing headers are implemented but not yet verified against PayPal.
>
> **AI.** [A] Claude extracts the plan from the brief, ranks catalogue offers, summarizes the budget reveal and answers read-only questions in the merchant dashboard, including AG Studio's agent panel. [B] The Claude integration is implemented and tested against a mocked SDK, but not yet verified against the Anthropic API, so the demo and video use a clearly labelled stand-in ("Sample AI text (no model call)") instead. In every mode, AI never decides who pays, how much or when; plain server code does.
>
> **Not a real booking.** The venues and their catalogue are fictional. A confirmed outing means the group's money was settled against a demo catalogue offer, not that a real venue was reserved.
>
> **Scope.** One currency (USD), one pricing model (a fixed total split equally), a small fictional catalogue, in-memory rate limiting. No escrow, no live charges, not production financial infrastructure.

## YouTube upload

**Title (63 characters):**

```
Outings — group bookings where nobody fronts the money (2:4X demo)
```

Replace `2:4X` with the real length, or drop the brackets.

**Description:**

```
Outings is an independent project for the PayPal AI Hackathon 2026. Friends plan an outing together, say privately what they'd each pay, and each authorizes a maximum share with PayPal. At the deadline a server job captures each exact share, or releases every hold if someone is missing.

What is real and what is simulated:
- The PayPal sandbox result in the video (three $50 holds, $33.34 + $33.33 + $33.33 captured) is from a real PayPal REST sandbox run on 7 Nov 2026, approved from one sandbox buyer account. No real money moves anywhere.
- The other payments on screen use a labelled payment simulator ("Simulated · not real PayPal").
- [A] The plan extraction and the AG Studio agent use Claude (Anthropic API).
- [B] The AI on screen is a labelled stand-in ("Sample AI text (no model call)"); the Claude integration is implemented but was not verified when this was recorded.
- The venues are fictional; no real venue is booked.

Source (MIT): https://github.com/Baymoor/PayPal-AI-Hackathon-2026
Live demo: https://outings.baymoor.dev
Evidence: https://github.com/Baymoor/PayPal-AI-Hackathon-2026/blob/main/docs/evidence/README.md

Not affiliated with PayPal, AG Grid or Anthropic.
```

**Settings:** Visibility **Public** (not Unlisted), "No, it's not made for kids", no music. After publishing, open the link in a private window and check that the length shows under 3:00.
