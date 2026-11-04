# Demo video script (target 2:45, hard limit 2:50)

Public YouTube video, under 3 minutes, showing real functionality. No music or use music you own/licensed only. English narration. Record at 1080p, browser zoom 110-125%.

Prepare before recording: fresh `npm run demo:reset`, `npm run dev` and `npm run worker` running, a second outing created at `/new` with a "Commit by" deadline about 90 seconds after you expect to reach scene 7, and the Fixture badge visible. If you record the PayPal segments with sandbox credentials, see the checklist at the bottom first.

| Time | Screen | Action | Narration |
|---|---|---|---|
| 0:00-0:10 | Title card, then the landing page `/` | Cut quickly to the brief screen | "Splitting a group booking usually means one friend fronts the money and chases everyone for weeks. Outings fixes that with PayPal: nobody is charged unless the whole group commits." |
| 0:10-0:25 | `/new` brief screen | Type the brief: "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share." Submit. | "The organizer writes the plan in plain words. Claude turns it into structured preferences. It extracts, it never decides money." (Overlay: **AI mode: FIXTURE** or **Claude** exactly as the badge says.) |
| 0:25-0:50 | Budget poker (`/demo`, game-night personas) | Vote as one persona, switch persona, show the second persona cannot see the first vote, three vote, organizer reveals the distribution | "Everyone suggests a total budget in private. The API never returns other people's votes, so it is not just hidden by CSS. The reveal shows only the aggregate, and a vote is never a payment." |
| 0:50-1:10 | Proposal and sponsor screen | Pick The Sound Room private karaoke room ($100 fixed total, up to 10). Mark Maya as sponsored. Show "$20 each, Maya $0". | "The organizer picks a real catalogue offer from the merchant. Maya's friends cover her: $100 split between five payers is $20 each, and the guest of honour pays nothing." |
| 1:10-1:35 | Invitation as a payer, then the payment step | Show the terms, the line "Authorize up to $20. Your final share may be lower", click commit, show the approval (**on-screen label: Fixture, not real PayPal**, or the real PayPal sandbox page if recorded) | "Each person authorizes their maximum, $20, through PayPal. Nothing is charged yet. The consent is tied to a hash of the exact terms: change the price or the date and everyone must agree again." |
| 1:35-1:50 | Waiting screen | Show "$20 authorized, estimated final share $10". Briefly show a 10-payer example from the seed or the estimate text. | "If ten friends join, the estimated share falls to $10, but the hold stays $20. We never charge above the cap, and an estimate is not a release." |
| 1:50-2:10 | Terminal with `npm run worker` next to the closed browser, then the outing page after the deadline | Close the browser window. Show worker log at the deadline. Reopen: **Confirmed**. | "At the deadline a server job, not a browser timer and not an AI, freezes the roster and captures each exact share. I closed every browser; it still settled. If someone had been missing, it would void every hold instead." |
| 2:10-2:30 | `/merchant` demo login, dashboard | Show bookings by status, the Booking Readiness widget, click a bar to cross-filter. Type: "Show outings closing today with missing required participants." Show the result, then open a drill-down. | "The merchant sees everything in an AG Studio dashboard: a custom Booking Readiness widget, cross-filtering with an AG Grid table, and a read-only natural-language filter. It can search, not move money." |
| 2:30-2:45 | Drill-down of the failed/compensated seeded outing, or a fixture failure injection | Show the refund-pending / hold-released lines and the plain-language recovery message | "PayPal has no atomic group capture, so if one capture fails we stop, void the remaining holds, refund the completed captures, and show exactly what happened. Timeouts are reconciled before any retry." |
| 2:45-2:50 | End card | Repo URL, "PayPal sandbox only" | "Outings: fair group bookings, authorized by each person, settled by the server." |

If you are over time, cut the AG Studio drill-down detail first, never the deadline scene or the budget poker privacy shot.

## Honesty checklist (check every box before uploading)

- [ ] PayPal footage is shown as real **sandbox** only if it was actually recorded with sandbox credentials against api-m.sandbox.paypal.com. Otherwise every payment screen shows the "Fixture, not real PayPal" label on camera, and the narration says "simulated".
- [ ] Do not narrate "capture", "under-capture" or "void" as proven on PayPal unless the smoke script (`scripts/paypal-smoke.ts`) has run successfully and its evidence is in `docs/evidence/`.
- [ ] Real Claude is claimed only if `OUTINGS_ANTHROPIC_API_KEY` is set and the on-screen AI badge shows the Anthropic mode. In fixture mode, the badge is visible and the narration says "deterministic fixture parsing".
- [ ] Text overlay labels any fixture segment ("FIXTURE: simulated payment") for its full duration.
- [ ] No real names, emails, cards or tokens on screen. Sandbox buyer emails and invitation links are cropped or blurred; the `.env.local` file is never shown.
- [ ] The video says "PayPal sandbox", never "PayPal Outings" and never implies PayPal endorsement.
- [ ] No copyrighted music, clips or logos beyond fair factual mention. Use no music, or music you own or that is explicitly royalty free.
- [ ] Length is under 3:00 as shown by YouTube, set to Public (not unlisted/private).
- [ ] The Devpost text, README and video all agree on what is fixture and what is real.
- [ ] Video URL pasted into [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md): **TODO**.
