/**
 * One-click demo scenarios: a FRESH fixture outing whose commitment deadline is
 * minutes away, so the deadline settlement (and its failure handling) can be
 * watched live instead of waiting for the seeded ~2 h deadline.
 *
 * Honesty and realism
 * - Every scenario outing is `isFixture` and pays through the FIXTURE simulator
 *   ("Fixture · not real PayPal"), even when PayPal sandbox keys are configured.
 * - Only the pre-collection history (brief, private votes, reveal, proposal) is
 *   seeded, with the deterministic FIXTURE parser/ranker (`seedOuting`). From
 *   there on everything goes through the REAL services: `openCollection`
 *   (deadline validation, availability, `buildCommitmentTerms` / `hashTerms`,
 *   quote, SETTLE_DEADLINE job), `respond`, `consent`, `startPayment` and
 *   `approveFixturePayment` (FixtureProvider order -> approve -> authorize ->
 *   verified recording). The worker settles it like any other outing.
 * - capture-failure injects simulator failures with `setFixtureFailure`: one
 *   declined capture, and one refund whose response is "lost" (TIMEOUT_AFTER:
 *   the refund IS applied, the caller sees UNKNOWN), so the REFUND_PENDING
 *   clean-up and its reconciliation are visible between two worker passes.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { merchants, offerings, outings, participants, paymentAttempts, paymentOperations, type Merchant, type Offering, type Participant } from "../db/schema";
import { config, type AppConfig } from "../env";
import { conflict } from "../http";
import { recordAudit } from "../audit";
import { formatMoney, perPayerCap } from "../domain/money";
import type { CleanupState, OperationKind, OperationStatus, OutingStatus, ParticipantRole, PayerType } from "../domain/types";
import { setFixtureFailure, type FixtureFailureMode, type FixtureOperation } from "../payments/fixture";
import { consent, openCollection, respond } from "../services/outings";
import { approveFixturePayment, startPayment } from "../services/payments";
import {
  DEMO_MERCHANT_SLUG,
  DEMO_SCENARIO_DEADLINE_SECONDS,
  DEMO_SCENARIO_HISTORY_MS,
  DEMO_SCENARIO_KINDS,
  DEMO_SCENARIO_TITLES,
  clampScenarioSeconds,
  type DemoScenarioKind,
} from "./constants";
import { nextLocalWeekdayAt, seedCatalogue, seedOuting, type PersonSpec } from "./seed";
import { ensureDemoVenues } from "./venues";

export { DEMO_SCENARIO_DEADLINE_SECONDS, DEMO_SCENARIO_KINDS, DEMO_SCENARIO_TITLES, type DemoScenarioKind };

const MIN = 60_000;
const HOUR = 60 * MIN;

const BRIEF =
  "Karaoke for Maya's birthday on Friday evening! Six of us, ideally a private room. Let's cover Maya's share. Around $100 total, split fairly.";

type CastKey = "alex" | "ben" | "freya" | "jules" | "noor" | "maya" | "leo" | "ida" | "omar" | "kai";

/** Every scenario opens commitments with this many required payers, so each hold is the room price / 5. */
const SCENARIO_MIN_PAYERS = 5;

/**
 * Organizer + 4 payers + Maya (sponsored). sortKey order = capture order: Alex, Ben, Freya, Jules, Noor.
 * Votes are per person ("what would you personally pay?"); the median is $20.
 */
const CAST: (PersonSpec & { key: CastKey })[] = [
  { key: "alex", name: "Alex", organizer: true, voteMinor: 2_000 },
  { key: "ben", name: "Ben", voteMinor: 2_000 },
  { key: "freya", name: "Freya", voteMinor: 1_500 },
  { key: "jules", name: "Jules", voteMinor: 3_000 },
  { key: "noor", name: "Noor", voteMinor: 2_000 },
  { key: "maya", name: "Maya", sponsored: true, voteMinor: 2_000 },
];

const BIG_BRIEF =
  "Karaoke night for the whole crew! Ten of us, one private room, around $100 total. The more of us who join, the less each pays.";

