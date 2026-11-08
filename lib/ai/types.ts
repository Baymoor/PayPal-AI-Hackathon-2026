/**
 * AI contracts. The model INTERPRETS and EXPLAINS; it never decides money,
 * eligibility, deadlines or provider operations. Every model output is
 * validated against these schemas and against our own catalogue/aggregates
 * before use. Pasted group chat text is treated as data, never instructions.
 */
import { z } from "zod";

export type AiSource = "ANTHROPIC" | "FIXTURE";

export interface AiResult<T> {
  source: AiSource;
  /** Model id for ANTHROPIC results; null for FIXTURE. */
  model: string | null;
  output: T;
  /** Non-fatal validation notes (e.g. "dropped unknown offering id"). */
  warnings: string[];
}

/* ------------------------------- Brief parsing ------------------------------ */

export const SummaryIcon = z.enum(["activity", "date", "people", "gift", "budget", "place", "note"]);

export const BriefExtractionSchema = z.object({
  /** Short title suggestion, e.g. "Maya's birthday karaoke". */
  title: z.string().min(1).max(80),
  activityIdeas: z.array(z.string().min(1).max(60)).max(5),
  /** Catalogue categories that fit (validated against the real catalogue). */
  categories: z.array(z.string().min(1).max(40)).max(5),
  dateWindow: z.object({
    description: z.string().max(80),
    dayOfWeek: z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]).nullable(),
    partOfDay: z.enum(["MORNING", "AFTERNOON", "EVENING", "NIGHT"]).nullable(),
  }),
  groupSize: z.object({
    count: z.number().int().min(1).max(50).nullable(),
    isEstimate: z.boolean(),
  }),
  budget: z.object({
    /** Integer minor units (cents) if the brief states an amount; else null. */
    amountMinor: z.number().int().positive().max(10_000_000).nullable(),
    unit: z.enum(["TOTAL", "PER_PERSON", "UNKNOWN"]),
  }),
  guestOfHonour: z.object({
    name: z.string().max(40).nullable(),
    coverTheirShare: z.boolean(),
  }),
  /** True when the group wants a fixed-cost activity so more attendees lower each share. */
  prefersFixedTotal: z.boolean(),
  needs: z.array(z.string().min(1).max(60)).max(5),
  uncertainties: z.array(z.string().min(1).max(120)).max(5),
  /** "Here's what I understood" rows. */
  summary: z
    .array(z.object({ icon: SummaryIcon, text: z.string().min(1).max(80) }))
    .min(1)
    .max(6),
  /**
   * Five suggested TOTAL budget-poker amounts for the whole group, integer
   * minor units; null = no suggestion. Only SHAPE here, so one bad field
   * cannot discard the whole extraction: `validateBrief` applies the rules in
   * lib/domain/budget-options.ts. Absent on extractions stored before the
   * field existed.
   */
  suggestedVoteTotalsMinor: z.array(z.number()).nullable().optional(),
});
export type BriefExtraction = z.infer<typeof BriefExtractionSchema>;

/**
 * What the model must return. Structured output makes every field required,
 * so the model always answers the vote-amount question (null is allowed);
 * the default keeps parsing tolerant if a response ever omits it.
 */
export const BriefExtractionModelSchema = BriefExtractionSchema.extend({
  suggestedVoteTotalsMinor: z
    .array(z.number())
    .nullable()
    .default(null)
    .describe(
      "Exactly five ascending TOTAL amounts for the whole group's budget vote, in integer minor units (cents), each a multiple of 500. Fit the activity, group size and any stated budget (a stated total must lie inside the range). null if you cannot judge.",
    ),
});

/* --------------------------- Catalogue proposals ---------------------------- */

export interface CatalogueItemForAi {
  offeringId: string;
  name: string;
  merchantName: string;
  category: string;
  description: string;
  pricingModel: "FIXED_TOTAL" | "PER_ATTENDEE";
  priceMinor: number;
  currency: string;
  capacity: number;
  minAttendees: number;
  tags: string[];
}

