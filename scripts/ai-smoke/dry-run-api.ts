/**
 * Mocked Anthropic Messages API for `scripts/ai-smoke.ts --dry-run`.
 *
 * It stands in for the network (it is the `fetch` the real SDK calls), so the
 * real AnthropicOutingsAi, the real SDK and the real Studio route all run
 * unchanged. It answers in-process with canned, well-formed replies for the
 * smoke scenario and never makes a network request.
 *
 * It also enforces four documented API rules, so a dry run catches the
 * requests a real model would reject with HTTP 400:
 *   1. temperature / top_p / top_k are rejected on anthropic-version 2026-10-21 (the version @anthropic-ai/sdk 1.4.0 sends);
 *   2. forced tool_choice ("any" / "tool") is rejected by claude-sonnet-5-5, claude-opus-5-5, claude-fable-5-1, claude-mythos-5-1;
 *   3. a conversation ending on an assistant turn (prefill) is rejected by current models;
 *   4. structured-output schemas need additionalProperties:false on every object and no numeric/length/array-size keywords.
 * Every message it produces is labelled "[dry-run mock]"; nothing here is real model output.
 */
import { BRIEF_SYSTEM, DASHBOARD_SYSTEM, PLAN_SYSTEM, PROPOSAL_SYSTEM, REVEAL_SYSTEM } from "../../lib/ai/prompts";
import { formatLocalWallTime } from "../../lib/ai/validate";
import type { BriefExtraction, DashboardQuery, PlanDraft, Proposal, RevealSummary } from "../../lib/ai/types";
import { OUTING_STARTERS, type OutingStarter } from "../../lib/demo/starters";
import { normalizeBrief } from "../../lib/services/outings";
import { zonedParts } from "../../lib/services/catalogue";
import { COVERED_GUEST, INJECTED_BRIEF, MONEY_ACTION_QUESTION, STARTER_EXPECTATIONS } from "./checks";

/* ---------------------------------- Types ---------------------------------- */

type JsonObject = Record<string, unknown>;

interface MockMessage {
  role: string;
  content: unknown;
}

export interface MockRequest {
  model: string;
  system: string;
  messages: MockMessage[];
  stream: boolean;
  body: JsonObject;
  apiVersion: string | null;
}

interface CatalogueRow {
  offeringId: string;
  category: string;
  pricingModel: string;
  priceMinor: number;
  capacity: number;
  active?: boolean;
  availability?: { weekdays: number[]; startHours: number[] };
}

interface RosterRow {
  name: string;
  organizer: boolean;
  paying: boolean;
  sponsored: boolean;
}

/**
 * Canned suggested per-person vote amounts per starter: two accepted, one dropped by validateBrief (not whole
 * dollars), one rejected by the rules (whole-group totals where per-person amounts were asked for), one absent.
 */
const STARTER_VOTE_SUGGESTIONS: Record<OutingStarter["id"], number[] | null> = {
  "karaoke-birthday": [1_000, 1_500, 2_000, 2_500, 3_000],
  "movie-night": [800, 1_200, 1_500, 2_000, 2_500],
  "wine-tasting": [2_500, 4_000, 5_000, 7_500, 10_050],
  "gym-session": null,
  "padel-doubles": [3_000, 4_500, 6_000, 9_000, 12_000],
};

const DAY_INDEX: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const PART_OF_DAY: Record<string, BriefExtraction["dateWindow"]["partOfDay"]> = { morning: "MORNING", afternoon: "AFTERNOON", evening: "EVENING", night: "NIGHT" };

const REJECTS_FORCED_TOOL_CHOICE = /^claude-(?:sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)/;
const REJECTS_PREFILL = /^claude-(?:fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[678]|sonnet-4-6)/;
const UNSUPPORTED_SCHEMA_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems"];
const MOCK_RULE = "[dry-run mock of a documented API rule]";
const DAY_MS = 24 * 60 * 60 * 1000;

/* --------------------------------- Helpers --------------------------------- */

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("\n");
}

/** The JSON between <untrusted_tag> delimiters in a prompt, or null. */
function untrustedJson<T>(text: string, tag: string): T | null {
  const match = new RegExp(`<untrusted_${tag}>\\n([\\s\\S]*?)\\n</untrusted_${tag}>`).exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return null;
  }
}

function untrustedText(text: string, tag: string): string | null {
  return new RegExp(`<untrusted_${tag}>\\n([\\s\\S]*?)\\n</untrusted_${tag}>`).exec(text)?.[1] ?? null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_dry_run" } });
}

function apiError(message: string): Response {
  return jsonResponse(400, { type: "error", error: { type: "invalid_request_error", message } });
}

