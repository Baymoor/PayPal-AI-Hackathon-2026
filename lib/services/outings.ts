/**
 * Organizer / participant operations on an outing.
 *
 * Every operation:
 * - re-loads and locks the outing row (`SELECT … FOR UPDATE`) and re-checks
 *   the caller's role inside the transaction (routes authorize first; this is
 *   defence in depth),
 * - validates the lifecycle with lib/domain/state-machine.ts,
 * - uses SERVER time (`now`, defaulting to `new Date()`), never client time,
 * - writes an audit event without private data (display names only; never
 *   budget vote amounts, tokens or provider payloads),
 * - records every AI call in `ai_runs` with its honest source.
 *
 * AI output is advisory: it can title a brief, summarise an aggregate, or
 * rank OUR catalogue. It never sets a price, cap, deadline, payer or policy.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "../db/client";
import {
  aiRuns,
  budgetVotes,
  consents,
  jobs,
  offerings,
  outings,
  participants,
  paymentAttempts,
  quoteVersions,
  type Outing,
  type Participant,
  type QuoteVersion,
} from "../db/schema";
import { config } from "../env";
import { ServiceError, badRequest, conflict, forbidden, notFound } from "../http";
import { recordAudit, type AuditActor } from "../audit";
import { generateInviteToken, hashToken } from "../auth/tokens";
import { enqueueJob, settleJobKey } from "../jobs/queue";
import { assertOutingTransition } from "../domain/state-machine";
import { buildCommitmentTerms, hashTerms, validateCommitmentDeadline, isBeforeDeadline } from "../domain/policy";
import { assertCurrency, formatMoney } from "../domain/money";
import {
  DEFAULT_BUDGET_OPTIONS_MINOR,
  LEGACY_TOTAL_OPTIONS_MINOR,
  MAX_BUDGET_MINOR,
  chooseBudgetOptions,
  validateBudgetOptions,
  type BudgetOptionsBasis,
} from "../domain/budget-options";
import { budgetFit, comparableCostMinor, headcountOf, perPersonShareMinor, type Headcount } from "../domain/budget-fit";
import {
  MIN_VOTES_FOR_REVEAL,
  type AttendanceState,
  type BudgetUnit,
  type OutingStatus,
  type PayerType,
} from "../domain/types";
import { getOutingsAi } from "../ai";
import {
  PlanDraftSchema,
  ProposalSchema,
  RevealSummarySchema,
  type AiResult,
  type AiSource,
  type BriefExtraction,
  type CatalogueItemForAi,
  type OutingsAi,
  type PlanCatalogueItem,
  type PlanDraftInput,
  type PlanDraftResponse,
  type PlanRosterEntry,
  type Proposal,
  type RevealAggregate,
} from "../ai/types";
import { validatePlanDraft } from "../ai/validate";
import { takeToken, type RateLimitRule } from "../rate-limit";
import {
  catalogueCategories,
  checkAvailability,
  getActiveOfferingWithMerchant,
  listActiveOfferings,
  toCatalogueForAi,
  type CatalogueEntry,
} from "./catalogue";

/* -------------------------------------------------------------------------- */
/* Constants and stored JSON shapes                                           */
/* -------------------------------------------------------------------------- */

/**
 * Default PER-PERSON budget-poker options (minor units). Every outing stores
 * its own options at creation (`budgetOptionsFor`); this list is only the
 * last-resort fallback.
 */
export const BUDGET_OPTIONS_MINOR = DEFAULT_BUDGET_OPTIONS_MINOR;
/** $100,000 — upper bound for any budget vote / agreed budget (defined with the budget-option rules). */
export { MAX_BUDGET_MINOR };
export const MAX_BRIEF_CHARS = 2000;
export const MAX_NAME_CHARS = 40;
export const MAX_PARTICIPANTS = 50;
export const MAX_INVITES_PER_REQUEST = 20;
/** Quote stays valid this long after the deadline (>= QUOTE_SETTLEMENT_GRACE_MS). */
export const QUOTE_VALIDITY_AFTER_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEZONE = "Europe/Copenhagen";

/**
 * Budget-poker vote amounts fixed when the outing is created, with provenance.
 * Never a price or a payment: votes stay any amount up to MAX_BUDGET_MINOR.
 */
export interface StoredBudgetOptions {
  /** Five strictly increasing amounts in the outing's budget unit, integer minor units (validated). */
  optionsMinor: number[];
  /** AI_SUGGESTION, or which deterministic ladder anchor the app used. */
  basis: BudgetOptionsBasis;
  /** Who suggested the amounts: the AI's honest source for AI_SUGGESTION; null when app rules computed them. */
  source: AiSource | null;
  model: string | null;
  /** Middle amount of the deterministic ladder (null for an AI suggestion). */
  anchorMinor: number | null;
  /** Why an AI suggestion was not used, in plain language. */
  notes: string[];
}

/** outings.brief_extraction */
export interface StoredBriefExtraction {
  extraction: BriefExtraction | null;
  source: AiSource | null;
  model: string | null;
  warnings: string[];
  error: string | null;
  createdAt: string;
  /** Absent on outings created before vote amounts were stored; they use LEGACY_TOTAL_OPTIONS_MINOR. */
  budgetOptions?: StoredBudgetOptions;
}

/** outings.budget_reveal — aggregate only, never names or who cast which vote. */
export interface StoredReveal {
  round: number;
  aggregate: RevealAggregate;
  summary: {
    headline: string;
    summary: string;
    /** In the aggregate's unit. Reveals stored before per-person voting carry `suggestedTotalMinor` instead. */
    suggestedAmountMinor: number;
    suggestedTotalMinor?: number;
    source: AiSource;
    model: string | null;
    /** Set when we overrode the AI (e.g. suggestion outside the vote range). */
    note: string | null;
  } | null;
  revealedAt: string;
}

/** outings.proposal — ranking of OUR catalogue; prices are never stored from AI. */
export interface StoredProposal {
  ranked: Proposal["ranked"];
  note: string;
  source: AiSource;
  model: string | null;
  warnings: string[];
  budgetMinor: number;
  createdAt: string;
}

export interface ParticipantActor {
  outingId: string;
  participantId: string;
}

/* -------------------------------------------------------------------------- */
/* Input schemas (shared by route handlers and tests)                         */
/* -------------------------------------------------------------------------- */

const amountMinor = z.number().int().positive().max(MAX_BUDGET_MINOR);

export const CreateOutingInput = z.object({
  organizerName: z.string().min(1).max(200),
  brief: z.string().max(MAX_BRIEF_CHARS * 2),
});
export const AddInviteesInput = z.object({
  names: z.array(z.string().max(200)).min(1).max(MAX_INVITES_PER_REQUEST),
  required: z.boolean().optional(),
});
export const VoteInput = z.object({ amountMinor });
export const AgreeBudgetInput = z.object({ amountMinor });
export const SelectOfferingInput = z.object({ offeringId: z.string().uuid() });
export const PatchParticipantInput = z
  .object({ payerType: z.enum(["PAYER", "SPONSORED"]).optional(), required: z.boolean().optional() })
  .refine((v) => v.payerType !== undefined || v.required !== undefined, "Nothing to change");
