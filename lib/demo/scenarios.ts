/**
 * One-click demo scenarios: a FRESH fixture outing whose commitment deadline is
 * minutes away, so the deadline settlement (and its failure handling) can be
 * watched live instead of waiting for the seeded ~2 h deadline.
 *
 * Honesty and realism
 * - Every scenario outing is `isFixture` and pays through the FIXTURE simulator
 *   ("Fixture — not real PayPal"), even when PayPal sandbox keys are configured.
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
import { outings, participants, paymentAttempts, paymentOperations, type Participant } from "../db/schema";
import { config, type AppConfig } from "../env";
import { recordAudit } from "../audit";
import { formatMoney } from "../domain/money";
import type { CleanupState, OperationKind, OperationStatus, OutingStatus, ParticipantRole, PayerType } from "../domain/types";
import { setFixtureFailure, type FixtureFailureMode, type FixtureOperation } from "../payments/fixture";
import { consent, openCollection, respond } from "../services/outings";
import { approveFixturePayment, startPayment } from "../services/payments";
import {
  DEMO_SCENARIO_DEADLINE_SECONDS,
  DEMO_SCENARIO_KINDS,
  DEMO_SCENARIO_TITLES,
  clampScenarioSeconds,
  type DemoScenarioKind,
} from "./constants";
import { nextLocalWeekdayAt, seedCatalogue, seedOuting, type PersonSpec } from "./seed";

export { DEMO_SCENARIO_DEADLINE_SECONDS, DEMO_SCENARIO_KINDS, DEMO_SCENARIO_TITLES, type DemoScenarioKind };

const MIN = 60_000;
const HOUR = 60 * MIN;

const BRIEF =
  "Karaoke for Maya's birthday on Friday evening! Six of us, ideally a private room. Let's cover Maya's share. Around $100 total, split fairly.";

type CastKey = "alex" | "ben" | "freya" | "jules" | "noor" | "maya";

/** Organizer + 4 payers + Maya (sponsored). sortKey order = capture order: Alex, Ben, Freya, Jules, Noor. */
const CAST: (PersonSpec & { key: CastKey })[] = [
  { key: "alex", name: "Alex", organizer: true, voteMinor: 10_000 },
  { key: "ben", name: "Ben", voteMinor: 10_000 },
  { key: "freya", name: "Freya", voteMinor: 7_500 },
  { key: "jules", name: "Jules", voteMinor: 15_000 },
  { key: "noor", name: "Noor", voteMinor: 10_000 },
  { key: "maya", name: "Maya", sponsored: true, voteMinor: 10_000 },
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
  notes: Record<CastKey, string>;
}

const HOLD = "Committed · $20 hold (fixture)";
const MAYA = "Sponsored guest · accepted · pays $0";

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
      noor: "Required payer who never commits: leave Noor alone and the deadline cancels the outing",
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
      alex: `Organizer · ${HOLD} · captured first, then refunded`,
      ben: `${HOLD} · captured, then refunded; the first refund response is lost (simulated timeout) and reconciled on the next pass`,
      freya: `${HOLD} · captured, then refunded`,
      jules: `${HOLD} · capture is declined by the simulator (injected failure), then the hold is released`,
      noor: `${HOLD} · capture skipped after the failure, hold released`,
      maya: MAYA,
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
  const now = input.now ?? new Date();
  const deadlineSeconds = clampScenarioSeconds(input.deadlineSeconds ?? DEMO_SCENARIO_DEADLINE_SECONDS.default);
  const deadlineAt = new Date(now.getTime() + deadlineSeconds * 1000);
  const title = DEMO_SCENARIO_TITLES[input.kind];

  // The canonical $100 fixed-total private karaoke room at The Sound Room (idempotent upsert).
  const { merchant, offerings: catalogue } = await seedCatalogue(db);
  const room = catalogue["private-karaoke-room"];

  // Brief -> budget poker -> reveal -> proposal history (FIXTURE parser/ranker), ending at PROPOSED.
  const seeded = await seedOuting(
    db,
    {
      key: `scenario-${input.kind}`,
      title,
      brief: BRIEF,
      status: "PROPOSED",
      createdAt: new Date(now.getTime() - 30 * MIN),
      people: CAST,
      proposal: { merchant, offering: room, proposedBudgetMinor: room.priceMinor },
    },
    input.secret ?? cfg.sessionSecret,
  );
  const outingId = seeded.outing.id;
  const person = (key: CastKey): Participant => seeded.people.get(key)!;
  const actor = (key: CastKey) => ({ outingId, participantId: person(key).id });

  // Real services from here: availability, deadline window, terms + hash (Maya sponsored, everyone
  // required), quote, SETTLE_DEADLINE job; then Maya's acceptance and each payer's consent + hold.
  const activityAt = nextLocalWeekdayAt(new Date(deadlineAt.getTime() + HOUR), 5, 19, merchant.timezone);
  const opened = await openCollection(db, actor("alex"), { activityAt, deadlineAt, minPayers: 5 }, now);
  await respond(db, actor("maya"), { response: "ACCEPT" }, now);

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
    personas: CAST.map((c) => {
      const p = person(c.key);
      return { participantId: p.id, displayName: p.displayName, role: p.role, payerType: p.payerType, note: plan.notes[c.key] };
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
        ? "The deadline has passed. The next worker pass freezes the roster and settles it."
        : `Collecting: ${s.payers.committed} of ${s.payers.total} payers hold their maximum. Nothing is settled before the deadline.`;
    }
    case "SETTLING":
      return "Settling: capturing each exact share, one at a time.";
    case "CONFIRMED":
      return `Confirmed: ${ops.CAPTURE.SUCCEEDED ?? 0} shares captured, ${formatMoney(s.capturedMinor)} in total (fixture).`;
    case "COMPENSATING":
      return "Recovering: a capture failed, so the remaining holds are released and captured shares refunded.";
    case "CANCELLING":
    case "CANCELLED": {
      if (s.cancelReasons.includes("CAPTURE_FAILED")) {
        if (s.cleanup === "COMPLETE") return `Not confirmed: a capture failed. All ${formatMoney(s.refundedMinor)} captured was refunded and every other hold released (fixture).`;
        if (s.cleanup === "NEEDS_ATTENTION") return "Not confirmed: a capture failed and a refund or release needs manual attention.";
        return "Not confirmed: a capture failed. Completed payments are being refunded.";
      }
      if (s.cleanup === "COMPLETE" || s.cleanup === "NONE") return "Cancelled at the deadline: no booking payment collected, every hold released (fixture).";
      if (s.cleanup === "NEEDS_ATTENTION") return "Cancelled: a hold release needs manual attention.";
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