/* ------------------------------ Request rules ------------------------------ */

/** First schema problem structured outputs would reject, or null. */
export function schemaProblem(node: unknown, at = "schema"): string | null {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      const problem = schemaProblem(item, `${at}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (node.type === "object" && node.additionalProperties !== false) return `${at}: objects need additionalProperties: false`;
  const keyword = UNSUPPORTED_SCHEMA_KEYWORDS.find((key) => key in node);
  if (keyword) return `${at}: "${keyword}" is not supported`;
  if (typeof node.minItems === "number" && node.minItems > 1) return `${at}: minItems above 1 is not supported`;
  for (const [key, value] of Object.entries(node)) {
    const problem = schemaProblem(value, `${at}.${key}`);
    if (problem) return problem;
  }
  return null;
}

/** The documented rule a real model would reject this request under, or null. */
export function violatedRule(request: MockRequest): string | null {
  const sampling = ["temperature", "top_p", "top_k"].filter((key) => key in request.body);
  if (sampling.length && request.apiVersion === "2026-10-21") {
    return `${MOCK_RULE} ${sampling.join(", ")}: sampling parameters are not accepted on anthropic-version 2026-10-21.`;
  }
  const choice = isRecord(request.body.tool_choice) ? request.body.tool_choice.type : null;
  if ((choice === "any" || choice === "tool") && REJECTS_FORCED_TOOL_CHOICE.test(request.model)) {
    return `${MOCK_RULE} tool_choice: type "tool" and "any" are not supported for this model.`;
  }
  if (request.messages.at(-1)?.role === "assistant" && REJECTS_PREFILL.test(request.model)) {
    return `${MOCK_RULE} the conversation ends on an assistant turn (prefill), which this model does not support.`;
  }
  const outputConfig = isRecord(request.body.output_config) ? request.body.output_config : {};
  const format = isRecord(outputConfig.format) ? outputConfig.format : null;
  const problem = format ? schemaProblem(format.schema, "output_config.format.schema") : null;
  return problem ? `${MOCK_RULE} ${problem}` : null;
}

/* ------------------------------ Canned replies ----------------------------- */

function starterExtraction(starter: OutingStarter): BriefExtraction {
  const expected = STARTER_EXPECTATIONS[starter.id];
  const partWord = Object.keys(PART_OF_DAY).find((word) => starter.brief.toLowerCase().includes(word));
  const covered = expected.coveredGuest;
  return {
    title: starter.label,
    activityIdeas: [starter.label],
    categories: [starter.category],
    dateWindow: { description: `${expected.dayOfWeek} ${partWord ?? ""}`.trim(), dayOfWeek: expected.dayOfWeek, partOfDay: partWord ? PART_OF_DAY[partWord] : null },
    groupSize: { count: expected.groupSize, isEstimate: false },
    budget: expected.budget,
    guestOfHonour: { name: covered, coverTheirShare: covered !== null },
    prefersFixedTotal: true,
    needs: [],
    uncertainties: [],
    summary: [{ icon: "activity", text: `[dry-run mock] ${starter.label}` }],
    suggestedVotePerPersonMinor: STARTER_VOTE_SUGGESTIONS[starter.id],
  };
}

function injectedExtraction(): BriefExtraction {
  return {
    title: "Karaoke night",
    activityIdeas: ["Karaoke"],
    categories: ["karaoke"],
    dateWindow: { description: "Friday", dayOfWeek: "FRI", partOfDay: null },
    groupSize: { count: 6, isEstimate: false },
    budget: { amountMinor: null, unit: "UNKNOWN" },
    guestOfHonour: { name: null, coverTheirShare: false },
    prefersFixedTotal: true,
    needs: [],
    uncertainties: ["The brief contains an instruction to authorize payments; it was treated as text, not as a budget."],
    summary: [{ icon: "activity", text: "[dry-run mock] Karaoke for six on Friday" }],
    suggestedVotePerPersonMinor: null,
  };
}

function genericExtraction(): BriefExtraction {
  return {
    title: "Group outing",
    activityIdeas: [],
    categories: [],
    dateWindow: { description: "", dayOfWeek: null, partOfDay: null },
    groupSize: { count: null, isEstimate: false },
    budget: { amountMinor: null, unit: "UNKNOWN" },
    guestOfHonour: { name: null, coverTheirShare: false },
    prefersFixedTotal: true,
    needs: [],
    uncertainties: ["[dry-run mock] unrecognised brief"],
    summary: [{ icon: "note", text: "[dry-run mock] unrecognised brief" }],
    suggestedVotePerPersonMinor: null,
  };
}

function briefReply(prompt: string): BriefExtraction {
  const brief = untrustedText(prompt, "brief")?.trim() ?? "";
  const starter = OUTING_STARTERS.find((s) => normalizeBrief(s.brief) === brief);
  if (starter) return starterExtraction(starter);
  return brief === normalizeBrief(INJECTED_BRIEF) ? injectedExtraction() : genericExtraction();
}

function proposalReply(prompt: string): Proposal {
  const catalogue = untrustedJson<CatalogueRow[]>(prompt, "catalogue") ?? [];
  const wanted = untrustedJson<{ categories?: string[] }>(prompt, "extraction")?.categories ?? [];
  const matching = catalogue.filter((c) => wanted.includes(c.category)).sort((a, b) => a.priceMinor - b.priceMinor);
  const others = catalogue.filter((c) => !wanted.includes(c.category)).slice(0, 2);
  return {
    ranked: [...matching, ...others].slice(0, 5).map((c, i) => ({
      offeringId: c.offeringId,
      fit: i === 0 ? "GREAT" : wanted.includes(c.category) ? "GOOD" : "STRETCH",
      reasons: [`[dry-run mock] ${wanted.includes(c.category) ? "matches the requested activity" : "an alternative activity"}`],
      concerns: [],
    })),
    note: "[dry-run mock] ranking from canned rules",
  };
}

function revealReply(prompt: string): RevealSummary {
  const line = prompt.split("\n").find((l) => l.startsWith("{") && l.includes("medianMinor"));
  const aggregate = line ? (JSON.parse(line) as { medianMinor: number; voteCount: number }) : { medianMinor: 2_000, voteCount: 0 };
  return {
    headline: "[dry-run mock] The group lands near the middle",
    summary: `[dry-run mock] ${aggregate.voteCount} anonymous votes. Votes are not payment authorizations and nobody is charged.`,
    suggestedAmountMinor: aggregate.medianMinor,
  };
}

function dashboardReply(prompt: string): DashboardQuery {
  const question = untrustedText(prompt, "question") ?? "";
  if (question === MONEY_ACTION_QUESTION) {
    return {
      filters: [{ field: "payersAuthorized", op: "gt", value: 0 }],
      sort: { field: "authorizedTotalMinor", direction: "desc" },
      focus: "MONEY_CHART",
      explanation: "[dry-run mock] Shows bookings that hold authorizations; this view cannot refund or capture anything.",
    };
  }
  return {
    filters: [
      { field: "closesToday", op: "eq", value: true },
      { field: "missingRequired", op: "gt", value: 0 },
    ],
    sort: null,
    focus: "BOOKINGS_TABLE",
    explanation: "[dry-run mock] Bookings closing today that still miss required participants.",
  };
}

/** "Current time: <iso> (UTC), which is <weekday> <local> in the merchant timezone <tz>." */
function planClock(prompt: string): { now: Date; timezone: string } {
  const match = /Current time: (\S+) \(UTC\), which is \w+ \S+ in the merchant timezone (\S+)\./.exec(prompt);
  return match ? { now: new Date(match[1]), timezone: match[2] } : { now: new Date(), timezone: "UTC" };
}

/** First wall time on the wanted weekday (any listed day if none) at the listed start hour closest to 19:00. */
function activityWallTime(now: Date, timezone: string, offering: CatalogueRow, wantedDay: number | null): string {
  const weekdays = offering.availability?.weekdays ?? [];
  const hours = [...(offering.availability?.startHours ?? [19])].sort((a, b) => Math.abs(a - 19) - Math.abs(b - 19));
  for (let days = 1; days <= 7; days++) {
    const parts = zonedParts(new Date(now.getTime() + days * DAY_MS), timezone);
    const fits = weekdays.includes(parts.weekday) && (wantedDay === null || parts.weekday === wantedDay);
    if (fits) return `${formatLocalWallTime(new Date(now.getTime() + days * DAY_MS), timezone).slice(0, 10)}T${String(hours[0]).padStart(2, "0")}:00`;
  }
  return "";
}

function planReply(prompt: string): PlanDraft {
  const { now, timezone } = planClock(prompt);
  const catalogue = untrustedJson<CatalogueRow[]>(prompt, "catalogue") ?? [];
  const roster = untrustedJson<RosterRow[]>(prompt, "roster") ?? [];
  const extraction = untrustedJson<Pick<BriefExtraction, "dateWindow" | "guestOfHonour">>(prompt, "extraction");
  const offering = catalogue.find((c) => c.active !== false && c.pricingModel === "FIXED_TOTAL" && c.capacity >= roster.length);
  const wantedDay = extraction?.dateWindow.dayOfWeek ? DAY_INDEX[extraction.dateWindow.dayOfWeek] : null;
  const guest = extraction?.guestOfHonour;
  const sponsor = guest?.coverTheirShare && roster.some((p) => p.name === guest.name && !p.organizer) ? guest.name : null;
  return {
    offeringId: offering?.offeringId ?? "",
    activityStartLocal: offering ? activityWallTime(now, timezone, offering, wantedDay) : "",
    // About 24 hours from now, on the hour: well inside the 48-hour commitment window.
    deadlineLocal: `${formatLocalWallTime(new Date(now.getTime() + DAY_MS), timezone).slice(0, 13)}:00`,
    minPayers: roster.length - (sponsor ? 1 : 0),
    sponsoredParticipantName: sponsor,
    rationale: [`[dry-run mock] ${sponsor ?? COVERED_GUEST}'s share is covered by the group`],
    cautions: ["[dry-run mock] canned plan, not model output"],
  };
}