export const OpenCollectionInput = z.object({
  activityAt: z.string().datetime({ offset: true }),
  deadlineAt: z.string().datetime({ offset: true }),
  minPayers: z.number().int().min(1).max(MAX_PARTICIPANTS),
});
export const RespondInput = z.object({ response: z.enum(["ACCEPT", "DECLINE"]) });
export const ConsentInput = z.object({ termsHash: z.string().regex(/^[0-9a-f]{64}$/i, "termsHash must be the hash you reviewed") });

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const INACTIVE_ATTENDANCE: readonly AttendanceState[] = ["DECLINED", "WITHDRAWN"];
export const isActiveParticipant = (p: Pick<Participant, "attendance">) => !INACTIVE_ATTENDANCE.includes(p.attendance);
export const PRE_COLLECTION: readonly OutingStatus[] = ["DRAFT", "BUDGETING", "PROPOSED"];
export const isPreCollection = (status: OutingStatus) => PRE_COLLECTION.includes(status);

/** COLLECTING, roster not frozen, and server time before the deadline. */
export function collectionWindowOpen(outing: Pick<Outing, "status" | "frozenAt" | "deadlineAt">, now: Date): boolean {
  return outing.status === "COLLECTING" && !outing.frozenAt && !!outing.deadlineAt && isBeforeDeadline(now, outing.deadlineAt);
}

const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g");

/** Display names: no control/bidi characters, collapsed whitespace, 1..40 chars. */
export function normalizeDisplayName(raw: string): string {
  const name = raw.replace(CONTROL_CHARS, "").replace(/[\s\n\r\t]+/g, " ").trim();
  if (name.length < 1) throw badRequest("INVALID_NAME", "Please enter a name");
  if (name.length > MAX_NAME_CHARS) throw badRequest("INVALID_NAME", `Names can be at most ${MAX_NAME_CHARS} characters`);
  return name;
}

export function normalizeBrief(raw: string): string {
  const brief = raw.replace(CONTROL_CHARS, "").replace(/\r\n?/g, "\n").trim();
  if (brief.length < 3) throw badRequest("INVALID_BRIEF", "Tell us a little about the plan");
  if (brief.length > MAX_BRIEF_CHARS) throw badRequest("BRIEF_TOO_LONG", `Keep the brief under ${MAX_BRIEF_CHARS} characters`);
  return brief;
}

const unprocessable = (code: string, msg: string) => new ServiceError(code, 422, msg);

function assertBudgetAmount(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BUDGET_MINOR) {
    throw badRequest("INVALID_AMOUNT", `${label} must be a whole number of cents between 1 and ${MAX_BUDGET_MINOR}`);
  }
  return value;
}

function inviteLink(token: string): string {
  return `${config().appBaseUrl.replace(/\/+$/, "")}/i/${token}`;
}

/** The exact commit copy stored with the consent (PRODUCT_SPEC §6). */
export function commitStatement(capMinor: number, currency: string): string {
  return `Authorize up to ${formatMoney(capMinor, assertCurrency(currency))}. Your final share may be lower. We collect it only if the agreed group booking is confirmed.`;
}

const actorOf = (participantId: string): AuditActor => `PARTICIPANT:${participantId}`;

async function lockOuting(tx: Tx, outingId: string): Promise<Outing> {
  const rows = await tx.select().from(outings).where(eq(outings.id, outingId)).for("update");
  if (!rows[0]) throw notFound("Outing not found");
  return rows[0];
}

async function loadParticipant(tx: DbOrTx, outingId: string, participantId: string): Promise<Participant> {
  const p = await tx.query.participants.findFirst({
    where: and(eq(participants.id, participantId), eq(participants.outingId, outingId)),
  });
  if (!p) throw forbidden("You are not part of this outing");
  return p;
}

async function loadRoster(tx: DbOrTx, outingId: string): Promise<Participant[]> {
  return tx.query.participants.findMany({ where: eq(participants.outingId, outingId), orderBy: [asc(participants.sortKey)] });
}

/** Lock the outing and load the caller; optionally require the organizer role. */
async function begin(tx: Tx, actor: ParticipantActor, opts: { organizer?: boolean } = {}) {
  const outing = await lockOuting(tx, actor.outingId);
  const me = await loadParticipant(tx, outing.id, actor.participantId);
  if (opts.organizer && me.role !== "ORGANIZER") throw forbidden("Only the organizer can do this");
  return { outing, me };
}

function requireStatus(outing: Outing, allowed: readonly OutingStatus[], message: string): void {
  if (!allowed.includes(outing.status)) throw conflict("INVALID_STATE", message);
}

/** Status change with lifecycle validation and an optimistic version bump. */
async function transition(tx: Tx, outing: Outing, to: OutingStatus, now: Date, extra: Partial<typeof outings.$inferInsert> = {}) {
  assertOutingTransition(outing.status, to);
  const updated = await tx
    .update(outings)
    .set({ ...extra, status: to, version: outing.version + 1, updatedAt: now })
    .where(and(eq(outings.id, outing.id), eq(outings.version, outing.version)))
    .returning({ id: outings.id });
  if (updated.length !== 1) throw conflict("CONCURRENT_UPDATE", "The outing changed at the same time. Please try again.");
}

async function touch(tx: Tx, outing: Outing, now: Date, extra: Partial<typeof outings.$inferInsert> = {}) {
  await tx
    .update(outings)
    .set({ ...extra, version: outing.version + 1, updatedAt: now })
    .where(eq(outings.id, outing.id));
}

/* ------------------------------- AI plumbing -------------------------------- */

type AiCall<T> = { ok: true; result: AiResult<T> } | { ok: false; source: string; error: string };

async function callAi<T>(fn: (ai: OutingsAi) => Promise<AiResult<T>>): Promise<AiCall<T>> {
  let source: string = config().aiMode;
  try {
    const ai = getOutingsAi();
    source = ai.source;
    return { ok: true, result: await fn(ai) };
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, source, error: `${name}: ${message}`.replace(CONTROL_CHARS, " ").slice(0, 300) };
  }
}

async function recordAiRun(
  db: DbOrTx,
  input: { outingId: string | null; purpose: string; call: AiCall<unknown>; output?: unknown },
): Promise<void> {
  const { call } = input;
  await db.insert(aiRuns).values({
    outingId: input.outingId,
    purpose: input.purpose,
    source: call.ok ? call.result.source : call.source,
    model: call.ok ? call.result.model : null,
    ok: call.ok,
    error: call.ok ? null : call.error,
    output: call.ok ? ((input.output ?? call.result.output) as object) : null,
  });
}

/** Minimal, honest stand-in when the brief could not be read by the AI. */
function fallbackExtraction(outing: Outing): BriefExtraction {
  return {
    title: outing.title.slice(0, 80) || "Group outing",
    activityIdeas: [],
    categories: [],
    dateWindow: { description: "", dayOfWeek: null, partOfDay: null },
    groupSize: { count: null, isEstimate: false },
    budget: { amountMinor: null, unit: "UNKNOWN" },
    guestOfHonour: { name: null, coverTheirShare: false },
    prefersFixedTotal: true,
    needs: [],
    uncertainties: [],
    summary: [{ icon: "note", text: "No AI reading of the brief is available." }],
  };
}

export function storedExtraction(outing: Pick<Outing, "briefExtraction">): StoredBriefExtraction | null {
  const v = outing.briefExtraction as StoredBriefExtraction | null;
  return v && typeof v === "object" && "extraction" in v ? v : null;
}

/**
 * The budget-poker vote amounts for this outing: the stored options when they
 * still pass the rules (stored JSON is re-checked, never trusted), else the
 * default list for the outing's unit (TOTAL outings predate stored options).
 */
export function budgetOptionsFor(outing: Pick<Outing, "briefExtraction" | "budgetUnit">): number[] {
  const stored = storedExtraction(outing)?.budgetOptions?.optionsMinor;
  const check = validateBudgetOptions(stored);
  if (check.ok) return check.optionsMinor;
  return [...(outing.budgetUnit === "PER_PERSON" ? BUDGET_OPTIONS_MINOR : LEGACY_TOTAL_OPTIONS_MINOR)];
}