export const ProposalSchema = z.object({
  ranked: z
    .array(
      z.object({
        offeringId: z.string().min(1),
        fit: z.enum(["GREAT", "GOOD", "STRETCH"]),
        reasons: z.array(z.string().min(1).max(140)).min(1).max(3),
        concerns: z.array(z.string().min(1).max(140)).max(3),
      }),
    )
    .max(5),
  note: z.string().max(280),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/* ------------------------------ Budget reveal ------------------------------- */

/** Aggregate-only input. Never contains names or per-person votes. */
export interface RevealAggregate {
  unit: "TOTAL";
  currency: string;
  voteCount: number;
  invitedCount: number;
  buckets: { amountMinor: number; count: number }[];
  minMinor: number;
  maxMinor: number;
  medianMinor: number;
}

export const RevealSummarySchema = z.object({
  headline: z.string().min(1).max(90),
  summary: z.string().min(1).max(320),
  /** Must lie within [min, max] of the votes; validated in code. */
  suggestedTotalMinor: z.number().int().positive(),
});
export type RevealSummary = z.infer<typeof RevealSummarySchema>;

/* --------------------------- Dashboard NL query ----------------------------- */

/** Whitelisted, read-only fields an NL dashboard query may filter on. */
export const DASHBOARD_FIELDS = [
  "status",
  "closesWithinHours",
  "closesToday",
  "missingRequired",
  "requiredAccepted",
  "requiredInvited",
  "payersAuthorized",
  "minPayers",
  "authorizedTotalMinor",
  "capturedTotalMinor",
  "refundedTotalMinor",
  "cleanup",
  "isFixture",
] as const;

export const DashboardQuerySchema = z.object({
  filters: z
    .array(
      z.object({
        field: z.enum(DASHBOARD_FIELDS),
        op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
        value: z.union([z.string().max(40), z.number(), z.boolean(), z.array(z.string().max(40)).max(10)]),
      }),
    )
    .max(6),
  sort: z
    .object({ field: z.enum(DASHBOARD_FIELDS), direction: z.enum(["asc", "desc"]) })
    .nullable(),
  /** Optional widget focus for the dashboard. */
  focus: z.enum(["BOOKINGS_TABLE", "READINESS", "STATUS_CHART", "MONEY_CHART"]).nullable(),
  explanation: z.string().min(1).max(240),
});
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

/* ------------------------------- Plan draft --------------------------------- */

/** "YYYY-MM-DDTHH:mm" wall-clock time (24 h, no seconds, no offset). */
export const LOCAL_WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const localWallTime = z
  .string()
  .max(40)
  .describe('Wall-clock time in the merchant timezone, exactly "YYYY-MM-DDTHH:mm" (24 h). Empty string if no valid time exists.');

/**
 * The AI's suggested plan for the organizer's "Open commitments" form. Only
 * SHAPE is enforced here (so one bad field cannot discard the whole draft);
 * every value is untrusted until `validatePlanDraft` checks it against our
 * catalogue, availability, roster and the deadline policy. The wall-time
 * format is checked there, per field.
 */
export const PlanDraftSchema = z.object({
  offeringId: z.string().min(1).max(100).describe("Copied exactly from the catalogue."),
  activityStartLocal: localWallTime,
  deadlineLocal: localWallTime,
  minPayers: z.number().int(),
  sponsoredParticipantName: z.string().max(80).nullable(),
  rationale: z.array(z.string().min(1).max(140)).max(4),
  cautions: z.array(z.string().min(1).max(140)).max(3),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

/** Weekly start-time model, evaluated in the merchant timezone (weekdays: 0 = Sunday … 6 = Saturday). */
export interface AvailabilityWindow {
  weekdays: number[];
  startHours: number[];
}

/** A catalogue candidate plus what the planner needs: public price, capacity and availability only. */
export interface PlanCatalogueItem extends CatalogueItemForAi {
  active: boolean;
  availability: AvailabilityWindow;
}

/** Roster entry for the planner: display name and flags only. Never ids, votes or money. */
export interface PlanRosterEntry {
  name: string;
  isOrganizer: boolean;
  /** Currently a paying participant. */
  payer: boolean;
  /** Currently the sponsored guest (attends at $0). */
  sponsored: boolean;
}

export interface PlanDraftInput {
  extraction: BriefExtraction;
  /** Agreed TOTAL budget in minor units (a starting point, not a quote). */
  agreedBudgetMinor: number | null;
  /** Candidates in ranked order, best first. */
  catalogue: PlanCatalogueItem[];
  selectedOfferingId: string | null;
  /** Active (not declined) participants only. */
  roster: PlanRosterEntry[];
  now: Date;
  /** Merchant IANA timezone; every *Local string is a wall time in this zone. */
  timezone: string;
}

/** Form fields a draft can pre-fill; a dropped field is left for the organizer. */
export const PLAN_DRAFT_FIELDS = ["offeringId", "activityStart", "deadline", "minPayers", "sponsor"] as const;
export type PlanDraftField = (typeof PLAN_DRAFT_FIELDS)[number];

export interface PlanDraftDrop {
  field: PlanDraftField;
  reason: string;
}

/** Output of `validatePlanDraft`: every non-null field passed the deterministic checks. */
export interface ValidatedPlanDraft {
  offeringId: string | null;
  activityStartLocal: string | null;
  /** ISO-8601 UTC instant of `activityStartLocal`. */
  activityAt: string | null;
  deadlineLocal: string | null;
  /** ISO-8601 UTC instant of `deadlineLocal`. */
  deadlineAt: string | null;
  minPayers: number | null;
  /** null = no sponsorship suggestion (dropped); `{ name: null }` = suggest nobody is sponsored. */
  sponsor: { name: string | null } | null;
  rationale: string[];
  cautions: string[];
  dropped: PlanDraftDrop[];
}

/** `POST /api/outings/:id/plan-draft` response. Pre-fills the organizer's form only; nothing is persisted as terms. */
export interface PlanDraftResponse {
  draft: {
    offeringId: string | null;
    offeringName: string | null;
    /** Merchant timezone the *Local strings are expressed in. */
    timezone: string;
    activityStartLocal: string | null;
    activityAt: string | null;
    deadlineLocal: string | null;
    deadlineAt: string | null;
    minPayers: number | null;
    /** null = no suggestion; participantId null = suggest nobody is sponsored. */
    sponsor: { participantId: string | null; displayName: string | null } | null;
    rationale: string[];
    cautions: string[];
  };
  dropped: PlanDraftDrop[];
  source: AiSource;
  model: string | null;
}

/* --------------------------------- Port ------------------------------------- */

export interface OutingsAi {
  readonly source: AiSource;
  extractBrief(input: { brief: string; now: Date; timezone: string; categories?: string[] }): Promise<AiResult<BriefExtraction>>;
  proposeOfferings(input: {
    extraction: BriefExtraction;
    catalogue: CatalogueItemForAi[];
    agreedBudgetMinor: number | null;
    groupSize: number | null;
  }): Promise<AiResult<Proposal>>;
  summarizeReveal(input: { aggregate: RevealAggregate; extraction: BriefExtraction | null }): Promise<AiResult<RevealSummary>>;
  dashboardQuery(input: { question: string; now: Date }): Promise<AiResult<DashboardQuery>>;
  /**
   * Suggest a complete plan for the organizer's form. Returns a SHAPE-valid
   * draft only: callers must run `validatePlanDraft` with authoritative data
   * before showing or using any value.
   */
  draftPlan(input: PlanDraftInput): Promise<AiResult<PlanDraft>>;
}
