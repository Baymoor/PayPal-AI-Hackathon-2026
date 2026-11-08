/**
 * Harness for scripts/ai-smoke.ts.
 *
 * - ApiExchangeRecorder wraps globalThis.fetch and keeps a SUMMARY of every
 *   Anthropic Messages exchange (status, latency, served model, token usage,
 *   tool names, tool_choice). It never stores headers, prompts or raw
 *   responses, so the API key cannot reach the evidence file through it.
 * - CheckRunner runs one check at a time, so every exchange is attributed to
 *   the check that caused it.
 * - The evidence helpers build, redact and place the JSON file: real runs go
 *   to docs/evidence, dry runs only to a temp directory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* ---------------------------------- Types ---------------------------------- */

export type SmokeMode = "REAL_API" | "DRY_RUN";
export type CheckStatus = "PASS" | "FAIL";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** One Messages API exchange, described without any of its content. */
export interface ExchangeRecord {
  checkId: string | null;
  /** null = the request never got an HTTP answer (network error). */
  httpStatus: number | null;
  latencyMs: number;
  requestedModel: string | null;
  servedModel: string | null;
  stream: boolean;
  effort: string | null;
  /** output_config.format.type, e.g. "json_schema" for structured outputs. */
  outputFormat: string | null;
  toolChoice: string | null;
  toolsOffered: string[];
  /** temperature / top_p / top_k when present (anthropic-version 2026-10-21 rejects them). */
  samplingParams: string[];
  stopReason: string | null;
  usage: TokenUsage | null;
  /** The API's error message for a non-2xx answer, or the network error. */
  error: string | null;
}

export type CallSummary = Omit<ExchangeRecord, "checkId">;

/** Read access to the exchanges made by the check that is running. */
export interface CallLog {
  currentExchanges(): readonly ExchangeRecord[];
}

export interface AssertionResult {
  expectation: string;
  met: boolean;
  detail?: string;
}

export interface CheckOutcome {
  assertions: AssertionResult[];
  /** Short excerpt of VALIDATED output; truncated again before writing. */
  excerpt: unknown;
  warnings?: readonly string[];
  facts?: Record<string, unknown>;
  /** One short phrase for the console line. */
  headline?: string;
}

export interface SmokeCheck {
  id: string;
  title: string;
  /** What a PASS demonstrates, in one sentence. */
  verifies: string;
  run(): Promise<CheckOutcome>;
}

export interface CheckRecord {
  id: string;
  title: string;
  verifies: string;
  status: CheckStatus;
  reason: string;
  assertions: AssertionResult[];
  latencyMs: number;
  calls: CallSummary[];
  tokenUsage: TokenUsage | null;
  headline: string | null;
  excerpt: unknown;
  warnings: string[];
  facts: Record<string, unknown>;
}

export interface AppModeSummary {
  aiMode: string;
  aiModel: string | null;
  paymentMode: string;
  demoFixturesEnabled: boolean;
}

export interface GitInfo {
  commit: string | null;
  /** Tracked files differ from the commit (untracked files ignored). */
  dirty: boolean | null;
}

export interface EvidenceSummary {
  overall: CheckStatus;
  checks: number;
  passed: number;
  failed: string[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  wallTimeMs: number;
}

export interface EvidenceDocument {
  tool: "scripts/ai-smoke.ts";
  mode: SmokeMode;
  label: string;
  startedAt: string;
  finishedAt: string;
  model: { configured: string; served: string[] };
  app: AppModeSummary;
  git: GitInfo;
  scenario: Record<string, unknown>;
  redaction: string;
  summary: EvidenceSummary;
  checks: CheckRecord[];
}

/* --------------------------------- Errors ---------------------------------- */

/** A dry-run file was about to land where real evidence lives. */
export class EvidenceLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceLocationError";
  }
}

/* ------------------------------- Small helpers ----------------------------- */