/**
 * Decide the per-person vote amounts once, at creation: the AI's validated
 * suggestion, else the deterministic ladder anchored on the brief's budget or
 * on what the matching catalogue costs per person. Provenance says which;
 * FIXTURE stays FIXTURE.
 */
function decideBudgetOptions(call: AiCall<BriefExtraction>, catalogue: readonly CatalogueEntry[]): StoredBudgetOptions {
  const extraction = call.ok ? call.result.output : null;
  const decision = chooseBudgetOptions({
    suggestionMinor: extraction?.suggestedVotePerPersonMinor ?? null,
    stated: extraction?.budget ?? { amountMinor: null, unit: "UNKNOWN" },
    groupSize: extraction?.groupSize.count ?? null,
    coversGuest: extraction?.guestOfHonour.coverTheirShare ?? false,
    categories: extraction?.categories ?? [],
    catalogue: catalogue.map(({ offering }) => ({ category: offering.category, pricingModel: offering.pricingModel, priceMinor: offering.priceMinor })),
  });
  const fromAi = decision.basis === "AI_SUGGESTION" && call.ok;
  return {
    optionsMinor: decision.optionsMinor,
    basis: decision.basis,
    source: fromAi ? call.result.source : null,
    model: fromAi ? call.result.model : null,
    anchorMinor: decision.anchorMinor,
    notes: decision.notes,
  };
}

export function storedReveal(outing: Pick<Outing, "budgetReveal">): StoredReveal | null {
  const v = outing.budgetReveal as StoredReveal | null;
  return v && typeof v === "object" && "aggregate" in v ? v : null;
}
export function storedProposal(outing: Pick<Outing, "proposal">): StoredProposal | null {
  const v = outing.proposal as StoredProposal | null;
  return v && typeof v === "object" && Array.isArray(v.ranked) ? v : null;
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateOutingResult {
  outingId: string;
  participantId: string;
}

export async function createOuting(
  db: Db,
  input: { organizerName: string; brief: string },
  now: Date = new Date(),
): Promise<CreateOutingResult> {
  const organizerName = normalizeDisplayName(input.organizerName);
  const brief = normalizeBrief(input.brief);

  // The brief is untrusted DATA. It is only ever passed to the AI as content to
  // interpret; nothing it says can change prices, caps, payers or policy.
  const catalogue = await listActiveOfferings(db);
  const categories = catalogueCategories(catalogue);
  const extractInput: Parameters<OutingsAi["extractBrief"]>[0] & { categories?: string[] } = {
    brief,
    now,
    timezone: DEFAULT_TIMEZONE,
    categories,
  };
  const call = await callAi((ai) => ai.extractBrief(extractInput));
  const extraction = call.ok ? call.result.output : null;
  const stored: StoredBriefExtraction = {
    extraction,
    source: call.ok ? call.result.source : null,
    model: call.ok ? call.result.model : null,
    warnings: call.ok ? call.result.warnings.slice(0, 10) : [],
    error: call.ok ? null : "The brief could not be read automatically.",
    createdAt: now.toISOString(),
    budgetOptions: decideBudgetOptions(call, catalogue),
  };
  const title = (extraction?.title ?? "").replace(CONTROL_CHARS, "").trim().slice(0, 80) || `${organizerName}'s outing`;

  return db.transaction(async (tx) => {
    const [outing] = await tx
      .insert(outings)
      .values({
        title,
        brief,
        briefExtraction: stored,
        status: "DRAFT",
        currency: "USD",
        // Everyone votes on what they would personally pay; the app relates that to each offering's price.
        budgetUnit: "PER_PERSON",
        displayTimezone: DEFAULT_TIMEZONE,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [organizer] = await tx
      .insert(participants)
      .values({
        outingId: outing.id,
        displayName: organizerName,
        role: "ORGANIZER",
        payerType: "PAYER",
        required: true,
        sortKey: 1,
        attendance: "ACCEPTED",
        attendanceAt: now,
        // The organizer's session is set directly; this token is never revealed.
        inviteTokenHash: hashToken(generateInviteToken()),
      })
      .returning();
    await recordAiRun(tx, { outingId: outing.id, purpose: "BRIEF_EXTRACTION", call });
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(organizer.id),
      type: "OUTING_CREATED",
      data: { organizerName, aiSource: stored.source, aiOk: call.ok, budgetOptionsBasis: stored.budgetOptions?.basis ?? null },
    });
    return { outingId: outing.id, participantId: organizer.id };
  });
}

/* -------------------------------------------------------------------------- */
/* Budget poker                                                               */
/* -------------------------------------------------------------------------- */

export async function startBudget(db: Db, actor: ParticipantActor, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["DRAFT"], "Budget poker has already started");
    await transition(tx, outing, "BUDGETING", now);
    await recordAudit(tx, { outingId: outing.id, actor: actorOf(me.id), type: "BUDGET_STARTED", data: { round: outing.budgetRound } });
  });
}

export interface InviteResult {
  participantId: string;
  displayName: string;
  /** Plaintext link — returned exactly once; only the token hash is stored. */
  link: string;
}

/** Capacity that applies to the roster right now (quote > selected offering > none). */
async function currentCapacity(tx: DbOrTx, outing: Outing): Promise<number | null> {
  if (outing.currentQuoteId) {
    const q = await tx.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId) });
    if (q) return q.capacity;
  }
  if (outing.maxAttendees) return outing.maxAttendees;
  if (outing.selectedOfferingId) {
    const o = await tx.query.offerings.findFirst({ where: eq(offerings.id, outing.selectedOfferingId) });
    if (o) return o.capacity;
  }
  return null;
}

export async function addInvitees(
  db: Db,
  actor: ParticipantActor,
  input: { names: string[]; required?: boolean },
  now: Date = new Date(),
): Promise<{ invites: InviteResult[] }> {
  const names = input.names.map(normalizeDisplayName);
  if (names.length === 0) throw badRequest("INVALID_INPUT", "Add at least one name");
  if (names.length > MAX_INVITES_PER_REQUEST) throw badRequest("INVALID_INPUT", `Add at most ${MAX_INVITES_PER_REQUEST} people at once`);

  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["DRAFT", "BUDGETING", "PROPOSED", "COLLECTING"], "Invitations are closed for this outing");

    let required = input.required ?? true;
    if (outing.status === "COLLECTING") {
      if (!collectionWindowOpen(outing, now)) throw conflict("DEADLINE_PASSED", "The commitment deadline has passed");
      // Required invitees would change the agreed terms; optional ones only lower shares and never block.
      if (input.required === true) {
        throw conflict("ONLY_OPTIONAL_DURING_COLLECTION", "While collecting, you can only add optional invitees. They can lower shares but never block the booking.");
      }
      required = false;
    }

    const roster = await loadRoster(tx, outing.id);
    if (roster.length + names.length > MAX_PARTICIPANTS) {
      throw conflict("TOO_MANY_PARTICIPANTS", `An outing can have at most ${MAX_PARTICIPANTS} people`);
    }
    const capacity = await currentCapacity(tx, outing);
    const active = roster.filter(isActiveParticipant).length;
    if (capacity !== null && active + names.length > capacity) {
      throw conflict("CAPACITY_EXCEEDED", `This booking fits ${capacity} people; ${active} are already invited`);
    }

    let nextSortKey = roster.reduce((m, p) => Math.max(m, p.sortKey), 0) + 1;
    const invites: InviteResult[] = [];
    for (const displayName of names) {
      const token = generateInviteToken();
      const [p] = await tx
        .insert(participants)
        .values({
          outingId: outing.id,
          displayName,
          role: "INVITEE",
          payerType: "PAYER",
          required,
          sortKey: nextSortKey++,
          attendance: "PENDING",
          inviteTokenHash: hashToken(token),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      invites.push({ participantId: p.id, displayName, link: inviteLink(token) });
    }
    await touch(tx, outing, now);
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "INVITEES_ADDED",
      data: { count: invites.length, required, displayNames: names },
    });
    return { invites };
  });
}

