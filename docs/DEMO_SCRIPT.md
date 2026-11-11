# Demo video script (target 2:45, hard limit 2:50)

Public YouTube video, under 3 minutes, showing real functionality. No music or use music you own/licensed only. English narration. Record at 1080p, browser zoom 110-125%.

Prepare before recording: fresh `npm run demo:reset`, `npm run dev` and `npm run worker` running, `/demo` open in a tab, and the Simulated badge visible. If you record the PayPal segments with sandbox credentials, see the checklist at the bottom first.

The deadline and failure scenes use the **one-click scenarios** on `/demo` ("Watch a deadline settle"). Each one creates a fresh demo outing at The Sound Room ($100 private karaoke room, Maya sponsored) whose commitment deadline is 1 to 5 minutes away:

| Scenario | What it shows | Pre-set state |
|---|---|---|
| **The last payer commits in time** (`settle-soon`) | Deadline settlement: 5 x $20 captured, Maya $0, **Confirmed** | Alex, Ben, Freya, Jules hold $20; Noor commits live on camera |
| **A required guest holds out** (`holdout`) | ALL_REQUIRED: Noor never commits, the deadline **cancels** and releases every hold | Same four holds; Noor stays uncommitted |
| **A payment fails at the deadline** (`capture-failure`) | Partial failure: Alex, Ben, Freya captured, Jules **declined**, Noor's capture skipped; holds released, captures refunded, never confirmed | All five hold $20; simulator told to decline Jules's capture and to "lose" the response to Ben's refund |
| **Ten friends share the room** (`big-group`, optional beat) | Under-capture: ten payers each authorized $20, the estimate drops to $10, and each is charged exactly $10 at the deadline; the rest of the hold is released | Nine payers hold $20; Kai commits live and sees "estimated final share $10". Simulated, not real PayPal |

All scenario money is **FIXTURE** (the simulator), even when PayPal sandbox keys are configured, and every outing screen says so: the line "Simulated payments and AI · no real money" under the step label, and the dashed "Simulated · not real PayPal" pill beside the hold and the payment status. "Run the deadline now" on the scenario panel runs one pass of the same settlement worker the scheduler runs (it only processes work that is already due; nothing can settle before the deadline). With `npm run worker` running you do not need the button: the worker settles within about 5 seconds of the deadline. `/demo?deadlineSeconds=90` pre-selects any deadline from 60 to 600 seconds.

Two timings to plan for: start **The last payer commits in time** with a 2-minute deadline right before the invitation scene (1:10), so Noor's commit happens on camera and the deadline lands at the deadline scene; start **A payment fails at the deadline** with a 1-minute deadline at least a minute before the failure scene so it is due when you get there. Waiting time is cut in the edit and the cut is marked on screen ("2 minutes later").