/** Organizer + 9 payers, all PAYER (no sponsored guest): ten payers share the $100 room, $10 each. Kai commits live. */
const BIG_CAST: (PersonSpec & { key: CastKey })[] = [
  { key: "alex", name: "Alex", organizer: true, voteMinor: 2_000 },
  { key: "ben", name: "Ben", voteMinor: 2_000 },
  { key: "freya", name: "Freya", voteMinor: 1_500 },
  { key: "jules", name: "Jules", voteMinor: 3_000 },
  { key: "noor", name: "Noor", voteMinor: 2_000 },
  { key: "maya", name: "Maya", voteMinor: 2_000 },
  { key: "leo", name: "Leo", voteMinor: 2_500 },
  { key: "ida", name: "Ida", voteMinor: 1_500 },
  { key: "omar", name: "Omar", voteMinor: 2_000 },
  { key: "kai", name: "Kai", voteMinor: 2_000 },
];

interface InjectedFailure {
  key: CastKey;
  operation: FixtureOperation;
  mode: FixtureFailureMode;
}

interface ScenarioPlan {
  /** Payers who consent and authorize their $20 maximum before the viewer arrives. */
  committed: CastKey[];
  failures: InjectedFailure[];
  notes: Partial<Record<CastKey, string>>;
  /** Defaults to the six-person karaoke cast (Maya sponsored). */
  cast?: (PersonSpec & { key: CastKey })[];
  brief?: string;
}

const HOLD = "Committed · $20 hold (simulated)";
const MAYA = "Sponsored guest · accepted · pays $0";
const BIG = (name: string) => `${name} · committed · $20 hold (simulated); estimate drops to $10 once ten commit`;

const PLANS: Record<DemoScenarioKind, ScenarioPlan> = {
  "settle-soon": {
    committed: ["alex", "ben", "freya", "jules"],
    failures: [],
    notes: {
      alex: `Organizer · ${HOLD}`,
      ben: HOLD,
      freya: HOLD,
      jules: HOLD,
      noor: "Not committed yet: open as Noor and authorize $20 before the deadline",
      maya: MAYA,
    },
  },
  holdout: {
    committed: ["alex", "ben", "freya", "jules"],
    failures: [],
    notes: {
      alex: `Organizer · ${HOLD}`,
      ben: HOLD,
      freya: HOLD,
      jules: HOLD,
      noor: "Required guest who never commits: leave Noor alone and the deadline cancels the outing",
      maya: MAYA,
    },
  },
  "capture-failure": {
    committed: ["alex", "ben", "freya", "jules", "noor"],
    failures: [
      { key: "jules", operation: "CAPTURE", mode: "DECLINE" },
      { key: "ben", operation: "REFUND", mode: "TIMEOUT_AFTER" },
    ],
    notes: {
      alex: `Organizer · ${HOLD} · share collected first, then refunded`,
      ben: `${HOLD} · share collected, then refunded; the refund needs a second try`,
      freya: `${HOLD} · share collected, then refunded`,
      jules: `${HOLD} · payment declined at the deadline, then the hold is released`,
      noor: `${HOLD} · not collected after the failure, hold released`,
      maya: MAYA,
    },
  },
  "big-group": {
    cast: BIG_CAST,
    brief: BIG_BRIEF,
    committed: ["alex", "ben", "freya", "jules", "noor", "maya", "leo", "ida", "omar"],
    failures: [],
    notes: {
      alex: `Organizer · ${HOLD}`,
      ben: BIG("Ben"),
      freya: BIG("Freya"),
      jules: BIG("Jules"),
      noor: BIG("Noor"),
      maya: BIG("Maya"),
      leo: BIG("Leo"),
      ida: BIG("Ida"),
      omar: BIG("Omar"),
      kai: "Not committed yet: open as Kai and authorize $20. As the tenth payer your estimate drops to $10; at the deadline you pay exactly $10 out of the $20 hold",
    },
  },
};

