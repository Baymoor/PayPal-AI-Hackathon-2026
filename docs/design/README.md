# Design references

Mockups: https://claude.ai/artifact/7vF112AViHWwk1iwENUJeq ("Outings — UI mockups", Claude Design canvas, private until shared).
Implementable spec: [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md). Tokens: `app/theme.css`.

Rule of precedence: **product spec > Claude Design mockups > exploratory images below.**

| ID | File | What we adopt | What the spec overrides |
|----|------|---------------|-------------------------|
| D01 | `reference/D01-budget-poker-mobile.webp` | Centred serif title, 3x2 vote tile grid, selected tile coral with check, lock line "Your vote stays private until reveal", "4 of 6 voted", full-width coral submit, footer disclaimer | Amounts $60/$80/$100/$120/$150/Custom become **$50/$75/$100/$150/$200/Custom**. Avatars are anonymous (check dots only, no names or faces). Badge reads "Sandbox demo", not "Demo". Copy adds "This does not authorize a payment." |
| D02 | `reference/D02-budget-reveal-desktop.webp` | Navy top bar, range + median strip, "Budget suggestions (number of votes)" bar chart with "N votes" labels, proposed group budget card with large coral $100, "starting point... not a merchant quote", info banner "Budget agreement does not authorize payment." | **Aggregate only.** The six per-person cards (Alex $100, Ben $100...) are dropped: no name ever appears next to an amount. Chart buckets follow $50/$75/$100/$150/$200. Headline "A budget everyone can discuss." is optional; mockup uses "Here's where the group landed". Badge "Demo data" becomes "Sandbox demo". Reveal is followed by the merchant quote picker. |
| D03 | `reference/D03-landing-desktop.webp` | Cream canvas, serif hero "Make plans. Make them happen." with coral swoosh, coral pill CTA, sample outing card (progress, estimated share, closing time), 3-step strip (Plan together, Commit your share, Get confirmed) | **Stock photo of people removed** (no licensed photos): use an illustration or gradient panel with lucide icons. Sample card must be labelled "Sandbox demo". No testimonials. Not in the mockup canvas (landing is out of the required screen list); build from this note. |
| D04 | `reference/D04-invitation-mobile.webp` | Hero band, "You're invited." with swoosh, meta row (date, place, capacity), money card, deadline pill, progress bar, coral CTA, decline link, "Sandbox demo" footer | Photo hero becomes an illustrated gradient band. Authorize copy replaced by the spec string ("Authorize up to $20. Your final share may be lower. We collect it only if the agreed group booking is confirmed."). Deadline reads "Commit by Thursday, 18:00". Card shows 6 attendees, 5 paying. |
| D05 | `reference/D05-sponsor-guest-mobile.webp` | Confetti and cake line illustration, "Treat someone special." title, guest-of-honour row, "Cover Maya's share" toggle, split table with highlighted "Maya pays $0", consent note with people icon | **Photo avatar replaced** by an initial/illustrated tile. Table rows per spec (Fixed room total, Attendees, Paying participants, Each paying participant, Maya pays). Consent copy kept verbatim. CTA "Save this split" is kept as a reasonable label; footer "Demo · No payment collected" becomes "Sandbox demo". |
| D06 | not on disk (shown in conversation) | Two-column "What are we planning?" brief screen, stepper at top, textarea left, "Here's what I understood" card with icon tiles right, coral "Find an outing" button, amber budget callout | Stepper is the 4-step Brief, Budget, Invite, Commit. Footer "Suggestions are not bookings or payment approvals." |

## Notes
- Never write "PayPal Outings". Use "PayPal sandbox" and "Sandbox demo".
- Mockup frames: 1280 desktop (Brief, Reveal, Merchant), 390 mobile (Poker, Sponsor, Invitation, Waiting, Results x3).
- Mockup details deliberately simplified: the Waiting screen shows the spec's "10 payers joined" case ($10 share); other screens use the 6 attendee / 5 payer case ($20 share).