const MESSAGES_ENDPOINT = /^https:\/\/api\.anthropic\.com\/v1\/messages(?:\?.*)?$/;
const MAX_ERROR_CHARS = 240;

export function assertion(expectation: string, met: boolean, detail?: string): AssertionResult {
  return detail === undefined ? { expectation, met } : { expectation, met, detail };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

const elapsedSince = (startedAt: number): number => Math.round(performance.now() - startedAt);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function toUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;
  return {
    inputTokens: count(raw.input_tokens),
    outputTokens: count(raw.output_tokens),
    cacheReadInputTokens: count(raw.cache_read_input_tokens),
    cacheCreationInputTokens: count(raw.cache_creation_input_tokens),
  };
}

export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

type RequestSummary = Pick<
  ExchangeRecord,
  "requestedModel" | "stream" | "effort" | "outputFormat" | "toolChoice" | "toolsOffered" | "samplingParams"
>;

/** Parameters only: model, effort, tool NAMES, tool_choice. Never messages or system text. */
function summarizeRequest(body: unknown): RequestSummary {
  const json = typeof body === "string" ? safeJson(body) : null;
  const request = isRecord(json) ? json : {};
  const outputConfig = isRecord(request.output_config) ? request.output_config : {};
  const format = isRecord(outputConfig.format) ? outputConfig.format : {};
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return {
    requestedModel: stringOrNull(request.model),
    stream: request.stream === true,
    effort: stringOrNull(outputConfig.effort),
    outputFormat: stringOrNull(format.type),
    toolChoice: isRecord(request.tool_choice) ? stringOrNull(request.tool_choice.type) : null,
    toolsOffered: tools.map((tool) => (isRecord(tool) ? String(tool.name) : "?")),
    samplingParams: ["temperature", "top_p", "top_k"].filter((key) => key in request),
  };
}

function applyMessageSummary(message: Record<string, unknown>, record: ExchangeRecord): void {
  record.servedModel = stringOrNull(message.model) ?? record.servedModel;
  record.stopReason = stringOrNull(message.stop_reason) ?? record.stopReason;
  record.usage = toUsage(message.usage) ?? record.usage;
}

function applyErrorSummary(body: Record<string, unknown>, record: ExchangeRecord): void {
  const error = isRecord(body.error) ? body.error : {};
  const message = stringOrNull(error.message) ?? "no error message";
  record.error = `${stringOrNull(error.type) ?? "error"}: ${message}`.slice(0, MAX_ERROR_CHARS);
}

/** Server-sent events: model and input usage from message_start, stop reason and output usage from message_delta. */
function applyStreamSummary(text: string, record: ExchangeRecord): void {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = safeJson(line.slice(5).trim());
    if (!isRecord(event)) continue;
    if (event.type === "message_start" && isRecord(event.message)) applyMessageSummary(event.message, record);
    if (event.type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      record.stopReason = stringOrNull(delta.stop_reason) ?? record.stopReason;
      const output = isRecord(event.usage) ? count(event.usage.output_tokens) : 0;
      if (record.usage && output) record.usage = { ...record.usage, outputTokens: output };
    }
    if (event.type === "error") applyErrorSummary(event, record);
  }
}

async function readResponseSummary(response: Response, record: ExchangeRecord, startedAt: number): Promise<void> {
  try {
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      applyStreamSummary(await response.text(), record);
      return;
    }
    const body = await response.json();
    if (!isRecord(body)) return;
    if (response.ok) applyMessageSummary(body, record);
    else applyErrorSummary(body, record);
  } catch {
    // The summary is best effort; the caller still gets the untouched response.
  } finally {
    record.latencyMs = elapsedSince(startedAt);
  }
}

/* ------------------------------ Exchange recorder -------------------------- */

/**
 * Records Anthropic Messages exchanges made through globalThis.fetch. The SDK
 * resolves `fetch` when a client is constructed, so install() must run before
 * AnthropicOutingsAi or the Studio route builds its client.
 */
