/**
 * FIXTURE implementation: deterministic keyword/regex heuristics. This is
 * NOT a model. Every result carries source "FIXTURE", model null, and a
 * leading "Fixture ..." warning; explanation strings are prefixed so the UI
 * can never present it as model output.
 */
import type {
  AiResult,
  BriefExtraction,
  CatalogueItemForAi,
  DashboardQuery,
  OutingsAi,
  PlanCatalogueItem,
  PlanDraft,
  PlanDraftInput,
  PlanRosterEntry,
  Proposal,
  ProposalInput,
  RevealAggregate,
  RevealSummary,
} from "./types";
import {
  AiOutputError,
  formatLocalWallTime,
  validateBrief,
  validateDashboardQuery,
  validateProposal,
  validateReveal,
} from "./validate";
import { bookingTotalMinor, budgetFit, perPersonShareMinor } from "../domain/budget-fit";
import { formatMoney, isCurrency } from "../domain/money";
import { zonedParts, zonedTimeToUtc } from "../services/catalogue";

const BANNER = "FIXTURE output: deterministic keyword heuristics, not a model.";

const NUM_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  eighteen: 18, twenty: 20,
};
const DAYS: [RegExp, BriefExtraction["dateWindow"]["dayOfWeek"], string][] = [
  [/\b(mon(day)?)\b/i, "MON", "Monday"],
  [/\b(tue(s|sday)?)\b/i, "TUE", "Tuesday"],
  [/\b(wed(nesday)?)\b/i, "WED", "Wednesday"],
  [/\b(thu(r|rs|rsday)?)\b/i, "THU", "Thursday"],
  [/\b(fri(day)?)\b/i, "FRI", "Friday"],
  [/\b(sat(urday)?)\b/i, "SAT", "Saturday"],
  [/\b(sun(day)?)\b/i, "SUN", "Sunday"],
];
const CATEGORY_KEYWORDS: [RegExp, string, string][] = [
  [/karaoke/i, "karaoke", "Karaoke"],
  [/pottery|ceramic/i, "pottery", "Pottery"],
  [/escape/i, "escape-room", "Escape room"],
  [/bowling/i, "bowling", "Bowling"],
  [/dinner|restaurant|supper/i, "dinner", "Dinner"],
  [/\b(?:movies?|films?|cinema|screening)\b/i, "cinema", "Movie night"],
  [/\bwines?\b/i, "wine-tasting", "Wine tasting"],
  [/\bgym\b|\bwork ?out\b|\btraining\b|\bfitness\b/i, "fitness", "Gym session"],
  [/\bpadel\b/i, "padel", "Padel"],
];

function groupSize(text: string): { count: number | null; isEstimate: boolean } {
  const word = text.match(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty)\s+of\s+us\b/i);
  if (word) return { count: NUM_WORDS[word[1].toLowerCase()], isEstimate: false };
  const digits =
    text.match(/\b(\d{1,2})\s+(?:of\s+us|people|friends|guests|attendees|ppl)\b/i) ??
    text.match(/\b(?:group|party|team)\s+of\s+(\d{1,2})\b/i) ??
    text.match(/\bfor\s+(\d{1,2})\b(?!\s*(?:\$|dollars|hours?|minutes?))/i);
  if (digits) {
    const n = Number(digits[1]);
    if (n >= 1 && n <= 50) return { count: n, isEstimate: /\b(about|around|roughly|~|approx)/i.test(text) };
  }
  const bare = text.match(/\b(?:about|around|roughly)\s+(\d{1,2})\b/i);
  if (bare) return { count: Number(bare[1]), isEstimate: true };
  return { count: null, isEstimate: false };
}