export async function vote(db: Db, actor: ParticipantActor, input: { amountMinor: number }, now: Date = new Date()): Promise<void> {
  const amount = assertBudgetAmount(input.amountMinor, "Budget vote");
  await db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor);
    requireStatus(outing, ["BUDGETING"], "Budget voting is not open");
    if (outing.budgetRevealedAt) throw conflict("ALREADY_REVEALED", "Votes for this round have been revealed. The organizer can start a new round.");
    if (!isActiveParticipant(me)) throw conflict("NOT_ATTENDING", "You declined this outing");
    // Upsert the caller's OWN vote only: participantId comes from the session, never the body.
    await tx
      .insert(budgetVotes)
      // A vote is always in the outing's own unit, so one round never mixes per-person and total amounts.
      .values({ outingId: outing.id, participantId: me.id, round: outing.budgetRound, amountMinor: amount, unit: outing.budgetUnit, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [budgetVotes.outingId, budgetVotes.participantId, budgetVotes.round],
        set: { amountMinor: amount, updatedAt: now },
      });
    // Never record the amount in the audit trail.
    await recordAudit(tx, { outingId: outing.id, actor: actorOf(me.id), type: "BUDGET_VOTE_CAST", data: { round: outing.budgetRound } });
  });
}

/** Aggregate-only summary of a set of votes cast in one unit (no names, no mapping from vote to voter). */
export function aggregateVotes(amounts: readonly number[], invitedCount: number, currency: string, unit: BudgetUnit): RevealAggregate {
  if (amounts.length === 0) throw new Error("no votes to aggregate");
  const sorted = [...amounts].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (const a of sorted) counts.set(a, (counts.get(a) ?? 0) + 1);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : Math.floor((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  return {
    unit,
    currency,
    voteCount: n,
    invitedCount: Math.max(invitedCount, n),
    buckets: [...counts.entries()].map(([amountMinor, count]) => ({ amountMinor, count })),
    minMinor: sorted[0],
    maxMinor: sorted[n - 1],
    medianMinor: median,
  };
}

async function computeAggregate(tx: DbOrTx, outing: Outing): Promise<RevealAggregate | null> {
  const rows = await tx
    .select({ amountMinor: budgetVotes.amountMinor })
    .from(budgetVotes)
    .where(and(eq(budgetVotes.outingId, outing.id), eq(budgetVotes.round, outing.budgetRound), eq(budgetVotes.unit, outing.budgetUnit)));
  if (rows.length < MIN_VOTES_FOR_REVEAL) return null;
  const roster = await loadRoster(tx, outing.id);
  return aggregateVotes(
    rows.map((r) => r.amountMinor),
    roster.filter(isActiveParticipant).length,
    outing.currency,
    outing.budgetUnit,
  );
}

export async function reveal(db: Db, actor: ParticipantActor, now: Date = new Date()): Promise<StoredReveal> {
  // Pre-check (cheap, no lock) so we do not call the AI for an invalid request.
  const pre = await db.transaction(async (tx) => {
    const { outing } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["BUDGETING"], "Budget voting is not open");
    if (outing.budgetRevealedAt) throw conflict("ALREADY_REVEALED", "This round has already been revealed");
    const aggregate = await computeAggregate(tx, outing);
    if (!aggregate) {
      throw conflict("NOT_ENOUGH_VOTES", `At least ${MIN_VOTES_FOR_REVEAL} votes are needed so no single vote is exposed`);
    }
    return { aggregate, extraction: storedExtraction(outing)?.extraction ?? null };
  });

  // The AI sees the aggregate only (no names, no per-person votes).
  const call = await callAi((ai) => ai.summarizeReveal({ aggregate: pre.aggregate, extraction: pre.extraction }));

  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["BUDGETING"], "Budget voting is not open");
    if (outing.budgetRevealedAt) throw conflict("ALREADY_REVEALED", "This round has already been revealed");
    // Recompute under the lock: votes are serialized on the same row lock.
    const aggregate = await computeAggregate(tx, outing);
    if (!aggregate) throw conflict("NOT_ENOUGH_VOTES", `At least ${MIN_VOTES_FOR_REVEAL} votes are needed`);

    let summary: StoredReveal["summary"] = null;
    if (call.ok) {
      const parsed = RevealSummarySchema.safeParse(call.result.output);
      if (parsed.success) {
        let suggested = parsed.data.suggestedAmountMinor;
        let note: string | null = null;
        if (suggested < aggregate.minMinor || suggested > aggregate.maxMinor) {
          suggested = aggregate.medianMinor;
          note = "The AI suggestion was outside the range of votes, so the median vote is shown instead.";
        }
        summary = {
          headline: parsed.data.headline,
          summary: parsed.data.summary,
          suggestedAmountMinor: suggested,
          source: call.result.source,
          model: call.result.model,
          note,
        };
      }
    }
    const stored: StoredReveal = { round: outing.budgetRound, aggregate, summary, revealedAt: now.toISOString() };
    await touch(tx, outing, now, { budgetRevealedAt: now, budgetReveal: stored });
    await recordAiRun(tx, { outingId: outing.id, purpose: "BUDGET_REVEAL_SUMMARY", call, output: summary ?? undefined });
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "BUDGET_REVEALED",
      data: { round: outing.budgetRound, voteCount: aggregate.voteCount },
    });
    return stored;
  });
}

export async function newRound(db: Db, actor: ParticipantActor, now: Date = new Date()): Promise<{ round: number }> {
  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["BUDGETING", "PROPOSED"], "A new budget round is only possible before collection opens");
    const round = outing.budgetRound + 1;
    const reset = {
      budgetRound: round,
      budgetRevealedAt: null,
      budgetReveal: null,
      proposedBudgetMinor: null,
      proposal: null,
      selectedOfferingId: null,
    };
    if (outing.status === "PROPOSED") await transition(tx, outing, "BUDGETING", now, reset);
    else await touch(tx, outing, now, reset);
    await recordAudit(tx, { outingId: outing.id, actor: actorOf(me.id), type: "BUDGET_ROUND_STARTED", data: { round } });
    return { round };
  });
}

/** The amount the organizer agreed and what it means; outings created before per-person voting agreed a TOTAL. */
interface AgreedBudget {
  amountMinor: number;
  unit: BudgetUnit;
}

/** Who is coming and who pays right now: everyone who has not declined, minus the sponsored guest. */
function rosterHeadcount(active: readonly Pick<Participant, "payerType">[]): Headcount {
  return headcountOf(Math.max(1, active.length), active.filter((p) => p.payerType === "SPONSORED").length);
}

/**
 * The headcount to rank against: the live roster once anyone is invited, else
 * what the brief says (its group size, minus a guest whose share the group
 * covers). Null when the organizer is alone and the brief gives no size.
 */
function rankingHeadcount(roster: Headcount, extraction: BriefExtraction): Headcount | null {
  if (roster.attendees > 1) return roster;
  const stated = extraction.groupSize.count;
  if (stated === null) return null;
  return headcountOf(stated, extraction.guestOfHonour.coverTheirShare ? 1 : 0);
}

