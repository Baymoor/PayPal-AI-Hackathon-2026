# Outings Design System

Mockups (Claude Design canvas, 8 artboards): https://claude.ai/artifact/7vF112AViHWwk1iwENUJeq
Tokens as code: `app/theme.css` (`@theme` block; `@import "./theme.css";` from `globals.css` after `@import "tailwindcss";`).
References and overrides: [README.md](./README.md).

Precedence: product spec > these mockups > exploratory images D01-D06.
Light theme only. Never write "PayPal Outings"; use "PayPal sandbox" and "Sandbox demo".

## 1. Principles
- Calm, premium, friendly. Warm cream canvas, navy ink, one coral accent.
- Money is always explained: maximum, estimate, authorized, captured, released, refunded are different words with different colours AND text.
- Status is never colour alone: every status has an icon plus a text label.
- No photos of people. Use illustration, gradients, lucide icons.
- Votes are aggregate only after reveal. No name next to an amount, ever.

### Copy and decoration rules (design review, 8 Nov 2026)
1. One honesty fact, one place: the header pill says "no real money"; one muted line under the step label says which mode ("Simulated payments and AI · no real money"); the dashed Fixture pill appears only beside money; the AI badge only on blocks the AI wrote.
2. One spelling per label, from shared constants ("Simulated · not real PayPal" lives in `lib/domain/labels.ts`).
3. One reassurance per screen beyond that stage's spec sentence.
4. No em-dashes in UI copy. Buttons carry no punctuation beyond "&" and "→".
5. Icons for status only (plus the three invitation detail rows). No icon beside a heading or a list row.
6. A card needs two rows or a control. No card inside a card.
7. Eyebrows for the step indicator only ("STEP 2 OF 4", no outing title).
8. Pills for fit, status and mode only, never for a fact already in the row.
9. Headlines are short statements with a period; a spec sentence with middle dots is a lead, not an h1.
10. No sparkles, in illustrations or as the AI icon (use `Bot`).

## 2. Tokens

### Colour
| Token (`--color-*`) | Hex | Use |
|---|---|---|
| cream | `#FBF6F1` | Page background |
| surface | `#FFFFFF` | Cards |
| ink | `#14213D` | Text, navy panels, focus ring (14.6:1 on cream) |
| ink-muted | `#5B6478` | Secondary text (5.5:1 on cream) |
| coral | `#E8604C` | Swoosh, decorative, large display only (3.4:1) |
| coral-600 | `#C8402D` | Primary button fill, selected vote tile, progress fill (white text 4.96:1) |
| coral-700 | `#B13624` | Link text and coral text on cream (5.6:1) |
| coral-800 | `#8F2A1B` | Text on blush |
| blush | `#F9E3DC` | Tint chips, icon tiles, deadline pill |
| blush-50 | `#FDF1EC` | Soft panels |
| line | `#EADFD3` | Hairline card border |
| line-strong | `#D9CCBE` | Input border, dividers |
| track | `#E8DED3` | Progress track |
| amber-bg / amber-line / amber-ink | `#FFF3D9` / `#F0D9A0` / `#5A3700` | Callouts (budget poker prompt, consent note) |

Status (text on matching bg, each pair >= 4.5:1). Label text is mandatory.
| Status | Text | Background | Label | Icon (lucide) |
|---|---|---|---|---|
| authorized | `#1F5FA8` | `#E3EEFA` | Authorized | lock |
| captured | `#1E6B45` | `#E1F3E8` | Captured | check |
| void-pending (hold release pending, refund pending) | `#8A5300` | `#FFF1D6` | Hold release pending / Refund pending | clock |
| refunded | `#5B3FA0` | `#EEE8FA` | Refunded | undo-2 |
| cancelled (also "hold released") | `#4A5568` | `#ECEEF1` | Cancelled / Hold released | x / check |
| fixture | `#A12D6B` | `#FBE6F1` (dashed 1px `#A12D6B` border) | Simulated · not real PayPal | flask-conical |
| danger | `#A3261B` | `#FDE8E5` | Needs attention | triangle-alert |

