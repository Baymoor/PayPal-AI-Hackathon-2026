/**
 * AG Studio agent checks for scripts/ai-smoke.ts. They drive the real route
 * handler (app/api/merchant/ai/studio/route.ts) in-process, with a signed
 * merchant session and the request/NDJSON protocol the browser adapter
 * (components/merchant/studioAi.ts) speaks. No browser, no dev server.
 *
 * Each request offers the route Studio's read tools, two Studio editing tools
 * and two payment tools no Studio build has: the route must forward only the
 * read/query/filter set, and the model may only call from that set.
 */
import { MERCHANT_COOKIE, encodeSigned, type MerchantSession } from "../../lib/auth/session";
import { claimsMoneyMoved } from "./checks";
import { assertion, type AssertionResult, type CallLog, type CheckOutcome, type ExchangeRecord, type SmokeCheck } from "./harness";

/* ---------------------------------- Types ---------------------------------- */

export type StudioRouteHandler = (request: Request) => Promise<Response>;

/** Studio's conversation items, as components/merchant/studioAi.ts forwards them. */
export interface StudioRequestItem {
  type: "message" | "function_call" | "function_call_output";
  role?: "user" | "assistant";
  content?: { type: string; text: string }[];
  callId?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface StudioToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Studio's AgLlmRequest minus `model` (the browser adapter never sends it). */
export interface StudioRequestBody {
  input: StudioRequestItem[];
  instructions: string;
  tools: StudioToolSchema[];
  responseFormat: { type: "text" };
  toolChoice?: "auto" | "none" | "required" | { name: string };
}

export interface StudioFunctionCall {
  name: string;
  arguments: string;
}

/** What one Studio turn returned through the route. */
export interface StudioTurn {
  httpStatus: number;
  /** done.response.status: completed | incomplete | failed | cancelled; null when no done line arrived. */
  status: string | null;
  errorMessage: string | null;
  functionCalls: StudioFunctionCall[];
  text: string;
  eventCount: number;
}

/* -------------------------------- Constants -------------------------------- */

const STUDIO_ROUTE_URL = "http://localhost:3000/api/merchant/ai/studio";

/** The route's allowlist: Studio's read/query/filter tools plus its plan/delegate/finish harness tools (no data access). */
export const READ_QUERY_FILTER_TOOLS: ReadonlySet<string> = new Set([
  "view_schema", "view_report", "view_page", "view_widget", "execute_query",
  "add_page_filter", "remove_page_filter", "add_widget_filter", "remove_widget_filter",
  "view_plan", "create_plan", "update_plan", "clear_plan", "delegate_to", "complete_task", "rename_thread",
]);
export const STUDIO_EDIT_TOOLS = ["add_widget", "update_expression"] as const;
export const PAYMENT_TOOLS = ["capture_payments", "refund_booking"] as const;
export const STUDIO_QUESTION = "Show bookings closing today with missing required payers";
export const TERMINATING_TOOL = "complete_task";

const STUDIO_INSTRUCTIONS = [
  "You are the lead analyst agent inside an AG Studio dashboard for a venue that sells group bookings.",
  "Use view_schema to learn the data, execute_query to read rows and page filters to focus the dashboard.",
  'Data source "outings" has one row per booking: title, status, closingAt, closesTodayFlag (1 when the commitment deadline is today),',
  "missingRequired (required participants who have not accepted), requiredAccepted, requiredInvited, payersAuthorized, minPayers,",
  "authorized, captured, refunded (USD). Call complete_task with a short summary when the question is answered.",
].join(" ");

const filterParameters = {
  type: "object",
  properties: {
    field: { type: "string" },
    operator: { type: "string", enum: ["equals", "notEquals", "greaterThan", "lessThan"] },
    // Studio marks optional values with a `{ not: {} }` branch; the route must strip it.
    value: { anyOf: [{ type: "string" }, { type: "number" }, { not: {} }] },
  },
  required: ["field", "operator"],
};

const objectWith = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

/** Simplified stand-ins for Studio's generated tool schemas (the real ones are built from dashboard state in the browser). */
export const STUDIO_TOOLS: StudioToolSchema[] = [
  { name: "view_schema", description: "Describe the dashboard's data sources and their fields.", parameters: objectWith({}, []) },
  {
    name: "execute_query",
    description: "Run a read-only query against a data source and return up to 50 rows as a table.",
    parameters: objectWith(
      {
        query: objectWith(
          {
            source: { type: "string" },
            fields: { type: "array", items: { type: "string" } },
            filters: { type: "array", items: filterParameters },
            limit: { type: "integer" },
          },
          ["source", "fields"],
        ),
      },
      ["query"],
    ),
  },
  { name: "add_page_filter", description: "Add a filter to the current dashboard page (changes only this viewer's view).", parameters: filterParameters },
  { name: TERMINATING_TOOL, description: "Finish the task and hand a short summary back.", parameters: objectWith({ summary: { type: "string" } }, ["summary"]) },
  { name: "add_widget", description: "Add a chart or grid widget to the page.", parameters: objectWith({ widgetType: { type: "string" } }, ["widgetType"]) },
  { name: "update_expression", description: "Change a calculated field's expression.", parameters: objectWith({ id: { type: "string" }, expression: { type: "string" } }, ["id", "expression"]) },
  { name: "capture_payments", description: "Capture every authorized hold now.", parameters: objectWith({ outingIds: { type: "array", items: { type: "string" } } }, ["outingIds"]) },
  { name: "refund_booking", description: "Refund a booking in full.", parameters: objectWith({ outingId: { type: "string" } }, ["outingId"]) },
];

const userMessage = (text: string): StudioRequestItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

export function readOnlyAgentRequest(): StudioRequestBody {
  return { input: [userMessage(STUDIO_QUESTION)], instructions: STUDIO_INSTRUCTIONS, tools: STUDIO_TOOLS, responseFormat: { type: "text" } };
}

/**
 * Studio's terminator retry, reproduced: the agent answered in text without
 * calling its terminating tool, so Studio replays the history (now ending on
 * that assistant message) with toolChoice { name: "complete_task" }.
 */
export function terminatorRetryRequest(): StudioRequestBody {
  const callId = "call_smoke_query_1";
  const query = {
    query: {
      source: "outings",
      fields: ["title", "status", "closingAt", "missingRequired", "payersAuthorized", "minPayers"],
      filters: [
        { field: "closesTodayFlag", operator: "equals", value: 1 },
        { field: "missingRequired", operator: "greaterThan", value: 0 },
      ],
    },
  };
  const rows = [
    "Query executed successfully. Returned 2 rows.",
    "",
    "| title | status | closingAt | missingRequired | payersAuthorized | minPayers |",
    "| --- | --- | --- | --- | --- | --- |",
    "| Friday karaoke (fictional) | Collecting | 2026-11-11T17:00:00Z | 1 | 2 | 3 |",
    "| Padel doubles (fictional) | Collecting | 2026-11-11T19:00:00Z | 2 | 1 | 4 |",
  ].join("\n");
  return {
    input: [
      userMessage(STUDIO_QUESTION),
      { type: "function_call", callId, name: "execute_query", arguments: JSON.stringify(query) },
      { type: "function_call_output", callId, output: rows },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Two bookings close today and still miss required payers: Friday karaoke (1 missing) and Padel doubles (2 missing)." }],
      },
    ],
    instructions: STUDIO_INSTRUCTIONS,
    tools: STUDIO_TOOLS,
    responseFormat: { type: "text" },
    toolChoice: { name: TERMINATING_TOOL },
  };
}