/** Adds the application's own per-person share to each item, so the ranker compares it and never computes one. */
function withPerPersonShares(catalogue: CatalogueItemForAi[], headcount: Headcount | null, unit: BudgetUnit): CatalogueItemForAi[] {
  if (unit !== "PER_PERSON") return catalogue;
  return catalogue.map((c) => ({ ...c, perPersonShareMinor: headcount ? perPersonShareMinor(c, headcount) : null }));
}

/** Deterministic, clearly-labelled ranking used only when the AI call failed. */
function deterministicProposal(
  catalogue: ReturnType<typeof toCatalogueForAi>,
  budget: AgreedBudget,
  headcount: Headcount,
  invitedCount: number,
): Proposal {
  const ranked = catalogue
    .filter((c) => c.capacity >= invitedCount)
    .map((c) => {
      const fixed = c.pricingModel === "FIXED_TOTAL";
      const fit = budgetFit(comparableCostMinor(c, headcount, budget.unit), budget.amountMinor);
      // Only a fixed total can be shared, so a per-attendee offering is never more than a stretch.
      const within = fixed && fit.kind === "WITHIN";
      // A per-person comparison is shown live on the venue card (services/views.ts), so no sentence is frozen here for it.
      const concerns = fit.kind === "OVER" && budget.unit === "TOTAL" ? ["Above the agreed budget."] : [];
      if (!fixed) concerns.push("Priced per attendee, so the total grows with each person who joins.");
      return {
        offeringId: c.offeringId,
        fit: (within ? "GOOD" : "STRETCH") as Proposal["ranked"][number]["fit"],
        reasons: [`Fits up to ${c.capacity} people.`, fixed ? "Fixed total: more attendees lower each share." : "Listed for comparison."],
        concerns,
        score: (within ? 2 : 0) + (fixed ? 1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => ({ offeringId: r.offeringId, fit: r.fit, reasons: r.reasons, concerns: r.concerns }));
  return { ranked, note: "AI ranking was unavailable, so offerings are listed by capacity and budget fit." };
}

export async function agreeBudget(
  db: Db,
  actor: ParticipantActor,
  input: { amountMinor: number },
  now: Date = new Date(),
): Promise<StoredProposal> {
  const budgetMinor = assertBudgetAmount(input.amountMinor, "Agreed budget");
  const pre = await db.transaction(async (tx) => {
    const { outing } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["BUDGETING", "PROPOSED"], "The budget can only be agreed before collection opens");
    const active = (await loadRoster(tx, outing.id)).filter(isActiveParticipant);
    return { outing, groupSize: active.length, roster: rosterHeadcount(active) };
  });

  const entries = await listActiveOfferings(db);
  const catalogue = toCatalogueForAi(entries);
  const extraction = storedExtraction(pre.outing)?.extraction ?? fallbackExtraction(pre.outing);
  const budget: AgreedBudget = { amountMinor: budgetMinor, unit: pre.outing.budgetUnit };
  const headcount = rankingHeadcount(pre.roster, extraction);
  const call = await callAi((ai) =>
    ai.proposeOfferings({
      extraction,
      catalogue: withPerPersonShares(catalogue, headcount, budget.unit),
      agreedBudgetMinor: budget.amountMinor,
      budgetUnit: budget.unit,
      groupSize: headcount?.attendees ?? null,
      payerCount: headcount?.payers ?? null,
    }),
  );

  // Keep only offerings that exist in OUR active catalogue and fit the group.
  const byId = new Map(catalogue.map((c) => [c.offeringId, c]));
  const warnings: string[] = [];
  let source: AiSource;
  let model: string | null;
  let proposal: Proposal;
  const parsed = call.ok ? ProposalSchema.safeParse(call.result.output) : null;
  if (call.ok && parsed?.success) {
    source = call.result.source;
    model = call.result.model;
    warnings.push(...call.result.warnings.slice(0, 10));
    const seen = new Set<string>();
    const ranked: Proposal["ranked"] = [];
    for (const r of parsed.data.ranked) {
      const item = byId.get(r.offeringId);
      if (!item) {
        warnings.push("Dropped an offering that is not in the catalogue.");
        continue;
      }
      if (seen.has(r.offeringId)) continue;
      if (item.capacity < pre.groupSize) {
        warnings.push(`Dropped ${item.name}: fits ${item.capacity}, the group has ${pre.groupSize}.`);
        continue;
      }
      seen.add(r.offeringId);
      ranked.push(r);
    }
    proposal = { ranked, note: parsed.data.note };
  } else {
    source = "FIXTURE";
    model = null;
    if (call.ok) warnings.push("AI output did not match the proposal schema.");
    proposal = deterministicProposal(catalogue, budget, headcount ?? pre.roster, pre.groupSize);
  }

  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["BUDGETING", "PROPOSED"], "The budget can only be agreed before collection opens");
    const stored: StoredProposal = {
      ranked: proposal.ranked,
      note: proposal.note,
      source,
      model,
      warnings,
      budgetMinor,
      createdAt: now.toISOString(),
    };
    // Keep a previous selection only if it is still a valid candidate.
    const keepSelection = outing.selectedOfferingId && proposal.ranked.some((r) => r.offeringId === outing.selectedOfferingId);
    const extra = {
      proposedBudgetMinor: budgetMinor,
      proposal: stored,
      selectedOfferingId: keepSelection ? outing.selectedOfferingId : null,
    };
    if (outing.status === "BUDGETING") await transition(tx, outing, "PROPOSED", now, extra);
    else await touch(tx, outing, now, extra);
    await recordAiRun(tx, { outingId: outing.id, purpose: "CATALOGUE_PROPOSAL", call, output: { ranked: proposal.ranked, note: proposal.note } });
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "BUDGET_AGREED",
      data: { proposedBudgetMinor: budgetMinor, budgetUnit: budget.unit, candidates: proposal.ranked.length, aiSource: source },
    });
    return stored;
  });
}

/* -------------------------------------------------------------------------- */
/* Proposal, roster, collection                                               */
/* -------------------------------------------------------------------------- */

export async function selectOffering(db: Db, actor: ParticipantActor, input: { offeringId: string }, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["PROPOSED"], "Agree a budget before choosing an offering");
    const entry = await getActiveOfferingWithMerchant(tx, input.offeringId);
    if (!entry) throw notFound("Offering not found");
    if (entry.offering.pricingModel !== "FIXED_TOTAL") {
      throw unprocessable(
        "PRICING_MODEL_UNSUPPORTED",
        "This offering is priced per attendee. Shared bookings need a fixed total so more attendees lower each share.",
      );
    }
    const roster = await loadRoster(tx, outing.id);
    const active = roster.filter(isActiveParticipant).length;
    if (active > entry.offering.capacity) {
      throw conflict("CAPACITY_EXCEEDED", `${entry.offering.name} fits ${entry.offering.capacity} people; ${active} are invited`);
    }
    await touch(tx, outing, now, { selectedOfferingId: entry.offering.id });
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "OFFERING_SELECTED",
      data: { offeringId: entry.offering.id, offeringName: entry.offering.name },
    });
  });
}

