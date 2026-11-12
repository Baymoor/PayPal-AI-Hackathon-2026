# Architecture

One Next.js 16 app on Postgres, plus a worker that owns everything time-based. PayPal and Anthropic are only ever called from the server.

Related: [README](../README.md) · [judge guide](JUDGE_GUIDE.md) · [security and limitations](SECURITY_AND_LIMITATIONS.md) · [testing](TESTING.md) · [PayPal sandbox evidence](evidence/README.md) · [module contracts and HTTP API](CONTRACTS.md)

```mermaid
flowchart LR
  subgraph Browser
    P["Outing pages /new, /o/:id<br/>organizer and participants"]
    D["Demo hub /demo<br/>judge bar on /o/:id"]
    M["Merchant dashboard /merchant<br/>AG Studio + AG Grid"]
  end
  subgraph Server [Next.js server]
    API["Route handlers /api/*<br/>session, access check, service"]
    SVC["lib/services<br/>outings, views, payments, merchant"]
    DOM["lib/domain<br/>money, policy, budget options,<br/>state machines (pure)"]
    AI["lib/ai<br/>Claude structured output<br/>or labelled sample AI (FIXTURE)"]
    PAY["lib/payments<br/>PayPal sandbox adapter<br/>or labelled simulator (FIXTURE)"]
  end
  subgraph Worker
    TICK["runWorkerTick<br/>due jobs, overdue sweep, operations"]
    SET["lib/settlement<br/>freeze, reconcile, decide,<br/>capture, void, refund"]
  end
  CRON["npm run worker, POST /api/cron/tick,<br/>or /api/demo/tick in demo mode"]
  DB[("Postgres<br/>outings, quotes, consents, attempts,<br/>snapshots, operations, jobs, audit")]
  PP[("PayPal sandbox<br/>Orders v2 + Payments v2")]
  AN[("Anthropic API")]

  P --> API
  D --> API
  M --> API
  API --> SVC --> DOM
  SVC --> AI --> AN
  SVC --> PAY --> PP
  SVC --> DB
  CRON --> TICK --> SET --> DOM
  SET --> PAY
  SET --> DB
  PP -.->|"signed webhooks<br/>built, not set up on the live demo"| API
```

FIXTURE is the code's name for the payment simulator and the sample AI. Visitors read "Simulated · not real PayPal" and "Sample AI text (no model call)".

## On the live demo