function budget(text: string): BriefExtraction["budget"] {
  const m =
    text.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/) ??
    text.match(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i) ??
    text.match(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:total|per person|each|a head|pp)\b/i);
  if (!m) return { amountMinor: null, unit: "UNKNOWN" };
  const amount = Math.round(Number(m[1].replace(/,/g, "")) * 100);
  const ctx = text.slice(Math.max(0, (m.index ?? 0) - 25), (m.index ?? 0) + m[0].length + 30);
  const per = /per[- ]?(?:person|head|guest)|\beach\b|a head|\bpp\b|\/person|apiece/i.test(ctx);
  const tot = /\btotal\b|altogether|all[- ]in|in all|overall/i.test(ctx);
  const unit: BriefExtraction["budget"]["unit"] = per && !tot ? "PER_PERSON" : tot && !per ? "TOTAL" : "UNKNOWN";
  return { amountMinor: amount > 0 ? amount : null, unit };
}


/* ----------------------------- plan draft rules ----------------------------- */

const HOUR_MS = 60 * 60 * 1000;
/** Earliest activity the fixture planner suggests (leaves room for a deadline ~2 h before it). */
const PLAN_MIN_LEAD_MS = 4 * HOUR_MS;
const PLAN_DEADLINE_BEFORE_ACTIVITY_MS = 2 * HOUR_MS;
const PLAN_MAX_DEADLINE_MS = 24 * HOUR_MS;
const WEEKDAY_CODE: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type PartOfDay = NonNullable<BriefExtraction["dateWindow"]["partOfDay"]>;
const PART_OF_DAY: Record<PartOfDay, { from: number; to: number; preferred: number; label: string }> = {
  MORNING: { from: 8, to: 11, preferred: 10, label: "morning" },
  AFTERNOON: { from: 12, to: 16, preferred: 14, label: "afternoon" },
  EVENING: { from: 17, to: 20, preferred: 19, label: "evening" },
  NIGHT: { from: 21, to: 23, preferred: 21, label: "night" },
};