export async function patchParticipant(
  db: Db,
  actor: ParticipantActor,
  targetParticipantId: string,
  input: { payerType?: PayerType; required?: boolean },
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, PRE_COLLECTION, "Sponsorship and required/optional are frozen once collection opens");
    const roster = await loadRoster(tx, outing.id);
    const target = roster.find((p) => p.id === targetParticipantId);
    if (!target) throw notFound("Participant not found");

    const next = { payerType: input.payerType ?? target.payerType, required: input.required ?? target.required };
    if (target.role === "ORGANIZER") {
      if (next.payerType === "SPONSORED") throw conflict("ORGANIZER_IS_PAYER", "The organizer is always a paying participant");
      if (!next.required) throw conflict("ORGANIZER_IS_REQUIRED", "The organizer is always required");
    }
    if (next.payerType === "SPONSORED") {
      const other = roster.find((p) => p.id !== target.id && p.payerType === "SPONSORED");
      if (other) throw conflict("SPONSOR_LIMIT", `Only one guest can be sponsored; ${other.displayName} already is`);
    }
    const payersAfter = roster.filter((p) => isActiveParticipant(p) && (p.id === target.id ? next.payerType : p.payerType) === "PAYER").length;
    if (payersAfter < 1) throw conflict("NO_PAYERS", "At least one person must pay");

    await tx
      .update(participants)
      .set({ payerType: next.payerType, required: next.required, updatedAt: now })
      .where(eq(participants.id, target.id));
    await touch(tx, outing, now);
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "PARTICIPANT_UPDATED",
      data: { participantId: target.id, displayName: target.displayName, payerType: next.payerType, required: next.required },
    });
  });
}

export interface OpenCollectionResult {
  quoteId: string;
  termsHash: string;
  capMinor: number;
  version: number;
}

export async function openCollection(
  db: Db,
  actor: ParticipantActor,
  input: { activityAt: Date; deadlineAt: Date; minPayers: number },
  now: Date = new Date(),
): Promise<OpenCollectionResult> {
  const { activityAt, deadlineAt, minPayers } = input;
  if (Number.isNaN(activityAt.getTime()) || Number.isNaN(deadlineAt.getTime())) throw badRequest("INVALID_DATE", "Invalid date");
  if (!Number.isSafeInteger(minPayers) || minPayers < 1) throw badRequest("INVALID_MIN_PAYERS", "minPayers must be at least 1");

  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["PROPOSED"], "Collection can only open from an agreed proposal");
    if (!outing.selectedOfferingId) throw conflict("NO_OFFERING", "Choose an offering first");
    const entry = await getActiveOfferingWithMerchant(tx, outing.selectedOfferingId);
    if (!entry) throw conflict("OFFERING_UNAVAILABLE", "The selected offering is no longer available");
    const { offering, merchant } = entry;
    if (offering.pricingModel !== "FIXED_TOTAL") {
      throw unprocessable("PRICING_MODEL_UNSUPPORTED", "Only fixed-total offerings can be shared");
    }

    const expiresAt = new Date(deadlineAt.getTime() + QUOTE_VALIDITY_AFTER_DEADLINE_MS);
    validateCommitmentDeadline({ now, deadlineAt, activityAt, quoteExpiresAt: expiresAt });

    const availability = checkAvailability(offering, merchant.timezone, activityAt);
    if (!availability.available) throw conflict("MERCHANT_UNAVAILABLE", availability.reason ?? "The merchant is not available at that time");

    const roster = await loadRoster(tx, outing.id);
    const declinedRequired = roster.find((p) => p.required && !isActiveParticipant(p));
    if (declinedRequired) {
      throw conflict("REQUIRED_DECLINED", `${declinedRequired.displayName} declined. Mark them optional before opening collection.`);
    }
    const active = roster.filter(isActiveParticipant);
    const payers = active.filter((p) => p.payerType === "PAYER");
    const sponsored = active.filter((p) => p.payerType === "SPONSORED");
    if (payers.length < 1) throw conflict("NO_PAYERS", "At least one person must pay");
    if (sponsored.length > 1) throw conflict("SPONSOR_LIMIT", "Only one guest can be sponsored");
    if (active.length > offering.capacity) {
      throw conflict("CAPACITY_EXCEEDED", `${offering.name} fits ${offering.capacity} people; ${active.length} are invited`);
    }
    if (minPayers > payers.length) {
      throw conflict("INVALID_MIN_PAYERS", `Minimum payers (${minPayers}) cannot exceed the ${payers.length} invited payers`);
    }

    const previous = await tx.query.quoteVersions.findMany({ where: eq(quoteVersions.outingId, outing.id) });
    const version = previous.reduce((m, q) => Math.max(m, q.version), 0) + 1;
    if (previous.some((q) => q.status === "ACTIVE")) {
      await tx.update(quoteVersions).set({ status: "SUPERSEDED" }).where(and(eq(quoteVersions.outingId, outing.id), eq(quoteVersions.status, "ACTIVE")));
    }

    const quoteId = crypto.randomUUID();
    const terms = buildCommitmentTerms({
      outingId: outing.id,
      quoteId,
      quoteVersion: version,
      merchantId: merchant.id,
      merchantName: merchant.name,
      offeringId: offering.id,
      offeringName: offering.name,
      pricingModel: offering.pricingModel,
      totalMinor: offering.priceMinor,
      currency: assertCurrency(offering.currency),
      capacity: offering.capacity,
      minPayers,
      activityAt: activityAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      policy: outing.policy,
      sponsoredParticipantIds: sponsored.map((p) => p.id),
      requiredParticipantIds: active.filter((p) => p.required).map((p) => p.id),
    });
    const termsHash = hashTerms(terms);

    await tx.insert(quoteVersions).values({
      id: quoteId,
      outingId: outing.id,
      version,
      status: "ACTIVE",
      merchantId: merchant.id,
      offeringId: offering.id,
      pricingModel: offering.pricingModel,
      totalMinor: terms.totalMinor,
      currency: terms.currency,
      capacity: terms.capacity,
      minPayers: terms.minPayers,
      capMinor: terms.capMinor,
      activityAt,
      deadlineAt,
      expiresAt,
      terms,
      termsHash,
      merchantConfirmedAt: now,
      availabilitySource: availability.source,
      createdAt: now,
    });

    await transition(tx, outing, "COLLECTING", now, {
      currentQuoteId: quoteId,
      merchantId: merchant.id,
      deadlineAt,
      activityAt,
      minPayers,
      maxAttendees: offering.capacity,
      collectionOpenedAt: now,
    });

    await enqueueJob(tx, {
      kind: "SETTLE_DEADLINE",
      outingId: outing.id,
      runAt: deadlineAt,
      dedupeKey: settleJobKey(outing.id, quoteId),
      payload: { quoteId },
    });

    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "COLLECTION_OPENED",
      data: {
        quoteId,
        quoteVersion: version,
        offeringName: offering.name,
        totalMinor: terms.totalMinor,
        capMinor: terms.capMinor,
        minPayers,
        activityAt: terms.activityAt,
        deadlineAt: terms.deadlineAt,
        availabilitySource: availability.source,
        sponsoredCount: sponsored.length,
        requiredCount: terms.requiredParticipantIds.length,
      },
    });
    return { quoteId, termsHash, capMinor: terms.capMinor, version };
  });
}

/* -------------------------------------------------------------------------- */
/* AI plan draft (advisory: pre-fills the organizer's form, never persisted)  */
/* -------------------------------------------------------------------------- */

/** Per-outing budget for AI plan drafts (on top of the per-client AI limit in the route). */
export const PLAN_DRAFT_RATE_LIMIT: RateLimitRule = { capacity: 5, refillPerMinute: 2 };

/**
 * Ask the AI to draft the organizer's "open commitments" form. Read-only:
 * nothing is selected, sponsored or persisted as terms; the organizer reviews
 * every field and opens commitments explicitly. The AI sees the brief
 * extraction, the agreed budget, public catalogue data with availability and
 * roster NAMES with payer/sponsor flags; never votes, ids or private amounts.
 * Every value is validated deterministically (`validatePlanDraft`); invalid
 * fields are dropped with a note, never adjusted.
 */