export class ApiExchangeRecorder implements CallLog {
  private readonly exchanges: ExchangeRecord[] = [];
  private readonly pending: Promise<void>[] = [];
  private activeCheckId: string | null = null;
  private replacedFetch: typeof fetch | null = null;

  constructor(private readonly upstream: typeof fetch) {}

  install(): void {
    if (this.replacedFetch) return;
    this.replacedFetch = globalThis.fetch;
    globalThis.fetch = this.fetch;
  }

  uninstall(): void {
    if (!this.replacedFetch) return;
    globalThis.fetch = this.replacedFetch;
    this.replacedFetch = null;
  }

  beginCheck(checkId: string): void {
    this.activeCheckId = checkId;
  }

  /** Waits for streamed answers to finish, then returns the check's exchanges. */
  async endCheck(): Promise<ExchangeRecord[]> {
    await Promise.all(this.pending.splice(0));
    const finished = this.currentExchanges();
    this.activeCheckId = null;
    return [...finished];
  }

  currentExchanges(): readonly ExchangeRecord[] {
    return this.exchanges.filter((exchange) => exchange.checkId === this.activeCheckId);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (!MESSAGES_ENDPOINT.test(requestUrl(input))) return this.upstream(input, init);
    const record: ExchangeRecord = {
      checkId: this.activeCheckId,
      httpStatus: null,
      latencyMs: 0,
      servedModel: null,
      stopReason: null,
      usage: null,
      error: null,
      ...summarizeRequest(init?.body),
    };
    this.exchanges.push(record);
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.upstream(input, init);
    } catch (err) {
      record.latencyMs = elapsedSince(startedAt);
      record.error = `network error: ${errorText(err)}`.slice(0, MAX_ERROR_CHARS);
      throw err;
    }
    record.httpStatus = response.status;
    const summary = readResponseSummary(response.clone(), record, startedAt);
    // A stream is read by its consumer; summarise it in the background and wait in endCheck().
    if (record.stream && response.ok) this.pending.push(summary);
    else await summary;
    return response;
  };
}

/* -------------------------------- Check runner ----------------------------- */

const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 200;

function upstreamErrors(calls: readonly CallSummary[]): string[] {
  return calls.flatMap((call) => (call.error ? [`upstream HTTP ${call.httpStatus ?? "none"}: ${call.error}`] : []));
}

function failureReason(assertions: readonly AssertionResult[], calls: readonly CallSummary[]): string {
  const failed = assertions.find((a) => !a.met);
  const base = failed ? `${failed.expectation}${failed.detail ? ` (${failed.detail})` : ""}` : "no expectations were checked";
  const errors = upstreamErrors(calls);
  return errors.length ? `${base}; ${errors[0]}` : base;
}

export function toCheckRecord(check: SmokeCheck, outcome: CheckOutcome, exchanges: readonly ExchangeRecord[], latencyMs: number): CheckRecord {
  const calls: CallSummary[] = exchanges.map(({ checkId: _checkId, ...call }) => {
    void _checkId;
    return call;
  });
  const passed = outcome.assertions.length > 0 && outcome.assertions.every((a) => a.met);
  return {
    id: check.id,
    title: check.title,
    verifies: check.verifies,
    status: passed ? "PASS" : "FAIL",
    reason: passed ? `all ${outcome.assertions.length} expectations met` : failureReason(outcome.assertions, calls),
    assertions: outcome.assertions,
    latencyMs,
    calls,
    tokenUsage: calls.reduce<TokenUsage | null>((sum, call) => addUsage(sum, call.usage), null),
    headline: outcome.headline ?? null,
    excerpt: truncateForEvidence(outcome.excerpt),
    warnings: (outcome.warnings ?? []).slice(0, MAX_WARNINGS).map((w) => w.slice(0, MAX_WARNING_CHARS)),
    facts: truncateForEvidence(outcome.facts ?? {}) as Record<string, unknown>,
  };
}

