/**
 * Domain validation shared by the Anthropic and FIXTURE implementations.
 * Zod validates SHAPE; this module validates against OUR data (catalogue,
 * aggregates, whitelists) and sanitizes free text. It never invents data.
 */
import {
  BriefExtractionSchema,
  DashboardQuerySchema,
  LOCAL_WALL_TIME_RE,
  PlanDraftSchema,
  ProposalSchema,
  RevealSummarySchema,
  type BriefExtraction,
  type CatalogueItemForAi,
  type DashboardQuery,
  type PlanCatalogueItem,
  type PlanDraft,
  type PlanDraftDrop,
  type PlanDraftField,
  type PlanRosterEntry,
  type Proposal,
  type RevealAggregate,
  type RevealSummary,
  type ValidatedPlanDraft,
} from "./types";
import type { Offering } from "../db/schema";
import { MAX_BUDGET_MINOR, validateBudgetOptions } from "../domain/budget-options";
import { PolicyError, validateCommitmentDeadline } from "../domain/policy";
import { MAX_COMMITMENT_WINDOW_MS } from "../domain/types";
// The same pure timezone/availability helpers openCollection uses on the server.
import { checkAvailability, zonedParts, zonedTimeToUtc } from "../services/catalogue";

export { MAX_BUDGET_MINOR };

/** Model output was unusable (bad JSON, schema failure, refusal, truncation). */
export class AiOutputError extends Error {
  readonly kind = "AI_OUTPUT_INVALID";
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "AiOutputError";
  }
}