/* ------------------------------ Studio stream ------------------------------ */

function sse(events: JsonObject[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Calls execute_query on a fresh question, complete_task once a tool result is in the history. */
function studioToolCall(request: MockRequest): { name: string; input: JsonObject } | null {
  const offered = new Set((Array.isArray(request.body.tools) ? request.body.tools : []).map((t) => (isRecord(t) ? t.name : null)));
  const sawToolResult = request.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => isRecord(b) && b.type === "tool_result"));
  if (sawToolResult && offered.has("complete_task")) return { name: "complete_task", input: { summary: "[dry-run mock] Two bookings close today and miss required payers." } };
  if (offered.has("execute_query")) {
    return {
      name: "execute_query",
      input: {
        query: {
          source: "outings",
          fields: ["title", "closingAt", "missingRequired"],
          filters: [
            { field: "closesTodayFlag", operator: "equals", value: 1 },
            { field: "missingRequired", operator: "greaterThan", value: 0 },
          ],
        },
      },
    };
  }
  return null;
}

function studioStream(request: MockRequest): Response {
  const call = studioToolCall(request);
  const input = JSON.stringify(call?.input ?? {});
  const block = call
    ? [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_dry_run_1", name: call.name, input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } },
      ]
    : [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[dry-run mock] No tool fits this request." } },
      ];
  const body = sse([
    {
      type: "message_start",
      message: { id: "msg_dry_run", type: "message", role: "assistant", model: "dry-run-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(JSON.stringify(request.body)), output_tokens: 1 } },
    },
    ...block,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: estimateTokens(input) } },
    { type: "message_stop" },
  ]);
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/* ---------------------------------- Mock ----------------------------------- */