/** Start hour closest to the preferred one (ties -> earlier), preferring hours inside the part of day. */
function pickHour(startHours: readonly number[], part: (typeof PART_OF_DAY)[PartOfDay]): { hour: number; inWindow: boolean } | null {
  const hours = [...new Set(startHours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
  if (hours.length === 0) return null;
  const inside = hours.filter((h) => h >= part.from && h <= part.to);
  const pool = inside.length ? inside : hours;
  const hour = pool.reduce((best, h) => (Math.abs(h - part.preferred) < Math.abs(best - part.preferred) ? h : best), pool[0]);
  return { hour, inWindow: inside.length > 0 };
}

/** Next `hour`:00 (merchant wall time) on an available (and, if given, wanted) weekday, at least PLAN_MIN_LEAD_MS away. */
function nextSlot(now: Date, tz: string, weekdays: readonly number[], hour: number, wantDay: number | null): Date | null {
  const p = zonedParts(now, tz);
  for (let d = 0; d < 15; d++) {
    const cal = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    const wd = cal.getUTCDay();
    if (!weekdays.includes(wd) || (wantDay !== null && wd !== wantDay)) continue;
    const local = { year: cal.getUTCFullYear(), month: cal.getUTCMonth() + 1, day: cal.getUTCDate(), hour, minute: 0 };
    const at = zonedTimeToUtc(local, tz);
    const back = zonedParts(at, tz);
    if (back.day !== local.day || back.hour !== hour || back.minute !== 0) continue; // wall time skipped by a DST change
    if (at.getTime() - now.getTime() < PLAN_MIN_LEAD_MS) continue;
    return at;
  }
  return null;
}

/** Round down to the start of the local hour in `tz`. */
function floorToLocalHour(at: Date, tz: string): Date {
  const p = zonedParts(at, tz);
  return new Date(at.getTime() - p.minute * 60_000 - p.second * 1000 - at.getUTCMilliseconds());
}

/** Full-name match first, then a unique first-name match ("Maya" -> "Maya Jensen"). */
function findInvitee(invitees: readonly PlanRosterEntry[], name: string): PlanRosterEntry | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(name);
  const exact = invitees.filter((p) => norm(p.name) === want);
  if (exact.length === 1) return exact[0];
  const first = invitees.filter((p) => norm(p.name).split(" ")[0] === want.split(" ")[0]);
  return first.length === 1 ? first[0] : null;
}

const RANKER_LABEL = "Fixture ranker: ";

/**
 * Honesty label for one ranked offering: the first reason says it comes from the fixture ranker, the rest
 * are plain sentences. One label per card is enough; on every line it buried the reasons themselves.
 */
function labelFirstReason(reasons: readonly string[]): string[] {
  const [first, ...rest] = reasons;
  if (first === undefined) return [];
  return [`${RANKER_LABEL}${first.charAt(0).toLowerCase()}${first.slice(1)}`, ...rest];
}

interface BudgetVerdict {
  within: boolean;
  /** The sentence to show, or null when the application shows the comparison itself. */
  text: string | null;
}

/**
 * Budget check for one offering, in the unit the group agreed. Against a per-person budget the share is the
 * application's own figure (never worked out here); against a total it is the whole booking.
 *
 * A per-person verdict only orders the ranking. It gets no sentence: the venue card recomputes the share from
 * the live roster, and a sentence frozen here would contradict it as soon as a guest is covered.
 */
function budgetVerdict(item: CatalogueItemForAi, input: ProposalInput, groupSize: number | null): BudgetVerdict | null {
  const budget = input.agreedBudgetMinor;
  if (budget === null) return null;
  if (input.budgetUnit === "PER_PERSON") {
    const share = item.perPersonShareMinor ?? null;
    if (share === null) return null;
    return { within: budgetFit(share, budget).kind === "WITHIN", text: null };
  }
  if (groupSize === null) return null;
  const within = budgetFit(bookingTotalMinor(item, groupSize), budget).kind === "WITHIN";
  return { within, text: within ? "Estimated total is within the agreed budget." : "Estimated total exceeds the agreed budget." };
}

/** Why the chosen offering may be above what the group agreed, or null. `payers` is who pays once the suggested sponsorship applies. */
function planBudgetCaution(offering: PlanCatalogueItem, input: PlanDraftInput, payers: number): string | null {
  const budget = input.agreedBudgetMinor;
  if (offering.pricingModel !== "FIXED_TOTAL" || budget === null || offering.currency !== "USD") return null;
  if (input.budgetUnit !== "PER_PERSON") {
    if (offering.priceMinor <= budget) return null;
    return `Fixture planner: the ${formatMoney(offering.priceMinor)} fixed total is above the agreed ${formatMoney(budget)} budget.`;
  }
  if (payers < 1) return null;
  const share = perPersonShareMinor(offering, { attendees: input.roster.length, payers });
  if (share <= budget) return null;
  return `Fixture planner: about ${formatMoney(share)} each with ${payers} paying is above the agreed ${formatMoney(budget)} per person.`;
}

export class FixtureOutingsAi implements OutingsAi {
  readonly source = "FIXTURE" as const;

  private wrap<T>(output: T, warnings: string[]): AiResult<T> {
    return { source: "FIXTURE", model: null, output, warnings: [BANNER, ...warnings] };
  }

  async extractBrief(input: { brief: string; now: Date; timezone: string; categories?: string[] }): Promise<AiResult<BriefExtraction>> {
    const text = input.brief;
    const cats = CATEGORY_KEYWORDS.filter(([re]) => re.test(text));
    const day = DAYS.find(([re]) => re.test(text));
    const partOfDay: BriefExtraction["dateWindow"]["partOfDay"] = /evening|tonight|after work/i.test(text)
      ? "EVENING"
      : /morning|brunch/i.test(text)
        ? "MORNING"
        : /afternoon|lunch/i.test(text)
          ? "AFTERNOON"
          : /late[- ]night|\bnight\b/i.test(text)
            ? "NIGHT"
            : null;
    const size = groupSize(text);
    const bud = budget(text);

    const forName = text.match(/\bfor\s+([A-Z][a-z]+)(?:'s|’s)\s+(?:birthday|bday|party)/);
    const coverName = text.match(/\bcover\s+([A-Z][a-z]+)(?:'s|’s)?\s*(?:share|part|ticket|cost)?/);
    const cover = /\bcover\s+(?:[A-Z][a-z]+(?:'s|’s)?\s+)?(?:share|part|ticket|cost)/i.test(text) || /\bcover\s+[A-Z][a-z]+'s\b/.test(text);
    const birthday = /birthday|bday/i.test(text);
    const name = forName?.[1] ?? (cover ? coverName?.[1] ?? null : null) ?? null;

    const needs: string[] = [];
    if (/private room|own room|private space/i.test(text)) needs.push("Private room");
    if (/accessib|wheelchair|step[- ]free/i.test(text)) needs.push("Accessibility");
    if (/vegetarian|vegan|gluten|allerg/i.test(text)) needs.push("Dietary needs");

    const prefersFixed = cover || /fixed|flat (?:fee|price)|private room|split (?:it|the cost)|more people/i.test(text);

    const activity = cats[0]?.[2] ?? "outing";
    const title = name && birthday ? `${name}'s birthday ${activity.toLowerCase()}` : `Group ${activity.toLowerCase()}`;

    const uncertainties: string[] = [];
    if (bud.amountMinor === null) uncertainties.push("Budget not stated.");
    else if (bud.unit === "UNKNOWN") uncertainties.push("Unclear whether the budget is a total or per person.");
    if (size.count === null) uncertainties.push("Group size not stated.");
    if (!day) uncertainties.push("Day not stated.");
    if (cats.length === 0) uncertainties.push("No activity type recognised.");

    const dateDesc = [day?.[2], partOfDay?.toLowerCase()].filter(Boolean).join(" ");
    const summary: BriefExtraction["summary"] = [];
    if (cats.length) summary.push({ icon: "activity", text: `${activity}${birthday ? " for a birthday" : ""}` });
    if (dateDesc) summary.push({ icon: "date", text: dateDesc });
    if (size.count !== null) summary.push({ icon: "people", text: `${size.count} people${size.isEstimate ? " (estimate)" : ""}` });
    if (name && cover) summary.push({ icon: "gift", text: `Group covers ${name}'s share` });
    summary.push({
      icon: "budget",
      text: bud.amountMinor === null ? "Budget not stated yet" : `$${(bud.amountMinor / 100).toFixed(2)} ${bud.unit === "PER_PERSON" ? "per person" : bud.unit === "TOTAL" ? "total" : "(unit unclear)"}`,
    });
    for (const n of needs) summary.push({ icon: "place", text: n });

    const raw: BriefExtraction = {
      title,
      activityIdeas: cats.map((c) => c[2]),
      categories: cats.map((c) => c[1]),
      dateWindow: { description: dateDesc, dayOfWeek: day?.[1] ?? null, partOfDay },
      groupSize: size,
      budget: bud,
      guestOfHonour: { name, coverTheirShare: Boolean(name && cover) },
      prefersFixedTotal: prefersFixed,
      needs,
      uncertainties,
      summary: summary.slice(0, 6),
      // The fixture parser never suggests vote amounts; the app's deterministic ladder
      // (lib/domain/budget-options.ts) computes them and is labelled as such.
      suggestedVotePerPersonMinor: null,
    };
    const v = validateBrief(raw, { categories: input.categories, sourceText: text });
    return this.wrap(v.output, ["Fixture parser: extracted with regex/keyword rules.", ...v.warnings]);
  }

  async proposeOfferings(input: ProposalInput): Promise<AiResult<Proposal>> {
    const n = input.groupSize ?? input.extraction.groupSize.count;
    const wantsPrivate = input.extraction.needs.some((x) => /private/i.test(x));
    const scored = input.catalogue.map((item) => {
      let score = 0;
      const reasons: string[] = [];
      const concerns: string[] = [];
      const catMatch = input.extraction.categories.some((c) => c.toLowerCase() === item.category.toLowerCase());
      if (catMatch) {
        score += 4;
        reasons.push(`Category "${item.category}" matches the brief.`);
      }
      if (n !== null) {
        if (n >= item.minAttendees && n <= item.capacity) {
          score += 2;
          reasons.push(`Fits a group of ${n}.`);
        } else concerns.push(`Group of ${n} is outside ${item.minAttendees}-${item.capacity}.`);
      }
      const verdict = budgetVerdict(item, input, n);
      if (verdict?.within) score += 2;
      if (verdict?.text) (verdict.within ? reasons : concerns).push(verdict.text);
      if (input.extraction.prefersFixedTotal && item.pricingModel === "FIXED_TOTAL") {
        score += 1;
        reasons.push("Fixed total, so more attendees lower each share.");
      }
      if (wantsPrivate && item.tags.some((t) => /private/i.test(t))) {
        score += 1;
        reasons.push("Tagged as private.");
      }
      if (reasons.length === 0) reasons.push("Weak match; listed for completeness.");
      return { item, score, reasons: labelFirstReason(reasons), concerns, catMatch };
    });
    // Category first (as the note says), so an unrelated cheap offering never outranks the activity asked for.
    scored.sort(
      (a, b) =>
        Number(b.catMatch) - Number(a.catMatch) || b.score - a.score || a.item.offeringId.localeCompare(b.item.offeringId),
    );
    // When the brief names an activity, a different activity is at best a stretch, however well it fits otherwise.
    const briefHasCategory = input.extraction.categories.length > 0;
    const fitOf = (s: (typeof scored)[number]): Proposal["ranked"][number]["fit"] => {
      if (briefHasCategory && !s.catMatch) return "STRETCH";
      return s.score >= 7 ? "GREAT" : s.score >= 4 ? "GOOD" : "STRETCH";
    };
    const raw: Proposal = {
      ranked: scored
        .filter((s) => s.score > 0)
        .slice(0, 5)
        .map((s) => ({
          offeringId: s.item.offeringId,
          fit: fitOf(s),
          reasons: s.reasons.slice(0, 3).map((r) => r.slice(0, 140)),
          concerns: s.concerns.slice(0, 3).map((r) => r.slice(0, 140)),
        })),
      note: "Fixture ranker: ordered by category, capacity and budget fit. Prices and totals are computed by the app, not by this ranking.",
    };
    const v = validateProposal(raw, input.catalogue);
    return this.wrap(v.output, v.warnings);
  }

  async summarizeReveal(input: { aggregate: RevealAggregate; extraction: BriefExtraction | null }): Promise<AiResult<RevealSummary>> {
    // The headline carries the "Fixture summary" label once; the sentence under it does not repeat it.
    const a = input.aggregate;
    // Same money formatting as every other screen ("$45", not "45.00 USD").
    const fmt = (m: number) => (isCurrency(a.currency) ? formatMoney(m, a.currency) : `${(m / 100).toFixed(2)} ${a.currency}`);
    // A vote is what one person would pay, or (older outings) a total for the group: the words always say which.
    const perPerson = a.unit === "PER_PERSON";
    const median = perPerson ? `the median is ${fmt(a.medianMinor)} per person` : `the median proposed total is ${fmt(a.medianMinor)}`;
    const raw: RevealSummary = {
      headline: `Fixture summary: votes ranged ${fmt(a.minMinor)} to ${fmt(a.maxMinor)}${perPerson ? " per person" : ""}`,
      summary: `${a.voteCount} of ${a.invitedCount} invitees voted; ${median}. Votes are proposals, not payment authorizations. The organizer chooses the final quote.`,
      suggestedAmountMinor: a.medianMinor,
    };
    const v = validateReveal(raw, a);
    return this.wrap(v.output, v.warnings);
  }

  async dashboardQuery(input: { question: string; now: Date }): Promise<AiResult<DashboardQuery>> {
    const q = input.question.toLowerCase();
    const filters: DashboardQuery["filters"] = [];
    const parts: string[] = [];
    const unknown: string[] = [];

    if (/clos(?:es|ing|e)\s+today|due today|deadline today/.test(q)) {
      filters.push({ field: "closesToday", op: "eq", value: true });
      parts.push("closing today");
    }
    const within = q.match(/(?:within|in the next)\s+(\d{1,3})\s*(?:h|hours?)/);
    if (within) {
      filters.push({ field: "closesWithinHours", op: "lte", value: Number(within[1]) });
      parts.push(`closing within ${within[1]}h`);
    } else if (/clos(?:es|ing)\s+soon/.test(q)) {
      filters.push({ field: "closesWithinHours", op: "lte", value: 24 });
      parts.push("closing within 24h");
    }
    if (/missing\s+(?:required|participants?|people)|required.*(?:missing|outstanding|not (?:yet )?accepted)/.test(q)) {
      filters.push({ field: "missingRequired", op: "gt", value: 0 });
      parts.push("with missing required participants");
    }
    if (/refund(?:s|ing)?\s+pending|pending\s+refunds?/.test(q)) {
      filters.push({ field: "cleanup", op: "eq", value: "REFUND_PENDING" });
      parts.push("with refunds pending");
    } else if (/needs? attention|stuck|failed cleanup/.test(q)) {
      filters.push({ field: "cleanup", op: "eq", value: "NEEDS_ATTENTION" });
      parts.push("needing attention");
    }
    if (/fixture|sandbox|test mode|demo/.test(q)) {
      const sandbox = /sandbox/.test(q) && !/fixture/.test(q);
      filters.push({ field: "isFixture", op: "eq", value: !sandbox });
      parts.push(sandbox ? "using the PayPal sandbox" : "in fixture mode");
    }
    for (const status of ["confirmed", "cancelled", "collecting", "settling", "compensating", "proposed", "budgeting", "draft"]) {
      if (new RegExp(`\\b${status}\\b`).test(q)) {
        filters.push({ field: "status", op: "eq", value: status.toUpperCase() });
        parts.push(`status ${status.toUpperCase()}`);
        break;
      }
    }
    if (/captured/.test(q) && !/refund/.test(q)) {
      filters.push({ field: "capturedTotalMinor", op: "gt", value: 0 });
      parts.push("with captured money");
    }
    if (filters.length === 0) unknown.push("no recognised keywords; showing all outings");

    let focus: DashboardQuery["focus"] = null;
    if (/chart.*status|status.*chart/.test(q)) focus = "STATUS_CHART";
    else if (/money|amount|total/.test(q) && /chart|graph/.test(q)) focus = "MONEY_CHART";
    else if (/readiness|ready/.test(q)) focus = "READINESS";
    else if (filters.length) focus = "BOOKINGS_TABLE";

    const sort: DashboardQuery["sort"] = filters.some((f) => f.field === "closesToday" || f.field === "closesWithinHours")
      ? { field: "closesWithinHours", direction: "asc" }
      : null;

    const raw: DashboardQuery = {
      filters,
      sort,
      focus,
      explanation: `Fixture parser: outings ${parts.join(", ") || "(all)"}${unknown.length ? ` (${unknown[0]})` : ""}. Read-only filter, keyword-matched.`.slice(0, 240),
    };
    const v = validateDashboardQuery(raw);
    return this.wrap(v.output, v.warnings);
  }
  /**
   * Deterministic plan: the selected (else top-ranked) fixed-total offering
   * that fits everyone; the next slot matching the brief's weekday and part
   * of day within its availability; deadline = min(activity - 2 h, now + 24 h)
   * rounded down to the hour; minPayers = everyone paying; sponsor = the
   * guest of honour when the brief says the group covers their share.
   * Output is still validated by the service like any model output.
   */
  async draftPlan(input: PlanDraftInput): Promise<AiResult<PlanDraft>> {
    const { extraction: ex, now, timezone: tz, roster } = input;
    const rationale: string[] = [];
    const cautions: string[] = [];
    const fits = (c: PlanCatalogueItem) => c.active && c.pricingModel === "FIXED_TOTAL" && c.capacity >= roster.length;
    const selected = input.catalogue.find((c) => c.offeringId === input.selectedOfferingId) ?? null;
    const offering = selected && fits(selected) ? selected : input.catalogue.find(fits) ?? selected ?? input.catalogue[0] ?? null;
    if (!offering) throw new AiOutputError("Fixture planner: no catalogue offering to plan with");
    rationale.push(
      offering === selected
        ? `Fixture planner: keeps your choice, ${offering.name}.`
        : `Fixture planner: ${offering.name} is the top-ranked fixed-total option that fits everyone invited.`,
    );
    // The budget caution belongs here, with the offering, but a per-person share needs the sponsor decided below.
    const budgetCautionAt = cautions.length;

    // Activity slot.
    const part = PART_OF_DAY[ex.dateWindow.partOfDay ?? "EVENING"];
    if (!ex.dateWindow.partOfDay) cautions.push("Fixture planner: the brief doesn't say a time of day, so an evening slot is suggested.");
    const picked = pickHour(offering.availability.startHours, part);
    if (picked && !picked.inWindow) {
      cautions.push(`Fixture planner: ${offering.name} has no ${part.label} start times, so ${String(picked.hour).padStart(2, "0")}:00 is suggested.`);
    }
    const wantDay = ex.dateWindow.dayOfWeek ? WEEKDAY_CODE[ex.dateWindow.dayOfWeek] ?? null : null;
    let activity = picked ? nextSlot(now, tz, offering.availability.weekdays, picked.hour, wantDay) : null;
    if (!activity && picked && wantDay !== null) {
      activity = nextSlot(now, tz, offering.availability.weekdays, picked.hour, null);
      if (activity) cautions.push(`Fixture planner: no ${WEEKDAY_LONG[wantDay]} slot is available soon enough, so the next open day is suggested.`);
    }
    let deadline: Date | null = null;
    if (activity) {
      const local = formatLocalWallTime(activity, tz);
      const day = WEEKDAY_LONG[zonedParts(activity, tz).weekday];
      rationale.push(`Fixture planner: ${day} ${local.slice(11)} is the next ${offering.name} start time matching the brief.`);
      deadline = floorToLocalHour(
        new Date(Math.min(activity.getTime() - PLAN_DEADLINE_BEFORE_ACTIVITY_MS, now.getTime() + PLAN_MAX_DEADLINE_MS)),
        tz,
      );
      rationale.push("Fixture planner: commitments close 2 hours before the activity or within 24 hours, whichever is sooner.");
    } else {
      cautions.push(`Fixture planner: no ${offering.name} start time was found in the next two weeks; pick a time yourself.`);
    }

    // Sponsored guest.
    const invitees = roster.filter((p) => !p.isOrganizer);
    const current = roster.find((p) => p.sponsored) ?? null;
    const honour = ex.guestOfHonour;
    let sponsor: PlanRosterEntry | null = null;
    if (honour.name && honour.coverTheirShare) {
      sponsor = findInvitee(invitees, honour.name);
      if (sponsor) rationale.push(`Fixture planner: the brief says the group covers ${sponsor.name}'s share.`);
      else {
        cautions.push(`Fixture planner: the brief covers ${honour.name}'s share, but nobody by that name is invited yet.`);
        sponsor = current;
      }
    } else if (current) {
      sponsor = current;
      rationale.push(`Fixture planner: keeps ${current.name}'s share covered, as you set it.`);
    } else if (honour.name) {
      cautions.push(`Fixture planner: ${honour.name} is the guest of honour, but the brief doesn't say the group covers their share.`);
    }

    const payers = roster.length - (sponsor ? 1 : 0);
    const budgetCaution = planBudgetCaution(offering, input, payers);
    if (budgetCaution) cautions.splice(budgetCautionAt, 0, budgetCaution);

    const raw: PlanDraft = {
      offeringId: offering.offeringId,
      activityStartLocal: activity ? formatLocalWallTime(activity, tz) : "",
      deadlineLocal: deadline ? formatLocalWallTime(deadline, tz) : "",
      minPayers: payers,
      sponsoredParticipantName: sponsor?.name ?? null,
      rationale: rationale.slice(0, 4).map((r) => r.slice(0, 140)),
      cautions: cautions.slice(0, 3).map((r) => r.slice(0, 140)),
    };
    return this.wrap(raw, ["Fixture planner: deterministic slot, deadline and sponsor rules."]);
  }
}