/** Transport/provider failure (timeout, 5xx, auth). Callers decide fallbacks. */
export class AiProviderError extends Error {
  readonly kind = "AI_PROVIDER_ERROR";
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface Validated<T> {
  output: T;
  warnings: string[];
}

/* ------------------------------ text hygiene -------------------------------- */

/** Strip markdown links, bare URLs and control characters from free text. */
export function sanitizeText(input: string, maxLen?: number): string {
  let s = input
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links/images -> label
    .replace(/<?\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s>)]*>?/gi, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (maxLen !== undefined && s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

function cleanList(list: string[], maxLen: number): string[] {
  return list.map((s) => sanitizeText(s, maxLen)).filter((s) => s.length > 0);
}

/** Dashboard filter values: conservative character set only. */
function sanitizeToken(v: string): string {
  return v.replace(/[^A-Za-z0-9_ .:-]/g, "").trim().slice(0, 40);
}

/* -------------------------------- brief ------------------------------------- */

export interface BriefValidationOptions {
  /** Real catalogue categories; when given, other categories are dropped. */
  categories?: string[];
  /** Original brief text; when given, a budget number must appear in it. */
  sourceText?: string;
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(/(\d),(\d{3})/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  return out;
}

export function validateBrief(raw: BriefExtraction, opts: BriefValidationOptions = {}): Validated<BriefExtraction> {
  const warnings: string[] = [];
  const b: BriefExtraction = BriefExtractionSchema.parse(raw);

  const title = sanitizeText(b.title, 80) || "Group outing";
  let categories = cleanList(b.categories, 40);
  if (opts.categories) {
    const canon = new Map(opts.categories.map((c) => [c.toLowerCase(), c]));
    const kept: string[] = [];
    for (const c of categories) {
      const hit = canon.get(c.toLowerCase());
      if (hit) {
        if (!kept.includes(hit)) kept.push(hit);
      } else warnings.push(`Dropped category "${c}": not in the catalogue.`);
    }
    categories = kept;
  }

  let { amountMinor, unit } = b.budget;
  if (amountMinor !== null) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_BUDGET_MINOR) {
      warnings.push("Dropped budget amount: outside the allowed range.");
      amountMinor = null;
    } else if (opts.sourceText !== undefined) {
      const major = amountMinor / 100;
      if (!numbersIn(opts.sourceText).some((n) => Math.abs(n - major) < 0.005)) {
        warnings.push("Dropped budget amount: it is not stated in the brief.");
        amountMinor = null;
      }
    }
  }
  if (amountMinor === null) unit = "UNKNOWN";
  else if (unit === "UNKNOWN") warnings.push("Budget amount found but its unit (total vs per person) is unclear.");

  const summary = b.summary
    .map((r) => ({ icon: r.icon, text: sanitizeText(r.text, 80) }))
    .filter((r) => r.text.length > 0);
  if (summary.length === 0) summary.push({ icon: "note", text: title.slice(0, 80) });

  const voteAmounts = validVoteAmounts(b.suggestedVotePerPersonMinor ?? null, warnings);

  const output: BriefExtraction = {
    title,
    activityIdeas: cleanList(b.activityIdeas, 60),
    categories,
    dateWindow: { ...b.dateWindow, description: sanitizeText(b.dateWindow.description, 80) },
    groupSize: b.groupSize,
    budget: { amountMinor, unit },
    guestOfHonour: {
      name: b.guestOfHonour.name ? sanitizeText(b.guestOfHonour.name, 40) || null : null,
      coverTheirShare: b.guestOfHonour.coverTheirShare,
    },
    prefersFixedTotal: b.prefersFixedTotal,
    needs: cleanList(b.needs, 60),
    uncertainties: cleanList(b.uncertainties, 120),
    summary,
    suggestedVotePerPersonMinor: voteAmounts,
  };
  return { output, warnings };
}

/** Suggested vote amounts that pass the budget-option rules; anything else is dropped with a warning, never adjusted. */
function validVoteAmounts(suggestion: number[] | null, warnings: string[]): number[] | null {
  if (suggestion === null) return null;
  const check = validateBudgetOptions(suggestion);
  if (check.ok) return check.optionsMinor;
  warnings.push(`Dropped suggested vote amounts: ${check.reason}.`);
  return null;
}

/* ------------------------------- proposals ---------------------------------- */

// "per person" is not a signal here: budget sentences say it ("above the agreed $20 per person") about any offering.
const GROWS_RE = /(attendee|per head|grows?|increase|scales?)/i;
export const PER_ATTENDEE_CONCERN = "Priced per attendee, so the total grows with each person who joins.";

export function validateProposal(raw: Proposal, catalogue: CatalogueItemForAi[]): Validated<Proposal> {
  const warnings: string[] = [];
  const p = ProposalSchema.parse(raw);
  const byId = new Map(catalogue.map((c) => [c.offeringId, c]));
  const seen = new Set<string>();
  const ranked: Proposal["ranked"] = [];

  for (const r of p.ranked) {
    const item = byId.get(r.offeringId);
    if (!item) {
      warnings.push(`Dropped unknown offering id "${sanitizeText(r.offeringId, 60)}": not in the catalogue.`);
      continue;
    }
    if (seen.has(r.offeringId)) {
      warnings.push(`Dropped duplicate offering id "${r.offeringId}".`);
      continue;
    }
    seen.add(r.offeringId);
    let reasons = cleanList(r.reasons, 140);
    if (reasons.length === 0) reasons = ["Ranked by the assistant; reason text was removed during validation."];
    let concerns = cleanList(r.concerns, 140);
    if (item.pricingModel === "PER_ATTENDEE" && !concerns.some((c) => GROWS_RE.test(c))) {
      concerns = [...concerns.slice(0, 2), PER_ATTENDEE_CONCERN];
    }
    ranked.push({ offeringId: r.offeringId, fit: r.fit, reasons: reasons.slice(0, 3), concerns: concerns.slice(0, 3) });
  }
  if (ranked.length === 0) warnings.push("No catalogue offerings matched.");
  return { output: { ranked: ranked.slice(0, 5), note: sanitizeText(p.note, 280) }, warnings };
}

/* -------------------------------- reveal ------------------------------------ */

export function validateReveal(raw: RevealSummary, aggregate: RevealAggregate): Validated<RevealSummary> {
  const warnings: string[] = [];
  const s = RevealSummarySchema.parse(raw);
  let total = s.suggestedAmountMinor;
  if (total < aggregate.minMinor || total > aggregate.maxMinor) {
    warnings.push(
      `suggestedAmountMinor ${total} was outside the vote range [${aggregate.minMinor}, ${aggregate.maxMinor}]; clamped to the median.`,
    );
    total = Math.min(Math.max(aggregate.medianMinor, aggregate.minMinor), aggregate.maxMinor);
  }
  const headline = sanitizeText(s.headline, 90) || "Budget poker results";
  const summary = sanitizeText(s.summary, 320) || "The group's votes are summarised above.";
  return { output: { headline, summary, suggestedAmountMinor: total }, warnings };
}

/* ------------------------------ dashboard NL -------------------------------- */

const NUMERIC_FIELDS = new Set([
  "closesWithinHours",
  "missingRequired",
  "requiredAccepted",
  "requiredInvited",
  "payersAuthorized",
  "minPayers",
  "authorizedTotalMinor",
  "capturedTotalMinor",
  "refundedTotalMinor",
]);
const BOOLEAN_FIELDS = new Set(["closesToday", "isFixture"]);

export function validateDashboardQuery(raw: DashboardQuery): Validated<DashboardQuery> {
  const warnings: string[] = [];
  const q = DashboardQuerySchema.parse(raw); // field/op whitelist enforced by the zod enums
  const filters: DashboardQuery["filters"] = [];
  for (const f of q.filters) {
    let value = f.value;
    if (typeof value === "string") value = sanitizeToken(value);
    else if (Array.isArray(value)) value = value.map(sanitizeToken).filter(Boolean);
    else if (typeof value === "number" && !Number.isFinite(value)) {
      warnings.push(`Dropped filter on ${f.field}: non-finite number.`);
      continue;
    }
    if (f.op === "in" ? !Array.isArray(value) : Array.isArray(value)) {
      warnings.push(`Dropped filter on ${f.field}: operator "${f.op}" does not fit the value.`);
      continue;
    }
    if (NUMERIC_FIELDS.has(f.field) && typeof value !== "number") {
      warnings.push(`Dropped filter on ${f.field}: expected a number.`);
      continue;
    }
    if (BOOLEAN_FIELDS.has(f.field) && typeof value !== "boolean") {
      warnings.push(`Dropped filter on ${f.field}: expected true/false.`);
      continue;
    }
    if (typeof value === "string" && value === "") {
      warnings.push(`Dropped filter on ${f.field}: empty value.`);
      continue;
    }
    filters.push({ field: f.field, op: f.op, value });
  }
  const explanation = sanitizeText(q.explanation, 240) || "Read-only dashboard filter.";
  return { output: { filters, sort: q.sort, focus: q.focus, explanation }, warnings };
}

/* ------------------------------- plan draft --------------------------------- */

/** A suggested deadline must leave the organizer this long to review before it (and before the 48 h limit) bites. */
export const PLAN_REVIEW_MARGIN_MS = 15 * 60 * 1000;
/** Mirrors QUOTE_VALIDITY_AFTER_DEADLINE_MS in lib/services/outings.ts; the service passes its own constant. */
export const DEFAULT_QUOTE_VALIDITY_AFTER_DEADLINE_MS = 24 * 60 * 60 * 1000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Instant -> "YYYY-MM-DDTHH:mm" wall time in `timeZone`. */
export function formatLocalWallTime(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

export type WallTimeResult = { ok: true; at: Date } | { ok: false; reason: string };

/**
 * "YYYY-MM-DDTHH:mm" wall time in `timeZone` -> UTC instant, DST-aware.
 * Refuses (never guesses) wall times that do not exist (clocks go forward)
 * or that happen twice (clocks go back).
 */
export function localWallTimeToUtc(local: string, timeZone: string): WallTimeResult {
  const m = LOCAL_WALL_TIME_RE.exec(local);
  if (!m) return { ok: false, reason: `"${sanitizeText(local, 40)}" is not a YYYY-MM-DDTHH:mm time.` };
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const cal = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || cal.getUTCMonth() !== month - 1 || cal.getUTCDate() !== day || hour > 23 || minute > 59) {
    return { ok: false, reason: `${local} is not a real date and time.` };
  }
  const sameWall = (d: Date) => {
    const p = zonedParts(d, timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };
  const at = zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);
  if (!sameWall(at)) return { ok: false, reason: `${local} does not exist in ${timeZone} (the clocks change that night).` };
  for (const deltaMin of [-60, -30, 30, 60]) {
    if (sameWall(new Date(at.getTime() + deltaMin * 60_000))) {
      return { ok: false, reason: `${local} happens twice in ${timeZone} (the clocks go back that night).` };
    }
  }
  return { ok: true, at };
}

export interface PlanDraftContext {
  /** Server time. */
  now: Date;
  /** Merchant IANA timezone the *Local strings are expressed in. */
  timezone: string;
  catalogue: readonly PlanCatalogueItem[];
  /** Active (not declined) participants. */
  roster: readonly PlanRosterEntry[];
  quoteValidityAfterDeadlineMs?: number;
}

const normName = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Check every suggested value against OUR data and the same rules
 * openCollection enforces. A failing field is DROPPED (left for the
 * organizer) with a human-readable note; nothing is ever adjusted to make it
 * pass.
 */
export function validatePlanDraft(raw: PlanDraft, ctx: PlanDraftContext): ValidatedPlanDraft {
  const d = PlanDraftSchema.parse(raw);
  const { now, timezone } = ctx;
  const dropped: PlanDraftDrop[] = [];
  const drop = (field: PlanDraftField, reason: string) => dropped.push({ field, reason: sanitizeText(reason, 240) });
  const people = ctx.roster.length;

  // Offering: exists, active, FIXED_TOTAL, fits everyone invited.
  let offering: PlanCatalogueItem | null = null;
  const item = ctx.catalogue.find((c) => c.offeringId === d.offeringId);
  if (!item) drop("offeringId", `The suggested offering "${sanitizeText(d.offeringId, 60)}" is not in our catalogue.`);
  else if (!item.active) drop("offeringId", `${item.name} is no longer available.`);
  else if (item.pricingModel !== "FIXED_TOTAL") {
    drop("offeringId", `${item.name} is priced per attendee. Shared bookings need a fixed total so more attendees lower each share.`);
  } else if (item.capacity < people) drop("offeringId", `${item.name} fits ${item.capacity} people; ${people} are invited.`);
  else offering = item;

  // Activity: a real future wall time inside the offering's availability.
  let activityAt: Date | null = null;
  if (!d.activityStartLocal.trim()) drop("activityStart", "The AI did not suggest an activity time.");
  else {
    const t = localWallTimeToUtc(d.activityStartLocal, timezone);
    if (!t.ok) drop("activityStart", `Activity time: ${t.reason}`);
    else if (t.at.getTime() <= now.getTime()) drop("activityStart", `The suggested activity time ${d.activityStartLocal} is in the past.`);
    else if (!offering) drop("activityStart", "Not checked against availability because the suggested offering was dropped.");
    else {
      const pseudo: Pick<Offering, "name" | "active" | "availability"> = {
        name: offering.name,
        active: offering.active,
        availability: { weekdays: offering.availability.weekdays, startHours: offering.availability.startHours, source: "FIXTURE" },
      };
      const av = checkAvailability(pseudo as Offering, timezone, t.at);
      if (!av.available) drop("activityStart", av.reason ?? `${offering.name} is not available then.`);
      else activityAt = t.at;
    }
  }

  // Deadline: the commitment-deadline policy (<= 48 h, >= 1 min, before the activity, quote grace) + review margin.
  let deadlineAt: Date | null = null;
  if (!d.deadlineLocal.trim()) drop("deadline", "The AI did not suggest a commitment deadline.");
  else {
    const t = localWallTimeToUtc(d.deadlineLocal, timezone);
    if (!t.ok) drop("deadline", `Commitment deadline: ${t.reason}`);
    else if (!activityAt) drop("deadline", "Not checked because the suggested activity time was dropped.");
    else {
      const validity = ctx.quoteValidityAfterDeadlineMs ?? DEFAULT_QUOTE_VALIDITY_AFTER_DEADLINE_MS;
      const window = t.at.getTime() - now.getTime();
      try {
        validateCommitmentDeadline({ now, deadlineAt: t.at, activityAt, quoteExpiresAt: new Date(t.at.getTime() + validity) });
        if (window < PLAN_REVIEW_MARGIN_MS) drop("deadline", "The suggested deadline leaves less than 15 minutes to review and open commitments.");
        else if (window > MAX_COMMITMENT_WINDOW_MS - PLAN_REVIEW_MARGIN_MS) {
          drop("deadline", "The suggested deadline is so close to the 48-hour limit that it would expire while you review.");
        } else deadlineAt = t.at;
      } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
        drop("deadline", e.message);
      }
    }
  }