| Piece | State |
|---|---|
| Host | https://outings.baymoor.dev, a DigitalOcean droplet running Docker Compose behind Caddy ([deployment](DEPLOYMENT.md)) |
| Worker | Settles outings at their deadline with no browser open |
| Judge sign-in | On. Real outings and real Claude are for signed-in judges ([below](#demo-mode-judge-mode-and-judge-sign-in)) |
| PayPal webhooks | Built and tested against a mocked PayPal, but not configured on the server (`/api/health` shows `webhookVerification:false`). The deadline flow does not wait for them: the worker reads PayPal's state itself |
| AG Studio | Trial mode, no licence key yet. AG Grid Community is MIT |

## Booking lifecycle

Booking status follows the transition table in [state-machine.ts](../lib/domain/state-machine.ts) (`OUTING_TRANSITIONS`). Any other move throws `IllegalTransitionError`.

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> BUDGETING: start budget poker
  BUDGETING --> PROPOSED: organizer agrees a per-person budget
  PROPOSED --> BUDGETING: another round
  PROPOSED --> COLLECTING: quote confirmed, terms hashed,<br/>deadline job scheduled
  COLLECTING --> SETTLING: deadline passed, roster frozen,<br/>decision SETTLE
  COLLECTING --> CANCELLING: deadline not met, required decline<br/>or withdrawal, organizer cancel
  SETTLING --> CONFIRMED: every allocated share captured
  SETTLING --> COMPENSATING: a capture failed
  CANCELLING --> CANCELLED: holds queued for void
  COMPENSATING --> CANCELLED: captures resolved,<br/>refunds and voids planned
  DRAFT --> CANCELLED
  BUDGETING --> CANCELLED
  PROPOSED --> CANCELLED
```

Money clean-up is a separate field (`NONE`, `VOID_PENDING`, `REFUND_PENDING`, `NEEDS_ATTENTION`, `COMPLETE`), computed by `recomputeCleanup` in [operations.ts](../lib/settlement/operations.ts). It says `COMPLETE` only after the provider confirmed every void and refund.

## Settlement at the deadline

`runDeadlineSettlement` in [deadline.ts](../lib/settlement/deadline.ts) freezes, re-reads PayPal, decides once, and plans every provider call as a durable operation. `processDueOperations` in [operations.ts](../lib/settlement/operations.ts) sends them.

```mermaid
sequenceDiagram
  participant W as Worker (late is fine)
  participant DB as Postgres
  participant PP as PayPal
  W->>DB: freeze: set frozen_at once deadline_at has passed (DB clock)
  Note over W,DB: no consent or authorization accepted after this
  W->>PP: read back every hold (outside any transaction)
  W->>DB: one transaction: lock outing, decideSettlement(),<br/>insert immutable snapshot, plan CAPTURE and VOID ops<br/>with stable PayPal-Request-Ids
  loop captures in stable payer order
    W->>PP: capture allocated share (at most the cap), final_capture=true
    alt success
      W->>DB: attempt CAPTURED
    else timeout
      W->>PP: read state, retry only with the SAME request id
    else declined
      W->>DB: COMPENSATING: skip remaining captures,<br/>plan voids and refunds
    end
  end
  W->>DB: CONFIRMED (all captured) or CANCELLED, plus clean-up state
```

The worker is safe to run in several processes: jobs are claimed with `SKIP LOCKED`, operations are claimed atomically, and the snapshot is unique per outing ([runner.ts](../lib/jobs/runner.ts)). A sweep settles any overdue outing whose job was lost.

## Invariants

Each rule is enforced in code and pinned by a test. The database adds check constraints where it can.

| # | Invariant | Enforced in | Test |
|---|---|---|---|
| 1 | Money is integer minor units, one currency (USD) per outing | `assertMinor`, `SUPPORTED_CURRENCIES` in [money.ts](../lib/domain/money.ts) | [money.test.ts](../tests/domain/money.test.ts) |
| 2 | Shares sum exactly to the total and differ by at most one cent; extra cents go to the first payers in the immutable `sortKey` order | `equalSplit` in [money.ts](../lib/domain/money.ts), `stablePayerOrder` in [policy.ts](../lib/domain/policy.ts) | [money.test.ts](../tests/domain/money.test.ts) |
| 3 | No capture above the consented cap or the authorized amount | `decideSettlement` in [policy.ts](../lib/domain/policy.ts), `planPaymentOperation` in [plan.ts](../lib/payments/plan.ts), check `payment_capture_le_authorized` in [schema.ts](../lib/db/schema.ts) | [policy.test.ts](../tests/domain/policy.test.ts), [operations.test.ts](../tests/settlement/operations.test.ts) |
| 4 | Consent is bound to a hash of the exact terms (quote, merchant, offering, total, cap, capacity, minimum payers, activity time, deadline, policy, split rule, sponsored and required lists); any change needs new consent | `buildCommitmentTerms`, `hashTerms` in [policy.ts](../lib/domain/policy.ts) | [policy.test.ts](../tests/domain/policy.test.ts), [routes.test.ts](../tests/payments/routes.test.ts) |
| 5 | Commitments are accepted only while `COLLECTING`, not frozen, and before the server deadline | `collectionWindowOpen` in [outings.ts](../lib/services/outings.ts) | [service.test.ts](../tests/payments/service.test.ts), [terms-time-audit2.test.ts](../tests/audit2/terms-time-audit2.test.ts) |
| 6 | Late, unverifiable or wrong-payee authorizations are never admitted and are voided (fail closed) | `decideSettlement` in [policy.ts](../lib/domain/policy.ts), `reconcileAttempt` in [reconcile.ts](../lib/settlement/reconcile.ts), `expectedPayeeFor` in [payments.ts](../lib/services/payments.ts) | [deadline.test.ts](../tests/settlement/deadline.test.ts), [payee.test.ts](../tests/payments/payee.test.ts), [settlement-audit.test.ts](../tests/audit/settlement-audit.test.ts) |
| 7 | Settlement is decided once per outing under a row lock; no provider call runs inside a transaction | `runDeadlineSettlement` in [deadline.ts](../lib/settlement/deadline.ts) | [deadline.test.ts](../tests/settlement/deadline.test.ts) |
| 8 | Every provider mutation has an outbox row and a stable `PayPal-Request-Id`; a timeout is `UNKNOWN` and is reconciled before any retry | `operationRequestId` in [plan.ts](../lib/payments/plan.ts), [operations.ts](../lib/settlement/operations.ts) | [operations.test.ts](../tests/settlement/operations.test.ts) |
| 9 | A failed capture never confirms the booking and never moves its share onto others; completed captures are refunded | [operations.ts](../lib/settlement/operations.ts) | [operations.test.ts](../tests/settlement/operations.test.ts), [compensation.spec.ts](../tests/e2e/compensation.spec.ts) |
| 10 | AI never decides money, eligibility, deadlines or provider calls; sample (FIXTURE) output is labelled | [validate.ts](../lib/ai/validate.ts), [budget-options.ts](../lib/domain/budget-options.ts) | [ai.test.ts](../tests/ai/ai.test.ts), [budget-options.test.ts](../tests/domain/budget-options.test.ts) |

## AI boundary

The model extracts facts and drafts suggestions. Plain code validates every field before it is shown or stored ([validate.ts](../lib/ai/validate.ts)).

| Task | What the code refuses |
|---|---|
| `extractBrief` | A budget the brief does not state is dropped. Categories must exist in the catalogue. |
| `proposeOfferings` | Only real, active offerings that fit the group survive. Prices come from the database. |
| `summarizeReveal` | Sees an anonymous vote distribution only. A suggested amount outside the vote range is replaced by the median. |
| `draftPlan` | `validatePlanDraft` drops (never fixes) invalid offerings, times, deadlines and sponsors. |
| `dashboardQuery` and the [AG Studio proxy](../app/api/merchant/ai/studio/route.ts) | Read-only filters and view tools only. No capture, void, refund or edit tool exists. |

**Consistent answers.** How the [prompts](../lib/ai/prompts.ts) keep Claude steady:

- The model is Claude Sonnet 5.5 at `low` effort with structured output (`output_config.format`), which fixes the shape of every answer.
- Sonnet 5.5 rejects sampling parameters, so there is no temperature to turn down. Consistency comes from structure instead, following Anthropic's prompting guidance for this model.
- Each task lists its decision rules in the order to apply them, with a tie-break. The ranker has an explicit category, group, budget and needs rubric. The planner uses the same slot and deadline rules as the sample planner.
- Tasks with judgement calls carry worked examples.
- Ranking and planning end with a think-first line and get a larger `max_tokens`. With structured output the model can only reason in its thinking, and thinking counts toward that limit.
- Checked against the real API on the live demo on 11 Nov 2026: a full [ai-smoke.ts](../scripts/ai-smoke.ts) run passed 12 of 13 checks. The one that failed (venue ranking) was fixed and then passed 3 of 3 reruns. That run's output files were not committed.

**Budget votes** are per person ("what would you personally pay?").

- The vote amounts are sized per outing by `chooseBudgetOptions` in [budget-options.ts](../lib/domain/budget-options.ts).
- The AI's five suggested amounts are used only if they are whole dollars, strictly increasing, at most 10x apart, and contain the app's own anchor. That last check also catches a model answering with whole-group totals.
- Otherwise the code builds 0.5x, 0.75x, 1x, 1.5x, 2x around that anchor: the brief's per-person budget, else its total divided by the people paying, else the lower median of what matching catalogue offerings cost per person, else $20.
- The reveal opens once 75% of the group has voted (rounded up), and never with fewer than 3 votes.

**Shares on venue cards** come from [budget-fit.ts](../lib/domain/budget-fit.ts).

- Share = booking total / people paying. The booking total is a fixed price, or a per-attendee price times the people coming.
- A covered guest comes but does not pay, so they raise the share under both models.
- The ranker is handed these shares and never computes one. The organizer's venue cards recompute them from the live roster.
- This is display and ranking only. Quotes, caps and settled shares still come from `policy.ts` and `money.ts`.
- Outings created before per-person voting keep `budget_unit = TOTAL`, and every label and comparison follows the outing's own unit.

## Demo mode, judge mode and judge sign-in

Three different things with confusingly similar names. Sorry about that.

**Which outing gets what.** The mode is decided per outing (`paymentModeForOuting` in [payments.ts](../lib/services/payments.ts), `aiModeForOuting` in [lib/ai/index.ts](../lib/ai/index.ts)), so one settlement never mixes simulated and real holds.

| Outing | Payments | AI |
|---|---|---|
| Demo outing (seeded, or a `/demo` story) | The simulator, always, even when PayPal keys are set | The sample AI, always, even when an Anthropic key is set |
| Real outing (created on `/new`) | PayPal sandbox when PayPal keys are set | Claude when the Anthropic key is set |

Without keys, a real outing falls back to the simulator and the sample AI when `DEMO_FIXTURES_ENABLED=true`, and has no payments or AI when it is off.

**Demo mode** (`DEMO_FIXTURES_ENABLED=true`) turns on the demo surfaces. With it off, every `/api/demo/*` route, the simulator's approval page and the merchant demo login answer 404.

- Catalogue: 8 offerings at 5 made-up venues in Copenhagen. The Sound Room has four ([seed.ts](../lib/demo/seed.ts)): two karaoke rooms, an escape room, and a `PER_ATTENDEE` pottery evening that can be ranked but not booked. The other four venues have one `FIXED_TOTAL` offering each ([venues.ts](../lib/demo/venues.ts)). Every venue has its own merchant dashboard, and the demo sign-in has a venue picker.
- Five starters on `/new` ([starters.ts](../lib/demo/starters.ts)), one per venue.
- Four one-click stories on `/demo` ([scenarios.ts](../lib/demo/scenarios.ts)): settles on time, one holdout, capture fails, ten-person group. **Reset** re-seeds the shared demo outings and leaves recently started stories alone.

**Judge mode** is the **Acting as** bar on `/o/:id`, demo mode only. One browser can play every person in an outing.

- The bar shows who the browser acts as and what everyone else still has to do (`judgeBoard` in [judge.ts](../lib/demo/judge.ts), pure, built only from the viewer's own `OutingView`).
- Persona switch: `authorizePersonaSwitch` in [judge-persona.ts](../lib/demo/judge-persona.ts) behind [POST /api/demo/persona](../app/api/demo/persona/route.ts). Threat model: [security and limitations](SECURITY_AND_LIMITATIONS.md).

**Judge sign-in** (`/judge/login`, [judge.ts](../lib/auth/judge.ts)) guards the things that spend real resources. It is on only when `JUDGE_PASSWORD` (16 characters or more) is set, as on the live demo. The password is never in the repo.

| Needs a judge sign-in | Open to everyone |
|---|---|
| `/new` and `POST /api/outings` | Home and how it works |
| The AG Studio assistant | `/demo` and its stories |
| Real-Claude answers in the dashboard's filter box | Invitation links |
| | The demo merchant dashboard (the filter box uses the sample parser) |

## Failure handling

API errors are JSON with a code and a plain message, never a stack trace (`errorResponse` in [http.ts](../lib/http.ts)). The PayPal browser redirects are the one exception.

| Failure | Response |
|---|---|
| Database or network briefly unreachable ([transient-errors.ts](../lib/transient-errors.ts)) | 503 `TEMPORARILY_UNAVAILABLE`, `Retry-After: 30` |
| Server closes an idle pooled connection | Pool `error` listener logs it, next query reconnects; connect timeout 10 s ([client.ts](../lib/db/client.ts)) |
| Body fails the schema | 400 `INVALID_INPUT`, plain message, offending paths in `fields` |
| PayPal return or cancel | A 303 redirect, not JSON: a malformed or unknown attempt id, or no session for its outing, lands on the neutral `/?payment=signin`; a payment error lands on the outing with `?payment=failed` ([return route](../app/api/payments/paypal/return/route.ts)) |
| PayPal timeout or 5xx | Operation `UNKNOWN`, reconciled from PayPal before any retry |
| Anything else | 500 `INTERNAL`, "Nothing was charged by this request" |

Module ownership and the HTTP API: [CONTRACTS.md](CONTRACTS.md). Rules in full: [product spec](PRODUCT_SPEC.md). Next: [how each claim is tested](TESTING.md).