export async function draftPlan(db: Db, input: { outingId: string; organizerId: string; now?: Date }): Promise<PlanDraftResponse> {
  const now = input.now ?? new Date();
  const actor: ParticipantActor = { outingId: input.outingId, participantId: input.organizerId };
  const { outing, roster } = await db.transaction(async (tx) => {
    const { outing } = await begin(tx, actor, { organizer: true });
    requireStatus(outing, ["PROPOSED"], "The AI can draft the plan after the budget is agreed and before commitments open");
    return { outing, roster: (await loadRoster(tx, outing.id)).filter(isActiveParticipant) };
  });

  if (!takeToken(`plan-draft:${outing.id}`, PLAN_DRAFT_RATE_LIMIT, now.getTime())) {
    throw new ServiceError("RATE_LIMITED", 429, "The AI has drafted several plans for this outing just now. Please wait a minute and try again.");
  }

  // Candidates: the stored ranking (plus the selection), still active in OUR catalogue.
  const ids = storedProposal(outing)?.ranked.map((r) => r.offeringId) ?? [];
  if (outing.selectedOfferingId && !ids.includes(outing.selectedOfferingId)) ids.unshift(outing.selectedOfferingId);
  const active = new Map((await listActiveOfferings(db)).map((e) => [e.offering.id, e]));
  const ranked = [...new Set(ids)].flatMap((id) => (active.has(id) ? [active.get(id)!] : []));
  if (ranked.length === 0) throw conflict("NO_CANDIDATES", "There are no catalogue options to plan with. Try another budget round.");
  // Wall times are expressed in one merchant timezone: the selected (else top) candidate's.
  const timezone = (ranked.find((e) => e.offering.id === outing.selectedOfferingId) ?? ranked[0]).merchant.timezone;
  const entries = ranked.filter((e) => e.merchant.timezone === timezone);
  const catalogue: PlanCatalogueItem[] = toCatalogueForAi(entries).map((c, i) => {
    const a = entries[i].offering.availability;
    return {
      ...c,
      active: entries[i].offering.active,
      availability: { weekdays: Array.isArray(a?.weekdays) ? [...a.weekdays] : [], startHours: Array.isArray(a?.startHours) ? [...a.startHours] : [] },
    };
  });
  const aiRoster: PlanRosterEntry[] = roster.map((p) => ({
    name: p.displayName,
    isOrganizer: p.role === "ORGANIZER",
    payer: p.payerType === "PAYER",
    sponsored: p.payerType === "SPONSORED",
  }));
  const aiInput: PlanDraftInput = {
    extraction: storedExtraction(outing)?.extraction ?? fallbackExtraction(outing),
    agreedBudgetMinor: outing.proposedBudgetMinor,
    budgetUnit: outing.budgetUnit,
    catalogue,
    selectedOfferingId: outing.selectedOfferingId,
    roster: aiRoster,
    now,
    timezone,
  };

  const call = await callAi((ai) => ai.draftPlan(aiInput));
  if (!call.ok) {
    await recordAiRun(db, { outingId: outing.id, purpose: "PLAN_DRAFT", call });
    throw new ServiceError("AI_UNAVAILABLE", 503, "The AI couldn't draft a plan just now. Nothing changed; you can fill in the form yourself.");
  }
  const parsed = PlanDraftSchema.safeParse(call.result.output);
  if (!parsed.success) {
    await recordAiRun(db, {
      outingId: outing.id,
      purpose: "PLAN_DRAFT",
      call: { ok: false, source: call.result.source, error: "AI output did not match the plan draft schema" },
    });
    throw new ServiceError("AI_OUTPUT_INVALID", 502, "The AI's draft couldn't be read. Nothing changed; you can fill in the form yourself.");
  }

  const v = validatePlanDraft(parsed.data, {
    now,
    timezone,
    catalogue,
    roster: aiRoster,
    quoteValidityAfterDeadlineMs: QUOTE_VALIDITY_AFTER_DEADLINE_MS,
  });
  const dropped = [...v.dropped];
  let sponsor: PlanDraftResponse["draft"]["sponsor"] = null;
  if (v.sponsor) {
    const person = v.sponsor.name === null ? null : roster.filter((p) => p.displayName === v.sponsor!.name);
    if (person === null) sponsor = { participantId: null, displayName: null };
    else if (person.length === 1) sponsor = { participantId: person[0].id, displayName: person[0].displayName };
    else dropped.push({ field: "sponsor", reason: "The suggested sponsored guest could not be matched to exactly one invited person." });
  }
  const response: PlanDraftResponse = {
    draft: {
      offeringId: v.offeringId,
      offeringName: catalogue.find((c) => c.offeringId === v.offeringId)?.name ?? null,
      timezone,
      activityStartLocal: v.activityStartLocal,
      activityAt: v.activityAt,
      deadlineLocal: v.deadlineLocal,
      deadlineAt: v.deadlineAt,
      minPayers: v.minPayers,
      sponsor,
      rationale: v.rationale,
      cautions: v.cautions,
    },
    dropped,
    source: call.result.source,
    model: call.result.model,
  };
  await recordAiRun(db, {
    outingId: outing.id,
    purpose: "PLAN_DRAFT",
    call,
    output: { raw: parsed.data, draft: response.draft, dropped, warnings: call.result.warnings.slice(0, 10) },
  });
  return response;
}

/* -------------------------------------------------------------------------- */
/* Participant responses                                                      */
/* -------------------------------------------------------------------------- */

export const EARLY_SETTLE_KEY = (outingId: string) => `settle-early:${outingId}`;

async function enqueueEarlyCancel(tx: Tx, outingId: string, reason: "REQUIRED_DECLINED" | "ORGANIZER_CANCELLED", now: Date) {
  await enqueueJob(tx, {
    kind: "SETTLE_DEADLINE",
    outingId,
    runAt: now,
    dedupeKey: EARLY_SETTLE_KEY(outingId),
    payload: { early: true, reason },
    onConflict: "requeue",
  });
  if (reason === "ORGANIZER_CANCELLED") {
    // An organizer cancel must win over an earlier queued REQUIRED_DECLINED evaluation.
    await tx
      .update(jobs)
      .set({ payload: { early: true, reason }, updatedAt: now })
      .where(and(eq(jobs.dedupeKey, EARLY_SETTLE_KEY(outingId)), eq(jobs.status, "QUEUED")));
  }
}

async function hasActiveCommitment(tx: DbOrTx, outing: Outing, participantId: string): Promise<boolean> {
  const c = await tx.query.consents.findFirst({
    where: and(eq(consents.outingId, outing.id), eq(consents.participantId, participantId), isNull(consents.withdrawnAt)),
  });
  if (c) return true;
  const holds = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.outingId, outing.id),
        eq(paymentAttempts.participantId, participantId),
        inArray(paymentAttempts.status, ["APPROVAL_PENDING", "AUTHORIZED", "CAPTURE_PENDING", "UNKNOWN"]),
      ),
    )
    .limit(1);
  return holds.length > 0;
}

