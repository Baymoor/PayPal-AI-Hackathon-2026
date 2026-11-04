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
});
export type BriefExtraction = z.infer<typeof BriefExtractionSchema>;

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
}