Pending vs final: use amber for "pending", then the final colour (gray released, purple refunded) once done. Text changes too ("Hold release pending" -> "Hold released"; "Refund pending" -> "Refunded $10").

### Typography
Display: `--font-display` Fraunces Variable (weight 600, letter-spacing -0.01em). UI: `--font-sans` Inter Variable.
| Role | Size / line | Font |
|---|---|---|
| hero | 60 / 63 (desktop), 44 / 48 (mobile) | display |
| h1 | 44 / 48 desktop, 36 / 40 mobile | display |
| h2 | 32 / 38 | display |
| h3 | 22 / 28 | display |
| money-lg | 56 / 56 (proposed budget), 34 (KPI), 26 (table totals) | display |
| lead | 19 / 28 | sans 400 |
| body | 16 / 24 | sans 400/500 |
| small | 14 / 20 | sans |
| caption/eyebrow | 12 / 16, uppercase, tracking 0.14em, 600 | sans |
Numbers in tables: `tabular-nums`, right aligned.

### Spacing, radius, shadow
- Space scale 4px: 4, 8, 12, 16, 20, 24, 32, 40, 48. Mobile gutter 20px (min 16). Desktop container max 1180px (dashboard 1240px), 24px side padding.
- Radii: chip 12, card 20, card-lg 24, vote tile 20, pill 999.
- Borders: 1px `line`. Selected: 2px coral-600.
- Shadows: card `0 1px 2px rgb(20 33 61/.04), 0 4px 16px rgb(20 33 61/.05)` (optional; mockups use border only). Popover `0 8px 32px rgb(20 33 61/.12)`.
- Focus ring: `0 0 0 3px #FBF6F1, 0 0 0 5px #14213D`, never removed.

### Breakpoints
Mobile first. Design widths: 375/390 mobile, 1280 desktop. `sm 640`, `md 768`, `lg 1024`, `xl 1280`. Two-column layouts wrap below ~1000px. Touch targets >= 44px (buttons 52-56px).

### Signature accent
Hand-drawn coral swoosh under one key word per screen: SVG path stroke `#E8604C`, width 3.5-4, round caps, 6-14px high, absolutely positioned under the word. Decorative (`aria-hidden`).

## 3. Components