export async function respond(
  db: Db,
  actor: ParticipantActor,
  input: { response: "ACCEPT" | "DECLINE" },
  now: Date = new Date(),
): Promise<{ attendance: AttendanceState; earlyCancelQueued: boolean }> {
  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor);
    const pre = isPreCollection(outing.status);
    if (!pre && !collectionWindowOpen(outing, now)) {
      throw conflict(outing.status === "COLLECTING" ? "DEADLINE_PASSED" : "INVALID_STATE", "Responses are closed for this outing");
    }
    if (me.role === "ORGANIZER") throw conflict("ORGANIZER_RESPONSE", "As the organizer, cancel the outing instead");
    if (!pre && me.attendance === "DECLINED") throw conflict("ALREADY_DECLINED", "You already declined this outing");
    if (me.attendance === "WITHDRAWN") throw conflict("ALREADY_WITHDRAWN", "You withdrew from this outing");

    let earlyCancelQueued = false;
    if (input.response === "ACCEPT") {
      if (!pre && me.payerType !== "SPONSORED") {
        throw conflict("USE_CONSENT", "Paying participants join by reviewing the terms and authorizing their share");
      }
      if (me.attendance === "ACCEPTED") return { attendance: me.attendance, earlyCancelQueued };
      await tx.update(participants).set({ attendance: "ACCEPTED", attendanceAt: now, updatedAt: now }).where(eq(participants.id, me.id));
      await recordAudit(tx, {
        outingId: outing.id,
        actor: actorOf(me.id),
        type: "ATTENDANCE_ACCEPTED",
        data: { participantId: me.id, displayName: me.displayName, payerType: me.payerType, required: me.required },
      });
      await touch(tx, outing, now);
      return { attendance: "ACCEPTED", earlyCancelQueued };
    }

    // DECLINE
    if (me.attendance === "DECLINED") return { attendance: me.attendance, earlyCancelQueued };
    if (!pre && (await hasActiveCommitment(tx, outing, me.id))) {
      throw conflict("USE_WITHDRAW", "You have agreed to pay a share. Use Withdraw so your payment hold is released.");
    }
    await tx.update(participants).set({ attendance: "DECLINED", attendanceAt: now, updatedAt: now }).where(eq(participants.id, me.id));
    if (!pre && me.required) {
      // ALL_REQUIRED: a required decline makes the outing infeasible; release holds early.
      await enqueueEarlyCancel(tx, outing.id, "REQUIRED_DECLINED", now);
      earlyCancelQueued = true;
    }
    await touch(tx, outing, now);
    await recordAudit(tx, {
      outingId: outing.id,
      actor: actorOf(me.id),
      type: "ATTENDANCE_DECLINED",
      data: { participantId: me.id, displayName: me.displayName, required: me.required, earlyCancelQueued },
    });
    return { attendance: "DECLINED", earlyCancelQueued };
  });
}

export interface ConsentResult {
  consentId: string;
  quoteId: string;
  termsHash: string;
  capMinor: number;
  statement: string;
  acceptedAt: string;
}

export async function consent(db: Db, actor: ParticipantActor, input: { termsHash: string }, now: Date = new Date()): Promise<ConsentResult> {
  return db.transaction(async (tx) => {
    // Row lock serializes with the settlement freeze (which also locks the outing).
    const { outing, me } = await begin(tx, actor);
    if (outing.status !== "COLLECTING") throw conflict("INVALID_STATE", "This outing is not collecting commitments");
    if (outing.frozenAt) throw conflict("ROSTER_FROZEN", "The roster is already frozen");
    if (!outing.deadlineAt || !isBeforeDeadline(now, outing.deadlineAt)) throw conflict("DEADLINE_PASSED", "The commitment deadline has passed");
    if (me.payerType !== "PAYER") throw conflict("NOT_A_PAYER", "Your share is covered; just accept the invitation");
    if (!isActiveParticipant(me)) throw conflict("NOT_ATTENDING", "You are no longer attending this outing");
    if (!outing.currentQuoteId) throw conflict("NO_QUOTE", "There are no terms to agree to yet");
    const quote = await tx.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId) });
    if (!quote || quote.status !== "ACTIVE" || quote.expiresAt.getTime() <= now.getTime()) {
      throw conflict("TERMS_CHANGED", "The terms changed. Please review them again.");
    }
    if (input.termsHash.toLowerCase() !== quote.termsHash) throw conflict("TERMS_CHANGED", "The terms changed. Please review them again.");

    const existing = await tx.query.consents.findFirst({
      where: and(eq(consents.participantId, me.id), eq(consents.quoteId, quote.id), isNull(consents.withdrawnAt)),
    });
    const statement = commitStatement(quote.capMinor, quote.currency);
    let row = existing;
    if (!row) {
      [row] = await tx
        .insert(consents)
        .values({
          outingId: outing.id,
          participantId: me.id,
          quoteId: quote.id,
          termsHash: quote.termsHash,
          capMinor: quote.capMinor,
          currency: quote.currency,
          statement,
          acceptedAt: now,
          createdAt: now,
        })
        .returning();
      await tx.update(participants).set({ attendance: "ACCEPTED", attendanceAt: now, updatedAt: now }).where(eq(participants.id, me.id));
      await touch(tx, outing, now);
      await recordAudit(tx, {
        outingId: outing.id,
        actor: actorOf(me.id),
        type: "CONSENT_RECORDED",
        data: { participantId: me.id, displayName: me.displayName, quoteId: quote.id, quoteVersion: quote.version, capMinor: quote.capMinor },
      });
    }
    return {
      consentId: row.id,
      quoteId: quote.id,
      termsHash: row.termsHash,
      capMinor: row.capMinor,
      statement: row.statement,
      acceptedAt: row.acceptedAt.toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

export async function cancel(
  db: Db,
  actor: ParticipantActor,
  now: Date = new Date(),
): Promise<{ status: OutingStatus; cancellationQueued: boolean }> {
  return db.transaction(async (tx) => {
    const { outing, me } = await begin(tx, actor, { organizer: true });
    if (isPreCollection(outing.status)) {
      // No terms, consents or holds exist yet: cancel directly.
      await transition(tx, outing, "CANCELLED", now, { cancelledAt: now, cancelReasons: ["ORGANIZER_CANCELLED"], cleanup: "NONE" });
      await recordAudit(tx, { outingId: outing.id, actor: actorOf(me.id), type: "OUTING_CANCELLED", data: { reason: "ORGANIZER_CANCELLED" } });
      return { status: "CANCELLED", cancellationQueued: false };
    }
    if (outing.status === "COLLECTING") {
      // After the SERVER deadline the roster belongs to the settlement job (it is frozen and
      // settled against the stored deadline, even when the worker runs late): no organizer cancel.
      if (!collectionWindowOpen(outing, now)) {
        throw conflict("DEADLINE_PASSED", "The commitment deadline has passed; the booking is being settled and can no longer be cancelled here");
      }
      // The settlement engine cancels and voids holds under the same outing lock.
      await enqueueEarlyCancel(tx, outing.id, "ORGANIZER_CANCELLED", now);
      await touch(tx, outing, now);
      await recordAudit(tx, { outingId: outing.id, actor: actorOf(me.id), type: "CANCEL_REQUESTED", data: { reason: "ORGANIZER_CANCELLED" } });
      return { status: outing.status, cancellationQueued: true };
    }
    throw conflict("INVALID_STATE", "This outing can no longer be cancelled by the organizer");
  });
}

/* -------------------------------------------------------------------------- */
/* Misc reads used by routes                                                  */
/* -------------------------------------------------------------------------- */

export async function findParticipantByToken(db: DbOrTx, token: string): Promise<Participant | null> {
  const p = await db.query.participants.findFirst({ where: eq(participants.inviteTokenHash, hashToken(token)) });
  return p ?? null;
}

export async function currentQuote(db: DbOrTx, outing: Outing): Promise<QuoteVersion | null> {
  if (!outing.currentQuoteId) return null;
  return (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, outing.currentQuoteId) })) ?? null;
}