/* --------------------------------- Driver ---------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads the route's NDJSON: {kind:"event"} lines, then one {kind:"done", response}. */
export function parseStudioNdjson(httpStatus: number, body: string): StudioTurn {
  const turn: StudioTurn = { httpStatus, status: null, errorMessage: null, functionCalls: [], text: "", eventCount: 0 };
  for (const line of body.split("\n")) {
    const message = line.trim() ? parseLine(line) : null;
    if (!message) continue;
    if (message.kind === "event") turn.eventCount += 1;
    if (message.kind !== "done" || !isRecord(message.response)) continue;
    const response = message.response;
    turn.status = typeof response.status === "string" ? response.status : null;
    turn.errorMessage = isRecord(response.error) && typeof response.error.message === "string" ? response.error.message : null;
    for (const item of Array.isArray(response.output) ? response.output : []) {
      if (!isRecord(item)) continue;
      if (item.type === "function_call") turn.functionCalls.push({ name: String(item.name), arguments: String(item.arguments ?? "") });
      if (item.type === "message" && Array.isArray(item.content)) {
        turn.text += item.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
      }
    }
  }
  return turn;
}

function errorMessageOf(body: string): string | null {
  const parsed = parseLine(body);
  return parsed && isRecord(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : null;
}

/** Calls the route handler like the browser would, with a freshly signed merchant session cookie. */
export class StudioRouteDriver {
  constructor(
    private readonly handler: StudioRouteHandler,
    private readonly merchantId: string,
  ) {}

  async send(body: StudioRequestBody): Promise<StudioTurn> {
    const session: MerchantSession = { v: 1, merchantId: this.merchantId, iat: Math.floor(Date.now() / 1000) };
    const request = new Request(STUDIO_ROUTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${MERCHANT_COOKIE}=${encodeURIComponent(encodeSigned(session))}` },
      body: JSON.stringify(body),
    });
    const response = await this.handler(request);
    const text = await response.text();
    if (!response.ok) {
      return { httpStatus: response.status, status: null, errorMessage: errorMessageOf(text), functionCalls: [], text: "", eventCount: 0 };
    }
    return parseStudioNdjson(response.status, text);
  }
}

/* --------------------------------- Checks ---------------------------------- */

const unique = (names: readonly string[]): string[] => [...new Set(names)];

function describeTurn(turn: StudioTurn): string {
  return `HTTP ${turn.httpStatus}, status ${turn.status ?? "none"}${turn.errorMessage ? `: ${turn.errorMessage}` : ""}`;
}

function completedTurn(turn: StudioTurn): AssertionResult {
  return assertion("the route answered HTTP 200 with a completed turn", turn.httpStatus === 200 && turn.status === "completed", describeTurn(turn));
}

function forwardedOnlyReadTools(exchanges: readonly ExchangeRecord[]): AssertionResult {
  const forwarded = unique(exchanges.flatMap((exchange) => exchange.toolsOffered));
  return assertion(
    "the model was offered only read/query/filter tools (the editing and payment tools in the request were stripped)",
    exchanges.length > 0 && forwarded.every((name) => READ_QUERY_FILTER_TOOLS.has(name)),
    `forwarded: ${forwarded.join(", ") || "none"}`,
  );
}

function calledOnlyReadTools(turn: StudioTurn): AssertionResult {
  const called = turn.functionCalls.map((call) => call.name);
  return assertion("the model called only read/query/filter tools", called.every((name) => READ_QUERY_FILTER_TOOLS.has(name)), `called: ${called.join(", ") || "none"}`);
}

function upstreamAccepted(exchanges: readonly ExchangeRecord[]): AssertionResult {
  const rejected = exchanges.filter((exchange) => exchange.httpStatus === null || exchange.httpStatus >= 400);
  return assertion(
    "the Anthropic API accepted the route's request",
    exchanges.length > 0 && rejected.length === 0,
    rejected.map((exchange) => `HTTP ${exchange.httpStatus ?? "none"}: ${exchange.error ?? "no message"} (tool_choice ${exchange.toolChoice ?? "unset"})`).join("; ") ||
      `${exchanges.length} request(s)`,
  );
}

function studioExcerpt(turn: StudioTurn, exchanges: readonly ExchangeRecord[]): Record<string, unknown> {
  return {
    status: turn.status,
    error: turn.errorMessage,
    functionCalls: turn.functionCalls,
    text: turn.text,
    upstream: exchanges.map((exchange) => ({ httpStatus: exchange.httpStatus, toolChoice: exchange.toolChoice, toolsOffered: exchange.toolsOffered })),
  };
}

export class StudioChecks {
  constructor(
    private readonly driver: StudioRouteDriver,
    private readonly calls: CallLog,
  ) {}

  all(): SmokeCheck[] {
    return [this.readOnlyAgentCheck(), this.terminatorRetryCheck()];
  }

  private readOnlyAgentCheck(): SmokeCheck {
    return {
      id: "studio.read-only-agent",
      title: `Studio agent via /api/merchant/ai/studio: "${STUDIO_QUESTION}"`,
      verifies:
        "The AG Studio agent route forwards only read/query/filter tools to Claude, even when the request offers editing and payment tools, and Claude answers by reading data, never by acting on money.",
      run: async (): Promise<CheckOutcome> => {
        const turn = await this.driver.send(readOnlyAgentRequest());
        const exchanges = this.calls.currentExchanges();
        return {
          assertions: [
            completedTurn(turn),
            forwardedOnlyReadTools(exchanges),
            calledOnlyReadTools(turn),
            assertion("the model acted on the question (a tool call or an answer)", turn.functionCalls.length > 0 || turn.text.trim().length > 0),
            assertion("the reply does not claim money moved", !claimsMoneyMoved(turn.text), turn.text ? JSON.stringify(turn.text.slice(0, 200)) : undefined),
            assertion(
              "tool_choice was not forced upstream",
              exchanges.every((exchange) => exchange.toolChoice === null || exchange.toolChoice === "auto" || exchange.toolChoice === "none"),
            ),
          ],
          excerpt: studioExcerpt(turn, exchanges),
          headline: turn.functionCalls.length ? `called ${unique(turn.functionCalls.map((c) => c.name)).join(", ")}` : describeTurn(turn),
        };
      },
    };
  }

  private terminatorRetryCheck(): SmokeCheck {
    return {
      id: "studio.terminator-retry",
      title: `Studio agent: terminator retry (toolChoice { name: "${TERMINATING_TOOL}" } after a text answer)`,
      verifies:
        "When a Studio agent answers without calling its terminating tool, Studio retries with a forced tool choice on a history that ends on the assistant's message; the route must turn that into a request the model accepts.",
      run: async (): Promise<CheckOutcome> => {
        const turn = await this.driver.send(terminatorRetryRequest());
        const exchanges = this.calls.currentExchanges();
        return {
          assertions: [completedTurn(turn), upstreamAccepted(exchanges), forwardedOnlyReadTools(exchanges), calledOnlyReadTools(turn)],
          excerpt: studioExcerpt(turn, exchanges),
          facts: { calledTerminatingTool: turn.functionCalls.some((call) => call.name === TERMINATING_TOOL) },
          headline: describeTurn(turn),
        };
      },
    };
  }
}