### Button
- Primary: pill, min-height 52 (56 mobile full width), fill coral-600, white 600 17-18px. Hover `#A93322`, active `#932B1C`, focus ring, disabled fill `#E8C2BA` with ink-muted text plus visible reason, loading shows spinner and keeps width ("Authorizing..."). Optional trailing arrow icon.
- Secondary: pill, 1.5px ink border, transparent, ink text. Hover blush-50.
- Link: coral-700, 600, underlined (e.g. "Decline invitation", "Start budget poker →").
### Card
White, 1px line border, radius 20, padding 18-28. Variants: money card (rows), panel (blush-50), navy panel (proposed budget: bg ink, text cream), amber callout.
### Stepper (Brief → Budget → Invite → Commit)
Four steps, numbered 30px circles. States: current (coral-600 fill, white number, "(current)" visually-hidden-or-muted text, `aria-current="step"`), done (ink fill, check icon), upcoming (outlined). Wraps on mobile; on mobile screens show "STEP 2 OF 4" eyebrow instead.
### Pill / Badge
Pill 13px 700, padding 4/12. Variants: status (table above), **Sandbox demo** (blush bg, coral-800 text, top-right of every screen and in footer divider), **Simulated · not real PayPal** (fixture colours, dashed border), deadline pill ("Commit by Thursday, 18:00", blush, calendar/clock icon).
### Money row
Label left, value right, 14-16px vertical padding, 1px line top. Emphasis row (bold, display font value). Rows: Fixed room total, Your maximum, Estimated share, Authorized, Captured, Refunded. Money never "revenue" for authorized funds.
### Progress bar
Track `#E8DED3`, fill coral-600, 10px, radius 999. `role="progressbar"` with now/max and a visible text label ("4 of 5 payers committed").
### Vote tile
Radio group. 84px high, radius 20, 1.5px `#E2D4C4` border, display font 28px. Selected: coral-600 fill, white text, check badge. Hover border coral. Custom tile 22px text opens amount input. Voter dots are anonymous check circles with "4 of 6 voted".
### Toggle
`role="switch"`, 60x36, on = coral-600 with check in knob, off = `#C9BDB0` knob left. Label via `aria-labelledby`, state text under label ("On. Maya pays $0.").
### Status banner
Radius 18, 16px padding, icon + sentence. Info (cancelled gray), warning (amber), danger (`#FDE8E5` / `#6E1A12` text), success (captured green).
### Chart (distribution)
Vertical bars per amount, count label above each bar, amount below, modal bar coral-600, others `#EBCFC6`. `role="img"` with text alternative listing every count. Range and median stats beside it.
### Table (AG Grid)
Header 12px uppercase ink-muted on `#FFFCF9`; rows 14px; numeric columns right. Group header rows: "Real sandbox rows" and "Fixture data — not real PayPal" (diagonal pale pink stripes, dashed top border, "Fixture" badge per row). Wrap in horizontally scrollable region.
### Ask box
Pill input with sparkle icon, visible label (sr-only), "Ask" button. Placeholder/example: "Show outings closing today with missing required participants".
### Empty / loading / error
- Empty: icon tile + serif title + one sentence + one action (e.g. "No outings yet. Describe a plan to get started.").
- Loading: skeleton blocks `#EFE6DC` with pulse (respect reduced motion), `aria-busy`. Buttons show spinner and verb-ing label.
- Error: danger banner with what happened, what is safe ("You have not been charged"), and a retry action.

## 4. Screens (artboards in the mockup canvas)
1. **Brief (desktop 1280, `Main.dc.html`)**: header (logo, Sandbox demo) → stepper → two columns. Left: h1 "What are we planning?" (swoosh under "planning?"), textarea, "Find an outing →", note. Right: "Here's what I understood" card, five icon-tile rows (Activity, Date window, Attendees, Guest of honour, Budget "Not set yet"), amber callout "What total budget feels comfortable?" + "Start budget poker →".
2. **Budget poker (mobile 390, `Poker.dc.html`)**: back, logo, Sandbox demo → "STEP 2 OF 4" → h1 "Budget poker" → "Suggest a total budget." / "This does not authorize a payment." → 3x2 vote tiles ($50, $75, $100, $150, $200, Custom) → lock line → anonymous voter dots + "4 of 6 voted" → primary "Submit my $100 vote".
3. **Reveal + quote (desktop, `Reveal.dc.html`)**: stepper (Budget current) → left: h1, distribution chart, Range / Median / Voted stats; right: AI summary card, navy "Proposed group budget $100 — A starting point, not a merchant quote." → "Pick a merchant-confirmed quote" catalogue (radio cards; first: The Sound Room, Private karaoke room, $100 fixed total, up to 10 people; the other two are demo fixtures) → "Continue with The Sound Room".
4. **Treat someone special (mobile, `Sponsor.dc.html`)**: toggle card → table (Fixed room total $100, Attendees 6, Paying participants 5, Each paying participant $20, Maya pays $0) → amber consent note → "Save this split".
5. **Invitation / Commit (mobile, `Invitation.dc.html`)**: illustrated hero band (gradient + mic line art) → "You're invited." → "Maya's birthday karaoke" → meta rows (Friday 19:00, The Sound Room, Private room up to 10) → money card → deadline pill → progress → primary button → fine print → "Decline invitation" → "Sandbox demo" divider.
6. **Waiting (mobile, `Waiting.dc.html`)**: Authorized badge → h1 "Your $20 hold is in place." → lead "$20 authorized · estimated final share $10 · not charged yet." → money rows (Authorized up to $20, Estimated final share $10, Charged so far $0) → progress card.
7. **Results (mobile, `Results.dc.html`, three states)**: Confirmed (captured share, never above max, unused hold "Released"); Expired/cancelled; Recovery. Each shows the pending form, plus a "When it finishes" example of the final form.
8. **Merchant dashboard (desktop, `Merchant.dc.html`)**: header with PayPal sandbox + Fixture badges → h1 "Bookings" → Ask box → 4 money KPIs (Authorized (holds, not revenue), Captured, Refunded, Closing today) → three widgets: Outings by status (cross-filter, active filter chip), Money by state, Booking Readiness (custom widget: required accepted / required invited bars) → booking table (columns: Outing, Closing time, Required accepted / invited, Paying authorized, Authorized total, Final allocated, Captured, Refunded, Recovery status) with real rows first and fixture rows separated.

