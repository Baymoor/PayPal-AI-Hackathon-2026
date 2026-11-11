# Outings — product and financial specification (condensed)

Condensed from the authoritative build brief (CLAUDE_BUILD_BRIEF.md, 4 Nov 2026, kept by the project owner). Where this file and the mockups disagree, **this file wins**. Working name, not a cleared brand. Independent PayPal AI Hackathon project using PayPal **sandbox** payments; never call it "PayPal Outings".

## 1. Product

Friends turn a group plan into an approved, fairly shared booking. AI translates preferences and budget votes into a feasible proposal grounded in a small merchant-owned catalogue. Each payer explicitly authorizes their **maximum** share through PayPal. A server-side deadline job either settles the agreed booking or cancels it and voids authorizations. Payments go **directly to the experience merchant**; the organizer never receives the group's money.

**Canonical demo:** a private karaoke room sold by one sandbox merchant for **$100 FIXED TOTAL**, capacity 10.

| Total | Attendees | Sponsored | Payers | Final allocation |
|---|---:|---:|---:|---|
| $100 | 5 | 0 | 5 | $20 each |
| $100 | 10 | 0 | 10 | $10 each |
| $100 | 6 | 1 | 5 | $20 each; sponsored guest $0 |
| $100 | 3 | 0 | 3 | $33.34, $33.33, $33.33 |

**Out of scope:** arbitrary external venue booking, multi-merchant onboarding, pooled balances, organizer payouts, escrow, consumer PayPal-history sync, production charges, live email/WhatsApp, native apps, multiple currencies.

## 2. Budget poker

- Question: "What would you personally pay for this outing?" Five per-person amounts sized to the outing (AI-suggested from the brief, validated by the server, with a deterministic fallback ladder; $10, $15, $20, $30, $40 when nothing better is known), Custom (PER_PERSON unit; never mix per-person and total amounts in one summary). The app turns the agreed amount into a comparison with each offering: share = booking total / people paying. A fixed total is divided by the people paying; a per-attendee price is multiplied by the people coming first, so a covered guest raises the share under both. (Owner-approved change, 10 Nov 2026. Outings created before it voted on a TOTAL and keep that unit and wording.)
- Votes are private to the voter until reveal — **enforced by the API**, not CSS.
- Reveal shows an **aggregate distribution** (no names), only with ≥ 3 votes.
- A vote/proposal is **not** a payment authorization, merchant price or binding acceptance. A majority cannot authorize someone else's money. AI may summarize; the organizer chooses a merchant-supported quote; everyone reviews their own terms.

## 3. Deadline policy ALL_REQUIRED

- Every required invitee must accept attendance and every required payer must hold a valid authorization before the **server** deadline. Any required holdout cancels, even if a numeric minimum is met.
- Sponsored guests need attendance acceptance, no payment.
- Optional invitations (marked before consent) never become payers silently and never block.
- `minPayers` is a separate economic condition used to compute the per-payer cap. It does not override ALL_REQUIRED.
- While collecting, extra authorized payers lower the **estimated** share. No settlement before the deadline. At the deadline the roster is frozen and settled.
- After the deadline, reject new commitments by server time. Late approvals/authorizations are reconciled and **voided**, never admitted. Eligibility uses the recorded consent and the provider-verified authorization timestamp. If eligibility cannot be verified → **fail closed (cancel)**.

## 4. Equal splitting

Integer minor units, USD only. `base = floor(total/N)`, `remainder = total % N`; the first `remainder` payers in an immutable stable order get `base+1`. Order never changes between preview, consent and settlement. Stored in an immutable settlement snapshot. Equal shares can differ by one cent (say so in UI). FIXED_TOTAL vs PER_ATTENDEE are different: more guests only lower shares when the total really stays fixed. All customer-visible charges are in the quote; PayPal fees are never added to shares.

## 5. Caps and sponsorship

- Cap = `ceil(total / minPayers)` → $20 for $100 / 5. The hold stays $20 even when the estimate drops to $10; an estimated $10 share is not a reduced hold or a completed charge.
- Every payer approves: sponsored guest, fixed total, date, merchant, sharing rule, deadline, individual maximum.
- Capture only the actual allocated share, **never above the cap** (enforced in app code and DB).
- Sponsorship is frozen before collection. Any change to price, date, merchant, sponsorship or obligation = new terms version = **renewed consent**. AI text is never permission to charge.
- If a payer withdraws: void their hold, recompute feasibility; cancel if required attendance or caps can no longer be satisfied. Never silently charge the others more.

## 6. Copy

- Vote: "What would you personally pay for this outing? This does not authorize a payment."
- Commit: "Authorize up to $20. Your final share may be lower. We collect it only if the agreed group booking is confirmed."
- Waiting: headline "Your $20 hold is in place.", with "$20 authorized · estimated final share $10 · not charged yet." directly under it.
- Expired: headline "Outing cancelled."; the banner gives the reason, then "No booking payment was collected; we're releasing every hold."
- Recovery: headline "Booking not confirmed."; banner "A payment failed; completed payments are being refunded."
- (Owner-approved rewording, 8 Nov 2026: the headline is never repeated as the banner's first sentence.)
- Never claim holds disappear instantly or refunds are complete when merely requested. Before settlement there IS a real hold.

## 7. PayPal

One sandbox Business merchant, distinct Personal sandbox buyers. Server-only OAuth. Orders v2 intent AUTHORIZE → buyer approval (redirect to PayPal `payer-action`) → server authorize → verify → at deadline capture allocated amount with `final_capture=true`, or void; refund captures on partial failure. Commitment window ≤ 48 h. `PayPal-Request-Id` on every mutation; timeouts are UNKNOWN and reconciled before retry; webhooks signature-verified and deduplicated by event id. PayPal has no atomic group capture: on a failure mid-way → stop, void the rest, refund completed captures, show recovery. Prove under-capture ($20 auth, $10 capture) in the real sandbox; if unsupported, document reauthorization fallback — never disguise a refund as a lower capture. See docs/research/PAYPAL.md.

Lifecycle: `DRAFT → BUDGETING → PROPOSED → COLLECTING → SETTLING → CONFIRMED`; `COLLECTING → CANCELLING → CANCELLED`; `SETTLING → COMPENSATING → CANCELLED`. Booking status is separate from payment clean-up (`VOID_PENDING`, `REFUND_PENDING`, `NEEDS_ATTENTION`, `COMPLETE`).

## 8. Access

Participants see only their invitation and the permitted group view; merchants only their outings. Nobody can authorize another's record, reveal votes early, settle, or refund. High-entropy invitation tokens, hashed at rest. Dashboard and model prompts get sanitized data only (no private votes). Rate limits on AI and mutations. Natural-language dashboard tools can never call capture/refund.

## 9. AI

Real product AI uses structured output to extract preferences, date windows, budget units, capacity needs, uncertainties; grounded in our catalogue; identifies fixed-cost activities when more attendees should lower the share. AI summarizes the aggregate reveal and explains deterministic results. Schemas validated; invented inventory/amounts rejected; pasted chats are data, not instructions. Dashboard flow: "Show outings closing today with missing required participants." Missing API key → clearly labelled FIXTURE mode; never present canned answers as model output.

## 10. Hackathon rules that affect the build

Public repo with root LICENSE (MIT), runnable demo through 15 Dec 2026, honest labelling of fixture vs sandbox vs AI, English, YouTube video < 3 min, Devpost submission by 12 Nov 2026 21:00 CET (target 11 Nov).