export class CheckRunner {
  constructor(
    private readonly recorder: ApiExchangeRecorder,
    private readonly onRecord: (record: CheckRecord) => void = () => {},
  ) {}

  async runAll(checks: readonly SmokeCheck[]): Promise<CheckRecord[]> {
    const records: CheckRecord[] = [];
    // Sequential on purpose: exchanges are attributed to the check that is running.
    for (const check of checks) records.push(await this.run(check));
    return records;
  }

  async run(check: SmokeCheck): Promise<CheckRecord> {
    this.recorder.beginCheck(check.id);
    const startedAt = performance.now();
    let outcome: CheckOutcome;
    try {
      outcome = await check.run();
    } catch (err) {
      outcome = { assertions: [assertion("the check ran to completion", false, errorText(err))], excerpt: null };
    }
    const latencyMs = elapsedSince(startedAt);
    const record = toCheckRecord(check, outcome, await this.recorder.endCheck(), latencyMs);
    this.onRecord(record);
    return record;
  }
}

/* ---------------------------------- Evidence ------------------------------- */

const MAX_EXCERPT_STRING = 160;
const MAX_EXCERPT_ITEMS = 6;
const MAX_EXCERPT_DEPTH = 5;

/** Keep excerpts short: long strings cut, long arrays shortened, deep nesting elided. */
export function truncateForEvidence(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_EXCERPT_STRING ? `${value.slice(0, MAX_EXCERPT_STRING)}...` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_EXCERPT_ITEMS).map((item) => truncateForEvidence(item, depth + 1));
    return value.length > MAX_EXCERPT_ITEMS ? [...kept, `(+${value.length - MAX_EXCERPT_ITEMS} more)`] : kept;
  }
  if (isRecord(value)) {
    if (depth >= MAX_EXCERPT_DEPTH) return "[...]";
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateForEvidence(item, depth + 1)]));
  }
  return value;
}

const ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/** Last line of defence: remove known secrets and anything shaped like an Anthropic key. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  return out.replace(ANTHROPIC_KEY_PATTERN, "[REDACTED]");
}

export function readGitInfo(repoRoot: string): GitInfo {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git(["rev-parse", "HEAD"]);
  const status = commit ? git(["status", "--porcelain", "--untracked-files=no"]) : null;
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export function summarizeChecks(checks: readonly CheckRecord[], wallTimeMs: number): EvidenceSummary {
  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  const usage = checks.reduce<TokenUsage | null>((sum, c) => addUsage(sum, c.tokenUsage), null);
  return {
    overall: checks.length > 0 && failed.length === 0 ? "PASS" : "FAIL",
    checks: checks.length,
    passed: checks.length - failed.length,
    failed,
    modelCalls: checks.reduce((sum, c) => sum + c.calls.length, 0),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    wallTimeMs,
  };
}

const fileStamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Real runs: <repo>/docs/evidence/ai-smoke-<ts>.json. Dry runs:
 * <outDir or the OS temp dir>/outings-ai-smoke/ai-smoke-DRY-RUN-<ts>.json,
 * and never anywhere under docs/evidence.
 */
export function evidenceFilePath(mode: SmokeMode, repoRoot: string, startedAt: Date, outDir?: string): string {
  const evidenceDir = path.join(repoRoot, "docs", "evidence");
  if (mode === "REAL_API") return path.join(evidenceDir, `ai-smoke-${fileStamp(startedAt)}.json`);
  const dir = outDir ? path.resolve(outDir) : path.join(os.tmpdir(), "outings-ai-smoke");
  if (isInside(evidenceDir, dir)) {
    throw new EvidenceLocationError(`Dry-run output must not go under ${evidenceDir}; it is not evidence.`);
  }
  return path.join(dir, `ai-smoke-DRY-RUN-${fileStamp(startedAt)}.json`);
}

export function writeEvidence(document: EvidenceDocument, filePath: string, secrets: readonly string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${redactSecrets(JSON.stringify(document, null, 2), secrets)}\n`);
}