function structuredReply(request: MockRequest): unknown {
  const prompt = textOf(request.messages[0]?.content);
  switch (request.system) {
    case BRIEF_SYSTEM:
      return briefReply(prompt);
    case PROPOSAL_SYSTEM:
      return proposalReply(prompt);
    case REVEAL_SYSTEM:
      return revealReply(prompt);
    case DASHBOARD_SYSTEM:
      return dashboardReply(prompt);
    case PLAN_SYSTEM:
      return planReply(prompt);
    default:
      return null;
  }
}

function parseRequest(body: unknown, headers: Headers): MockRequest | null {
  if (typeof body !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(json) || typeof json.model !== "string" || !Array.isArray(json.messages)) return null;
  return {
    model: json.model,
    system: typeof json.system === "string" ? json.system : textOf(json.system),
    messages: json.messages.filter(isRecord).map((m) => ({ role: String(m.role), content: m.content })),
    stream: json.stream === true,
    body: json,
    apiVersion: headers.get("anthropic-version"),
  };
}

export class DryRunNetworkError extends Error {
  constructor(url: string) {
    super(`dry run: no network access (blocked ${url})`);
    this.name = "DryRunNetworkError";
  }
}

export class DryRunAnthropicApi {
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.anthropic.com/v1/messages")) throw new DryRunNetworkError(url);
    const request = parseRequest(init?.body, new Headers(init?.headers));
    if (!request) return apiError("[dry-run mock] request body is not a Messages request");
    const violation = violatedRule(request);
    if (violation) return apiError(violation);
    if (request.stream) return studioStream(request);
    return this.structured(request);
  };

  private structured(request: MockRequest): Response {
    const reply = structuredReply(request);
    if (reply === null) return apiError("[dry-run mock] unrecognised system prompt");
    const text = JSON.stringify(reply);
    return jsonResponse(200, {
      id: "msg_dry_run",
      type: "message",
      role: "assistant",
      model: "dry-run-mock",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: estimateTokens(JSON.stringify(request.body)), output_tokens: estimateTokens(text) },
    });
  }
}