export interface DemoScenarioPersona {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  payerType: PayerType;
  note: string;
}

export interface DemoScenario {
  outingId: string;
  kind: DemoScenarioKind;
  title: string;
  /** Server deadline (ISO). The settlement engine enforces it with the database clock. */
  deadlineAt: string;
  deadlineSeconds: number;
  /** Server time when the scenario was created, for client countdowns. */
  serverNow: string;
  personas: DemoScenarioPersona[];
}

export function scenarioKindOfTitle(title: string): DemoScenarioKind | null {
  return DEMO_SCENARIO_KINDS.find((k) => DEMO_SCENARIO_TITLES[k] === title) ?? null;
}

const ROOM_SLUG = "private-karaoke-room";

/**
 * The demo merchant and its karaoke room AS THEY ARE. These rows are shared with
 * real (non-fixture) outings, so a scenario (a public button in demo mode) only
 * reads them; it never resets price, capacity, availability, timezone or the
 * active flag (that is what the explicit demo reset does). The catalogue is
 * seeded only when it does not exist yet (fresh database); the fictional
 * starter venues likewise are only created when missing, never overwritten.
 */
async function demoCatalogue(db: Db): Promise<{ merchant: Merchant; room: Offering }> {
  await ensureDemoVenues(db);
  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.slug, DEMO_MERCHANT_SLUG) });
  const room = merchant
    ? await db.query.offerings.findFirst({ where: and(eq(offerings.merchantId, merchant.id), eq(offerings.slug, ROOM_SLUG)) })
    : undefined;
  if (merchant && room) return { merchant, room };
  const seeded = await seedCatalogue(db);
  return { merchant: seeded.merchant, room: seeded.offerings[ROOM_SLUG] };
}

/**
 * Create a fresh COLLECTING fixture outing for `kind`. Demo mode only (the
 * FIXTURE approval used for the pre-authorized holds refuses otherwise).
 */