| Time | Screen | Action | Narration |
|---|---|---|---|
| 0:00-0:10 | Title card, then the landing page `/` | Cut quickly to the brief screen | "Splitting a group booking usually means one friend fronts the money and chases everyone for weeks. Outings fixes that with PayPal: nobody is charged unless the whole group commits." |
| 0:10-0:25 | `/new` brief screen | Type the brief: "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share." Submit. | "The organizer writes the plan in plain words. Claude turns it into structured preferences. It extracts, it never decides money." (Overlay: **AI mode: FIXTURE** or **Claude** exactly as the badge says.) |
| 0:25-0:50 | Budget poker (`/demo`, game-night personas) | Vote as one persona, switch persona, show the second persona cannot see the first vote, three vote, organizer reveals the distribution | "Everyone says in private what they'd personally pay. The API never returns other people's votes, so it is not just hidden by CSS. The reveal shows only the aggregate, and a vote is never a payment." |
| 0:50-1:10 | Proposal and sponsor screen | Pick The Sound Room private karaoke room ($100 fixed total, up to 10). Mark Maya as sponsored. Show "$20 each, Maya $0". | "The organizer picks a real catalogue offer from the merchant. Maya's friends cover her: $100 split between five payers is $20 each, and the guest of honour pays nothing." |
| 1:10-1:35 | `/demo`: click **Start (closes in 2 min)** on "The last payer commits in time", then **Open as Noor**; the invitation and the payment step | Show the countdown and the Simulated badge on the panel. As Noor: show the terms, the line "Authorize up to $20. Your final share may be lower", click commit, show the approval (**on-screen label: Simulated, not real PayPal**) | "Here the deadline is two minutes away and four friends already hold $20. Noor authorizes her maximum, $20. Nothing is charged yet. The consent is tied to a hash of the exact terms: change the price or the date and everyone must agree again." |
| 1:35-1:50 | Waiting screen | Show "$20 authorized · estimated final share $20 · not charged yet" and the "Drops as more people commit" line under the estimate. | "If ten friends join, the estimated share falls to $10, but the hold stays $20. We never charge above the cap, and an estimate is not a release." |
| 1:50-2:10 | Terminal with `npm run worker` next to the closed browser, then Noor's outing page after the deadline (overlay: "2 minutes later") | Close the browser window. Show the worker log line at the deadline. Reopen Noor's page: **Confirmed**, final share $20. (Without a worker: back on `/demo`, wait for "Deadline passed", press **Run the deadline now**.) | "At the deadline a server job, not a browser timer and not an AI, freezes the roster and captures each exact share. I closed every browser; it still settled. If someone had been missing, it would void every hold instead." |
| 2:10-2:25 | `/merchant` demo login, dashboard, then the **Money** tab | Bookings page for 4 seconds with the Booking Readiness widget (click one bar to cross-filter). Switch to **Money**: the **Money flow** widget, one row split into kept, refund due, refunded and on-hold segments. Skip typing the natural-language question here (mention it in one sentence, or show it only if you have time). | "The merchant sees it in AG Studio. A custom Booking Readiness widget, and on the Money page a custom Money flow widget: where each authorized dollar went. Holds are not revenue, and refunds stay visible until they are done." |
| 2:25-2:45 | `/demo` scenario panel for "A payment fails at the deadline" (started earlier, deadline passed), Ben's page, then **See this booking as the venue** | Press **Run the deadline now**: panel shows "Not confirmed · refund pending" (3 collected · 1 failed · 1 skipped). **Open as Ben**: "Booking not confirmed. A payment failed; completed payments are being refunded." Press again a few seconds later: "Not confirmed · refunded". Drill-down: three Refund rows Succeeded, two Release hold rows. Overlay: **FIXTURE: simulated decline and timeout** | "PayPal has no atomic group capture. Here the simulator declines Jules's capture: we stop, release the remaining holds and refund the shares already captured. One refund's response was lost; the next pass reads the provider state back instead of refunding twice." |
| 2:45-2:50 | End card | Repo URL, "PayPal sandbox only" | "Outings: fair group bookings, authorized by each person, settled by the server." |

If you are over time, cut the AG Studio detail first (cross-filtering, saved views, the natural-language box; keep the Money flow shot only if the failure scene's drill-down is cut), never the deadline scene, the failure scene or the budget poker privacy shot.

Tip: record the Money page after the capture-failure scenario has run, so its Money flow row shows captured money moving to refund due and then refunded. The failure scene's drill-down (2:25-2:45) can double as the Money flow shot if time is short.

Rehearse once: start each scenario, run it to the end, and press **Reset demo data** afterwards if you want a clean "Every other outcome" list (scenario runs are listed there too).

## Honesty checklist (check every box before uploading)

- [ ] PayPal footage is shown as real **sandbox** only if it was actually recorded with sandbox credentials against api-m.sandbox.paypal.com. Otherwise every payment screen shows on camera that it is simulated (the "Simulated payments…" line, the "Simulated · not real PayPal" pill or the "Simulated approval page"), and the narration says "simulated".
- [ ] Do not narrate "capture", "under-capture" or "void" as proven on PayPal unless the smoke script (`scripts/paypal-smoke.ts`) has run successfully and its evidence is in `docs/evidence/`.
- [ ] Real Claude is claimed only if `OUTINGS_ANTHROPIC_API_KEY` is set and the on-screen AI badge shows the Anthropic mode. In fixture mode, the badge is visible and the narration says "deterministic fixture parsing".
- [ ] Text overlay labels any fixture segment ("FIXTURE: simulated payment") for its full duration. Scenario outings are always FIXTURE, even when sandbox keys are set: their holds, captures, the declined capture and the lost refund response are all simulated, and the narration says so.
- [ ] Every cut that skips waiting time (the 2-minute scenario deadline) is marked on screen; the deadline itself is never sped up.
- [ ] "Run the deadline now" is described as running one pass of the settlement worker, never as forcing a settlement.
- [ ] No real names, emails, cards or tokens on screen. Sandbox buyer emails and invitation links are cropped or blurred; the `.env.local` file is never shown.
- [ ] The video says "PayPal sandbox", never "PayPal Outings" and never implies PayPal endorsement.
- [ ] No copyrighted music, clips or logos beyond fair factual mention. Use no music, or music you own or that is explicitly royalty free.
- [ ] Length is under 3:00 as shown by YouTube, set to Public (not unlisted/private).
- [ ] The Devpost text, README and video all agree on what is fixture and what is real.
- [ ] Video URL pasted into [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md): **TODO**.