  // Sponsored guest: null, or exactly one invited (non-organizer) participant. One name => at most one sponsored guest.
  let sponsor: ValidatedPlanDraft["sponsor"] = null;
  const wanted = d.sponsoredParticipantName?.trim() ?? "";
  if (!wanted) sponsor = { name: null };
  else {
    let matches = ctx.roster.filter((p) => p.name === wanted);
    if (matches.length === 0) matches = ctx.roster.filter((p) => normName(p.name) === normName(wanted));
    const shown = sanitizeText(wanted, 40);
    if (matches.length === 0) drop("sponsor", `"${shown}" doesn't match anyone invited, so nobody was marked as sponsored.`);
    else if (matches.length > 1) drop("sponsor", `"${shown}" matches more than one invited person.`);
    else if (matches[0].isOrganizer) drop("sponsor", "The organizer always pays a share and can't be the sponsored guest.");
    else sponsor = { name: matches[0].name };
  }

  // Minimum payers: 1 .. the people paying once the suggested sponsorship applies (current payers if it was dropped).
  const payers = sponsor ? people - (sponsor.name ? 1 : 0) : ctx.roster.filter((p) => p.payer).length;
  let minPayers: number | null = null;
  if (!Number.isSafeInteger(d.minPayers) || d.minPayers < 1 || d.minPayers > payers) {
    drop("minPayers", `Minimum payers must be between 1 and ${payers} (the people paying); the AI suggested ${d.minPayers}.`);
  } else minPayers = d.minPayers;

  return {
    offeringId: offering?.offeringId ?? null,
    activityStartLocal: activityAt ? d.activityStartLocal : null,
    activityAt: activityAt?.toISOString() ?? null,
    deadlineLocal: deadlineAt ? d.deadlineLocal : null,
    deadlineAt: deadlineAt?.toISOString() ?? null,
    minPayers,
    sponsor,
    rationale: cleanList(d.rationale, 140).slice(0, 4),
    cautions: cleanList(d.cautions, 140).slice(0, 3),
    dropped,
  };
}