export async function createDemoScenario(
  db: Db,
  input: { kind: DemoScenarioKind; deadlineSeconds?: number; now?: Date; secret?: string },
): Promise<DemoScenario> {
  const cfg = config();
  if (!cfg.demoFixturesEnabled) throw new Error("demo scenarios need DEMO_FIXTURES_ENABLED=true");
  const plan = PLANS[input.kind];
  const cast = plan.cast ?? CAST;
  const now = input.now ?? new Date();
  const deadlineSeconds = clampScenarioSeconds(input.deadlineSeconds ?? DEMO_SCENARIO_DEADLINE_SECONDS.default);
  const deadlineAt = new Date(now.getTime() + deadlineSeconds * 1000);
  const title = DEMO_SCENARIO_TITLES[input.kind];

  // The fixed-total private karaoke room at The Sound Room, as currently listed (read, not re-seeded).
  const { merchant, room } = await demoCatalogue(db);
  if (!room.active || room.pricingModel !== "FIXED_TOTAL") {
    throw conflict("OFFERING_UNAVAILABLE", `${room.name} is not available for a shared booking right now, so no scenario was created.`);
  }

  // Brief -> budget poker -> reveal -> proposal history (FIXTURE parser/ranker), ending at PROPOSED.
  const seeded = await seedOuting(
    db,
    {
      key: `scenario-${input.kind}`,
      title,
      brief: plan.brief ?? BRIEF,
      status: "PROPOSED",
      createdAt: new Date(now.getTime() - DEMO_SCENARIO_HISTORY_MS),
      people: cast,
      // Agreed per person: the most any payer is asked to hold for this room (its price over the minimum payers).
      proposal: { merchant, offering: room, proposedBudgetMinor: perPayerCap(room.priceMinor, SCENARIO_MIN_PAYERS) },
    },
    input.secret ?? cfg.sessionSecret,
  );
  const outingId = seeded.outing.id;
  const person = (key: CastKey): Participant => seeded.people.get(key)!;
  const actor = (key: CastKey) => ({ outingId, participantId: person(key).id });

  // Real services from here: availability, deadline window, terms + hash (Maya sponsored, everyone
  // required), quote, SETTLE_DEADLINE job; then Maya's acceptance and each payer's consent + hold.
  const activityAt = nextLocalWeekdayAt(new Date(deadlineAt.getTime() + HOUR), 5, 19, merchant.timezone);
  const opened = await openCollection(db, actor("alex"), { activityAt, deadlineAt, minPayers: SCENARIO_MIN_PAYERS }, now);
  if (!plan.cast) await respond(db, actor("maya"), { response: "ACCEPT" }, now);

  for (const key of plan.committed) {
    const { participantId } = actor(key);
    await consent(db, actor(key), { termsHash: opened.termsHash }, now);
    const started = await startPayment(db, { outingId, participantId, now, reviewedTermsHash: opened.termsHash });
    const approved = await approveFixturePayment(db, { attemptId: started.paymentAttemptId, participantId, outcome: "APPROVE", now });
    if (approved.outcome !== "AUTHORIZED") {
      throw new Error(`demo scenario ${input.kind}: ${person(key).displayName}'s fixture hold was not authorized (${approved.outcome})`);
    }
  }

  if (plan.failures.length > 0) {
    const attempts = await db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, outingId) });
    for (const f of plan.failures) {
      const attempt = attempts.find((a) => a.participantId === person(f.key).id && a.status === "AUTHORIZED" && a.authorizationId);
      if (!attempt?.authorizationId) throw new Error(`demo scenario ${input.kind}: no authorization to inject a failure into`);
      await setFixtureFailure(db, { authorizationId: attempt.authorizationId, operation: f.operation, mode: f.mode });
    }
  }

  await recordAudit(db, {
    outingId,
    actor: "SYSTEM",
    type: "DEMO_SCENARIO_CREATED",
    data: {
      kind: input.kind,
      deadlineSeconds,
      provider: "FIXTURE",
      preAuthorized: plan.committed.map((k) => person(k).displayName),
      injectedFailures: plan.failures.map((f) => ({ participant: person(f.key).displayName, operation: f.operation, mode: f.mode })),
    },
  });

  return {
    outingId,
    kind: input.kind,
    title,
    deadlineAt: deadlineAt.toISOString(),
    deadlineSeconds,
    serverNow: new Date().toISOString(),
    personas: cast.map((c) => {
      const p = person(c.key);
      return { participantId: p.id, displayName: p.displayName, role: p.role, payerType: p.payerType, note: plan.notes[c.key] ?? "" };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Status (for the demo hub and the "process due work" button)                */
/* -------------------------------------------------------------------------- */

export type OperationCounts = Record<OperationKind, Partial<Record<OperationStatus, number>>>;

export interface DemoScenarioStatus {
  outingId: string;
  title: string;
  kind: DemoScenarioKind | null;
  status: OutingStatus;
  cleanup: CleanupState;
  cancelReasons: string[];
  deadlineAt: string | null;
  serverNow: string;
  payers: { total: number; committed: number };
  /** Per-participant live state (fixture people only): payers who hold a verified, on-time authorization. */
  personas: { participantId: string; committed: boolean }[];
  operations: OperationCounts;
  capturedMinor: number;
  refundedMinor: number;
  /** One plain-language sentence describing where the outing is. */
  headline: string;
}

function headlineFor(s: Omit<DemoScenarioStatus, "headline">, nowMs: number): string {
  const ops = s.operations;
  switch (s.status) {
    case "COLLECTING": {
      const due = s.deadlineAt !== null && Date.parse(s.deadlineAt) <= nowMs;
      return due
        ? "The deadline has passed. The guest list is locked and the booking is settled within moments."
        : `Collecting: ${s.payers.committed} of ${s.payers.total} payers hold their maximum. Nothing is settled before the deadline.`;
    }
    case "SETTLING":
      return "Settling: collecting each exact share, one at a time.";
    case "CONFIRMED":
      return `Confirmed: ${ops.CAPTURE.SUCCEEDED ?? 0} shares collected, ${formatMoney(s.capturedMinor)} in total (simulated).`;
    case "COMPENSATING":
      return "Recovering: a payment failed, so the remaining holds are released and the shares already collected are refunded.";
    case "CANCELLING":
    case "CANCELLED": {
      if (s.cancelReasons.includes("CAPTURE_FAILED")) {
        if (s.cleanup === "COMPLETE") return `Not confirmed: a payment failed. All ${formatMoney(s.refundedMinor)} collected was refunded and every other hold released (simulated).`;
        if (s.cleanup === "NEEDS_ATTENTION") return "Not confirmed: a payment failed, and a refund or hold release needs someone to look at it.";
        return "Not confirmed: a payment failed. Completed payments are being refunded.";
      }
      if (s.cleanup === "COMPLETE" || s.cleanup === "NONE") return "Cancelled at the deadline: no booking payment collected, every hold released (simulated).";
      if (s.cleanup === "NEEDS_ATTENTION") return "Cancelled: a hold release needs someone to look at it.";
      return "Cancelled at the deadline: releasing every hold.";
    }
    default:
      return `Outing is ${s.status.toLowerCase()}.`;
  }
}

/** Status of a FIXTURE outing (null for unknown or real outings). */
export async function demoScenarioStatus(db: Db, outingId: string, now: Date = new Date()): Promise<DemoScenarioStatus | null> {
  const outing = await db.query.outings.findFirst({ where: and(eq(outings.id, outingId), eq(outings.isFixture, true)) });
  if (!outing) return null;
  const people = await db.query.participants.findMany({ where: eq(participants.outingId, outing.id) });
  const attempts = await db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, outing.id) });
  const ops = await db.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, outing.id) });

  const payerIds = new Set(people.filter((p) => p.payerType === "PAYER").map((p) => p.id));
  const committed = new Set(attempts.filter((a) => payerIds.has(a.participantId) && a.verified && !a.late && a.authorizationId).map((a) => a.participantId));
  const operations: OperationCounts = { CAPTURE: {}, VOID: {}, REFUND: {} };
  for (const op of ops) operations[op.kind][op.status] = (operations[op.kind][op.status] ?? 0) + 1;

  const base = {
    outingId: outing.id,
    title: outing.title,
    kind: scenarioKindOfTitle(outing.title),
    status: outing.status,
    cleanup: outing.cleanup,
    cancelReasons: outing.cancelReasons,
    deadlineAt: outing.deadlineAt?.toISOString() ?? null,
    serverNow: now.toISOString(),
    payers: { total: payerIds.size, committed: committed.size },
    personas: people.map((p) => ({ participantId: p.id, committed: committed.has(p.id) })),
    operations,
    capturedMinor: attempts.reduce((sum, a) => sum + a.capturedMinor, 0),
    refundedMinor: attempts.reduce((sum, a) => sum + a.refundedMinor, 0),
  };
  return { ...base, headline: headlineFor(base, now.getTime()) };
}

/* -------------------------------------------------------------------------- */
/* "Process due work now"                                                     */
/* -------------------------------------------------------------------------- */

/**
 * May POST /api/demo/tick run a worker pass without the CRON_SECRET bearer?
 *
 * Only in demo mode, and then only outside production unless
 * DEMO_ALLOW_PUBLIC_TICK=true. In a hosted demo the real worker / scheduler
 * (`npm run worker`, or a cron hitting /api/cron/tick with the secret) does
 * this on its own; the button only saves waiting for the next poll. It is
 * harmless to expose there because a tick only processes work that is
 * already due: the engine freezes and settles strictly against the stored
 * deadline using the database clock, so nobody can settle an outing early.
 */
export function demoTickAllowed(cfg: AppConfig = config(), env: Record<string, string | undefined> = process.env): boolean {
  if (!cfg.demoFixturesEnabled) return false;
  if (!cfg.isProduction) return true;
  const flag = env.DEMO_ALLOW_PUBLIC_TICK?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}
