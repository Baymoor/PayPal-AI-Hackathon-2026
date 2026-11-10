/**
 * Real adapter. Uses Anthropic structured outputs (`output_config.format`
 * json_schema derived from our zod schemas): the default model
 * (claude-sonnet-5-5) rejects forced tool_choice, so a forced tool is not
 * an option. Every response is re-validated with zod and domain rules.
 * Failures throw typed errors; this class NEVER falls back to fixtures.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../env";
import {
  BRIEF_SYSTEM,
  DASHBOARD_SYSTEM,
  PLAN_SYSTEM,
  PROPOSAL_SYSTEM,
  REVEAL_SYSTEM,
  briefUserMessage,
  dashboardUserMessage,
  planUserMessage,
  proposalUserMessage,
  revealUserMessage,
} from "./prompts";
import {
  BriefExtractionModelSchema,
  DashboardQuerySchema,
  PlanDraftSchema,
  ProposalSchema,
  RevealSummarySchema,
  type AiResult,
  type BriefExtraction,
  type DashboardQuery,
  type OutingsAi,
  type PlanDraft,
  type PlanDraftInput,
  type Proposal,
  type ProposalInput,
  type RevealAggregate,
  type RevealSummary,
} from "./types";
import {
  AiOutputError,
  AiProviderError,
  validateBrief,
  validateDashboardQuery,
  validateProposal,
  validateReveal,
} from "./validate";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 1;
export const MAX_OUTPUT_TOKENS = 3000;

/** The parts of a Messages API response we read (everything else is ignored). */
export interface AnthropicMessageLike {
  stop_reason?: string | null;
  content?: ReadonlyArray<{ type?: string; text?: string }> | null;
}

/** Minimal client surface we use (lets tests inject a mock). */
export interface AnthropicLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { timeout?: number; maxRetries?: number },
    ): Promise<AnthropicMessageLike | null | undefined>;
  };
}

/** Keywords json_schema output does not support (or we do not rely on); zod re-checks / re-applies them afterwards. */
const UNSUPPORTED = new Set([
  "$schema", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems",
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED.has(k)) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return node;
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = strip(z.toJSONSchema(schema, { io: "output" })) as Record<string, unknown>;
  return js;
}

/** Model families that take `output_config.effort`. */
export function isModernModel(model: string): boolean {
  return /^claude-(sonnet-5|opus-5|opus-4-[6-9]|fable|mythos|haiku-5)/.test(model);
}

export class AnthropicOutingsAi implements OutingsAi {
  readonly source = "ANTHROPIC" as const;
  private readonly client: AnthropicLike;
  private readonly model: string;

  constructor(opts: { client?: AnthropicLike; apiKey?: string; model?: string } = {}) {
    const cfg = config().anthropic;
    const apiKey = opts.apiKey ?? cfg?.apiKey;
    const model = opts.model ?? cfg?.model;
    if (!apiKey || !model) throw new Error("AnthropicOutingsAi requires OUTINGS_ANTHROPIC_API_KEY");
    this.model = model;
    this.client =
      opts.client ??
      (new Anthropic({
        apiKey, // explicit: never the ambient ANTHROPIC_API_KEY
        authToken: null, // never an ambient ANTHROPIC_AUTH_TOKEN
        baseURL: ANTHROPIC_BASE_URL, // never an ambient ANTHROPIC_BASE_URL
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
      }) as unknown as AnthropicLike);
  }

  private async call<S extends z.ZodType>(system: string, user: string, schema: S): Promise<z.infer<S>> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        format: { type: "json_schema", schema: toJsonSchema(schema) },
        ...(isModernModel(this.model) ? { effort: "low" } : {}),
      },
      // No temperature: the API version the SDK sends (2026-10-21) rejects sampling params on every model.
    };

    let res: AnthropicMessageLike | null | undefined;
    try {
      res = await this.client.messages.create(params, { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    } catch (err) {
      const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
      throw new AiProviderError(`Anthropic request failed${status ? ` (HTTP ${status})` : ""}`, status);
    }

    if (res?.stop_reason === "refusal") throw new AiOutputError("Model declined the request");
    if (res?.stop_reason === "max_tokens") throw new AiOutputError("Model output was truncated");
    const text = (res?.content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text) throw new AiOutputError("Model returned no text output");

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiOutputError("Model output was not valid JSON");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AiOutputError("Model output failed schema validation", parsed.error.issues);
    return parsed.data;
  }

  private wrap<T>(output: T, warnings: string[]): AiResult<T> {
    return { source: "ANTHROPIC", model: this.model, output, warnings };
  }

  async extractBrief(input: { brief: string; now: Date; timezone: string; categories?: string[] }): Promise<AiResult<BriefExtraction>> {
    const raw = await this.call(BRIEF_SYSTEM, briefUserMessage(input, input.categories), BriefExtractionModelSchema);
    const v = validateBrief(raw, { categories: input.categories, sourceText: input.brief });
    return this.wrap(v.output, v.warnings);
  }

  async proposeOfferings(input: ProposalInput): Promise<AiResult<Proposal>> {
    const raw = await this.call(PROPOSAL_SYSTEM, proposalUserMessage(input), ProposalSchema);
    const v = validateProposal(raw, input.catalogue);
    return this.wrap(v.output, v.warnings);
  }

  async summarizeReveal(input: { aggregate: RevealAggregate; extraction: BriefExtraction | null }): Promise<AiResult<RevealSummary>> {
    const raw = await this.call(REVEAL_SYSTEM, revealUserMessage(input), RevealSummarySchema);
    const v = validateReveal(raw, input.aggregate);
    return this.wrap(v.output, v.warnings);
  }

  async dashboardQuery(input: { question: string; now: Date }): Promise<AiResult<DashboardQuery>> {
    const raw = await this.call(DASHBOARD_SYSTEM, dashboardUserMessage(input), DashboardQuerySchema);
    const v = validateDashboardQuery(raw);
    return this.wrap(v.output, v.warnings);
  }

  /**
   * Shape-validated draft only (zod, same structured-output path as above).
   * The service runs `validatePlanDraft` against the database before any
   * value reaches the organizer; nothing here is applied automatically.
   */
  async draftPlan(input: PlanDraftInput): Promise<AiResult<PlanDraft>> {
    const raw = await this.call(PLAN_SYSTEM, planUserMessage(input), PlanDraftSchema);
    return this.wrap(raw, []);
  }
}
