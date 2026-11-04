/**
 * Domain validation shared by the Anthropic and FIXTURE implementations.
 * Zod validates SHAPE; this module validates against OUR data (catalogue,
 * aggregates, whitelists) and sanitizes free text. It never invents data.
 */
import {
  BriefExtractionSchema,
  DashboardQuerySchema,
  ProposalSchema,
  RevealSummarySchema,
  type BriefExtraction,
  type CatalogueItemForAi,
  type DashboardQuery,
  type Proposal,
  type RevealAggregate,
  type RevealSummary,
} from "./types";

export const MAX_BUDGET_MINOR = 10_000_000;

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
    // eslint-disable-next-line no-control-regex
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
  };
  return { output, warnings };
}

/* ------------------------------- proposals ---------------------------------- */

const GROWS_RE = /(attendee|per[- ]?person|per head|grows?|increase|scales?)/i;
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
  let total = s.suggestedTotalMinor;
  if (total < aggregate.minMinor || total > aggregate.maxMinor) {
    warnings.push(
      `suggestedTotalMinor ${total} was outside the vote range [${aggregate.minMinor}, ${aggregate.maxMinor}]; clamped to the median.`,
    );
    total = Math.min(Math.max(aggregate.medianMinor, aggregate.minMinor), aggregate.maxMinor);
  }
  const headline = sanitizeText(s.headline, 90) || "Budget poker results";
  const summary = sanitizeText(s.summary, 320) || "The group's votes are summarised above.";
  return { output: { headline, summary, suggestedTotalMinor: total }, warnings };
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
const BOOLEAN_FIELDS = new Set(["closesToday", "cleanup", "isFixture"]);

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