Mobile pages: single column, 20px gutter, primary CTA full width and anchored at the bottom of the viewport region. Desktop pages: two columns wrapping at ~1000px.

## 5. Exact copy strings
- Brief: "What are we planning?" · "Here's what I understood" · "Find an outing" · "What total budget feels comfortable?" · "Start budget poker" · "Suggestions are not bookings or payment approvals."
- Sample brief: "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share."
- Poker: "Budget poker" · "Suggest a total budget. This does not authorize a payment." · "Your vote stays private until reveal." · "4 of 6 voted" · "Submit my $100 vote"
- Reveal: "Proposed group budget" · "$100 — a starting point, not a merchant quote" · quote line "The Sound Room — private karaoke room, $100 fixed total, up to 10 people"
- Sponsor: "Treat someone special" · "Cover Maya's share" · "Fixed room total" · "Attendees" · "Paying participants" · "Each paying participant" · "Maya pays" · "Everyone sees and approves this split before committing. Changing who pays requires renewed consent."
- Invitation: "You're invited." · "Maya's birthday karaoke" · "Friday 19:00" · "The Sound Room" · "Private room up to 10" · "Fixed room total" · "6 attendees · 5 paying" · "Maya's share is covered" · "Your maximum" · "Estimated share" · "Commit by Thursday, 18:00" · "4 of 5 payers committed" · "Review & authorize $20" · "Authorize up to $20. Your final share may be lower. We collect it only if the agreed group booking is confirmed." · "Decline invitation" · "Sandbox demo"
- Waiting: h1 "Your $20 hold is in place." · lead "$20 authorized · estimated final share $10 · not charged yet."
- Expired: h1 "Outing cancelled." · banner "<reason> No booking payment was collected; we're releasing every hold."
- Recovery: h1 "Booking not confirmed." · banner "A payment failed; completed payments are being refunded."
- Status words: Authorized, Captured, Hold release pending, Hold released, Refund pending, Refunded, Cancelled, Simulated · not real PayPal.
- Merchant Ask example: "Show outings closing today with missing required participants"

## 6. Accessibility
- WCAG AA: all text pairs above >= 4.5:1; coral `#E8604C` is never used for small text or as a fill behind white text.
- Status = icon + text, never colour alone. Chart has a text alternative. Fixture rows have a text badge, not just stripes.
- Real controls: `<button>`, `<a>`, `<input>` with `<label>`; vote tiles `role="radiogroup"/radio`; toggle `role="switch"`; progress `role="progressbar"`; stepper `aria-current="step"`.
- Visible focus ring on every interactive element; keyboard order follows visual order; no keyboard traps.
- Touch targets >= 44px; layouts work at 375px with no horizontal page scroll (tables scroll inside their own region).
- Honour `prefers-reduced-motion`; announce async status changes with `aria-live="polite"`.
- Never show the same amount twice with different meanings without a label (maximum vs estimate vs captured).

## 7. Illustration and imagery
No people photos. Invitation hero: flat navy band, microphone line art, coral sparkles (no gradient). Sponsor: cake / gift line icon with confetti dots. Icons: lucide, 2px stroke, 20-24px.
