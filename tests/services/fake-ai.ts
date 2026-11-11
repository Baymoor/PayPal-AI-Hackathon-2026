/**
 * Controllable stand-in for lib/ai `getOutingsAi()` in service/access tests.
 * Results are labelled source "FIXTURE" (deterministic, not a model).
 * Tests swap `aiState.current` to inject hostile or broken AI behaviour, or
 * to use the real FixtureOutingsAi.
 */
import type {
  AiResult,
  BriefExtraction,
  DashboardQuery,
  OutingsAi,
  PlanDraft,
  PlanDraftInput,
  Proposal,
  RevealSummary,
} from "@/lib/ai/types";
import { FixtureOutingsAi } from "@/lib/ai/fixture";

const wrap = <T>(output: T): AiResult<T> => ({ source: "FIXTURE", model: null, output, warnings: ["test fake AI"] });

export function defaultExtraction(title = "Test outing"): BriefExtraction {
  return {
    title,
    activityIdeas: ["Karaoke"],
    categories: ["karaoke"],
    dateWindow: { description: "Friday evening", dayOfWeek: "FRI", partOfDay: "EVENING" },
    groupSize: { count: 6, isEstimate: false },
    budget: { amountMinor: 10_000, unit: "TOTAL" },
    guestOfHonour: { name: null, coverTheirShare: false },
    prefersFixedTotal: true,
    needs: [],
    uncertainties: [],
    summary: [{ icon: "activity", text: "Karaoke" }],
  };
}

export class FakeAi implements OutingsAi {
  readonly source = "FIXTURE" as const;
  calls: { method: string; input: unknown }[] = [];
  async extractBrief(input: { brief: string; now: Date; timezone: string }): Promise<AiResult<BriefExtraction>> {
    this.calls.push({ method: "extractBrief", input });
    return wrap(defaultExtraction());
  }
  async proposeOfferings(input: Parameters<OutingsAi["proposeOfferings"]>[0]): Promise<AiResult<Proposal>> {
    this.calls.push({ method: "proposeOfferings", input });
    return wrap({
      ranked: input.catalogue.slice(0, 5).map((c) => ({ offeringId: c.offeringId, fit: "GOOD" as const, reasons: ["Fits the group"], concerns: [] })),
      note: "Fake ranking",
    });
  }
  async summarizeReveal(input: Parameters<OutingsAi["summarizeReveal"]>[0]): Promise<AiResult<RevealSummary>> {
    this.calls.push({ method: "summarizeReveal", input });
    return wrap({ headline: "Here's where the group landed", summary: "Most votes cluster around the middle.", suggestedAmountMinor: input.aggregate.medianMinor });
  }
  async dashboardQuery(input: { question: string; now: Date }): Promise<AiResult<DashboardQuery>> {
    this.calls.push({ method: "dashboardQuery", input });
    return wrap({
      filters: [
        { field: "closesToday", op: "eq", value: true },
        { field: "missingRequired", op: "gt", value: 0 },
      ],
      sort: { field: "closesWithinHours", direction: "asc" },
      focus: "READINESS",
      explanation: "Outings closing today with missing required participants.",
    });
  }
  /** Delegates to the deterministic fixture planner (tests override it to inject hostile drafts). */
  async draftPlan(input: PlanDraftInput): Promise<AiResult<PlanDraft>> {
    this.calls.push({ method: "draftPlan", input });
    return wrap((await new FixtureOutingsAi().draftPlan(input)).output);
  }
}

export const aiState: { current: OutingsAi } = { current: new FakeAi() };

export function resetFakeAi(): FakeAi {
  const ai = new FakeAi();
  aiState.current = ai;
  return ai;
}
