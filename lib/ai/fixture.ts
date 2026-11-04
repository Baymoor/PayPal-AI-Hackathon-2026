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
  Proposal,
  RevealAggregate,
  RevealSummary,
} from "./types";
import { validateBrief, validateDashboardQuery, validateProposal, validateReveal } from "./validate";

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
    };
    const v = validateBrief(raw, { categories: input.categories, sourceText: text });
    return this.wrap(v.output, ["Fixture parser: extracted with regex/keyword rules.", ...v.warnings]);
  }

  async proposeOfferings(input: {
    extraction: BriefExtraction;
    catalogue: CatalogueItemForAi[];
    agreedBudgetMinor: number | null;
    groupSize: number | null;
  }): Promise<AiResult<Proposal>> {
    const n = input.groupSize ?? input.extraction.groupSize.count;
    const budget = input.agreedBudgetMinor;
    const wantsPrivate = input.extraction.needs.some((x) => /private/i.test(x));
    const scored = input.catalogue.map((item) => {
      let score = 0;
      const reasons: string[] = [];
      const concerns: string[] = [];
      const catMatch = input.extraction.categories.some((c) => c.toLowerCase() === item.category.toLowerCase());
      if (catMatch) {
        score += 4;
        reasons.push(`Fixture ranker: category "${item.category}" matches the brief.`);
      }
      if (n !== null) {
        if (n >= item.minAttendees && n <= item.capacity) {
          score += 2;
          reasons.push(`Fixture ranker: fits a group of ${n}.`);
        } else concerns.push(`Fixture ranker: group of ${n} is outside ${item.minAttendees}-${item.capacity}.`);
      }
      if (budget !== null && n !== null) {
        const total = item.pricingModel === "FIXED_TOTAL" ? item.priceMinor : item.priceMinor * n;
        if (total <= budget) {
          score += 2;
          reasons.push("Fixture ranker: estimated total is within the agreed budget.");
        } else concerns.push("Fixture ranker: estimated total exceeds the agreed budget.");
      }
      if (input.extraction.prefersFixedTotal && item.pricingModel === "FIXED_TOTAL") {
        score += 1;
        reasons.push("Fixture ranker: fixed total, so more attendees lower each share.");
      }
      if (wantsPrivate && item.tags.some((t) => /private/i.test(t))) {
        score += 1;
        reasons.push("Fixture ranker: tagged as private.");
      }
      if (reasons.length === 0) reasons.push("Fixture ranker: weak match; listed for completeness.");
      return { item, score, reasons, concerns };
    });
    scored.sort((a, b) => b.score - a.score || a.item.offeringId.localeCompare(b.item.offeringId));
    const raw: Proposal = {
      ranked: scored
        .filter((s) => s.score > 0)
        .slice(0, 5)
        .map((s) => ({
          offeringId: s.item.offeringId,
          fit: s.score >= 7 ? "GREAT" : s.score >= 4 ? "GOOD" : "STRETCH",
          reasons: s.reasons.slice(0, 3).map((r) => r.slice(0, 140)),
          concerns: s.concerns.slice(0, 3).map((r) => r.slice(0, 140)),
        })),
      note: "Fixture ranker: ordered by category, capacity and budget fit. Prices and totals are computed by the app, not by this ranking.",
    };
    const v = validateProposal(raw, input.catalogue);
    return this.wrap(v.output, v.warnings);
  }

  async summarizeReveal(input: { aggregate: RevealAggregate; extraction: BriefExtraction | null }): Promise<AiResult<RevealSummary>> {
    const a = input.aggregate;
    const fmt = (m: number) => `${(m / 100).toFixed(2)} ${a.currency}`;
    const raw: RevealSummary = {
      headline: `Fixture summary: votes ranged ${fmt(a.minMinor)} to ${fmt(a.maxMinor)}`,
      summary: `Fixture summary: ${a.voteCount} of ${a.invitedCount} invitees voted; the median proposed total is ${fmt(a.medianMinor)}. Votes are proposals, not payment authorizations. The organizer chooses the final quote.`,
      suggestedTotalMinor: a.medianMinor,
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
}
