/**
 * One ai-smoke run, real or dry: app configuration, the database catalogue,
 * the exchange recorder, every check, and the evidence file. The CLI
 * (scripts/ai-smoke.ts) and the tests both call runAiSmoke.
 *
 * The database is only READ (listActiveOfferings). Nothing is written to it.
 */
import { POST as studioRoute } from "../../app/api/merchant/ai/studio/route";
import { AnthropicOutingsAi } from "../../lib/ai/anthropic";
import { createDb, type Db } from "../../lib/db/client";
import { OUTING_STARTERS } from "../../lib/demo/starters";
import { loadConfig, publicModeSummary, resetConfigForTests, type AppConfig } from "../../lib/env";
import { OutingsAiChecks, PLAN_ROSTER, SCENARIO_NOW, SCENARIO_TIMEZONE, demoMerchantId, loadDemoCatalogue, type DemoCatalogue } from "./checks";
import { DryRunAnthropicApi } from "./dry-run-api";
import {
  ApiExchangeRecorder,
  CheckRunner,
  errorText,
  evidenceFilePath,
  readGitInfo,
  summarizeChecks,
  writeEvidence,
  type AppModeSummary,
  type CheckRecord,
  type EvidenceDocument,
  type SmokeCheck,
  type SmokeMode,
} from "./harness";
import { StudioChecks, StudioRouteDriver } from "./studio";

/* ---------------------------------- Types ---------------------------------- */

export interface AiSmokeOptions {
  mode: SmokeMode;
  databaseUrl: string;
  /** Repository root; real evidence goes to <repoRoot>/docs/evidence. */
  repoRoot: string;
  /** Environment the app config is built from (process.env for the CLI). */
  env: NodeJS.ProcessEnv;
  /** Include the two AG Studio agent route checks. */
  studio: boolean;
  /** Run only checks whose id starts with one of these prefixes; empty = all. */
  only: readonly string[];
  /** Dry runs only: directory for the labelled file (never docs/evidence). */
  outDir?: string;
  onStart?: (info: RunStartInfo) => void;
  onCheck?: (record: CheckRecord) => void;
}

export interface RunStartInfo {
  mode: SmokeMode;
  model: string;
  database: string;
  activeOfferings: number;
  checks: number;
  filePath: string;
}

export interface AiSmokeResult {
  document: EvidenceDocument;
  filePath: string;
}

/** Nothing was sent to the model: missing key, unreachable or empty database. */
export class SmokeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeSetupError";
  }
}

/* -------------------------------- Constants -------------------------------- */

/** Stands in for the key in dry runs so a real key in the shell is never used or sent. */
export const DRY_RUN_PLACEHOLDER_KEY = "dry-run-placeholder-not-an-api-key";

const LABELS: Record<SmokeMode, string> = {
  REAL_API: "REAL Claude run: every model answer below came from the Anthropic Messages API through the app's own code (lib/ai/anthropic.ts and the Studio route).",
  DRY_RUN: "DRY RUN with a mocked Anthropic API (in-process, no network). NOT real model output and NOT evidence of real Claude.",
};

const REDACTION =
  "No API key, request headers, prompts or raw model responses are stored. Per check: expectations and results, timings, token counts, " +
  "request parameters (model, effort, tool names, tool_choice) and short excerpts of VALIDATED output. Every person and booking in the scenario is fictional demo data.";

/* --------------------------------- Helpers --------------------------------- */

/** host:port/database, never credentials. */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "an unparseable database URL";
  }
}

/** Builds the process-wide app config the adapter and the Studio route read. */
function configureApp(options: AiSmokeOptions): AppConfig {
  const env = options.mode === "DRY_RUN" ? { ...options.env, OUTINGS_ANTHROPIC_API_KEY: DRY_RUN_PLACEHOLDER_KEY } : options.env;
  const cfg = loadConfig(env);
  if (!cfg.anthropic) {
    throw new SmokeSetupError("OUTINGS_ANTHROPIC_API_KEY is not set, so nothing was run. Set it in the shell or in .env.local, or use --dry-run.");
  }
  resetConfigForTests(cfg);
  return cfg;
}

function appSummary(cfg: AppConfig, mode: SmokeMode): AppModeSummary {
  const summary = publicModeSummary(cfg);
  return {
    aiMode: mode === "DRY_RUN" ? "DRY_RUN_MOCK" : summary.aiMode,
    aiModel: summary.aiModel,
    paymentMode: summary.paymentMode,
    demoFixturesEnabled: summary.demoFixturesEnabled,
  };
}

async function loadCatalogue(db: Db, url: string): Promise<DemoCatalogue> {
  let catalogue: DemoCatalogue;
  try {
    catalogue = await loadDemoCatalogue(db);
  } catch (err) {
    throw new SmokeSetupError(
      `Could not read the catalogue from ${describeDatabase(url)} (${errorText(err)}). Start Postgres, run npm run db:migrate and npm run db:seed, or pass --database-url.`,
    );
  }
  if (catalogue.entries.length === 0) throw new SmokeSetupError(`No active offerings in ${describeDatabase(url)}. Run npm run db:seed first.`);
  return catalogue;
}

function buildChecks(options: AiSmokeOptions, ai: AnthropicOutingsAi, catalogue: DemoCatalogue, recorder: ApiExchangeRecorder): SmokeCheck[] {
  const checks = new OutingsAiChecks({ ai, catalogue, calls: recorder }).all();
  if (options.studio) {
    const driver = new StudioRouteDriver(studioRoute, demoMerchantId(catalogue) ?? "ai-smoke-merchant");
    checks.push(...new StudioChecks(driver, recorder).all());
  }
  if (options.only.length === 0) return checks;
  return checks.filter((check) => options.only.some((prefix) => check.id.startsWith(prefix)));
}

interface DocumentInput {
  options: AiSmokeOptions;
  cfg: AppConfig;
  catalogue: DemoCatalogue;
  records: CheckRecord[];
  startedAt: Date;
  finishedAt: Date;
}

function buildDocument({ options, cfg, catalogue, records, startedAt, finishedAt }: DocumentInput): EvidenceDocument {
  const served = records.flatMap((record) => record.calls.flatMap((call) => (call.servedModel ? [call.servedModel] : [])));
  return {
    tool: "scripts/ai-smoke.ts",
    mode: options.mode,
    label: LABELS[options.mode],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model: { configured: cfg.anthropic?.model ?? "none", served: [...new Set(served)] },
    app: appSummary(cfg, options.mode),
    git: readGitInfo(options.repoRoot),
    scenario: {
      clock: SCENARIO_NOW.toISOString(),
      timezone: SCENARIO_TIMEZONE,
      catalogue: {
        source: "database, read with listActiveOfferings exactly as the app does",
        database: describeDatabase(options.databaseUrl),
        activeOfferings: catalogue.entries.length,
        categories: catalogue.categories,
      },
      starters: OUTING_STARTERS.map((starter) => starter.id),
      planRoster: PLAN_ROSTER.map((person) => person.name),
      studioChecks: options.studio,
      only: options.only,
    },
    redaction: REDACTION,
    summary: summarizeChecks(records, finishedAt.getTime() - startedAt.getTime()),
    checks: records,
  };
}

/* ----------------------------------- Run ----------------------------------- */

export async function runAiSmoke(options: AiSmokeOptions): Promise<AiSmokeResult> {
  const startedAt = new Date();
  const cfg = configureApp(options);
  // Fails fast (before any model call) if a dry-run --out-dir points into docs/evidence.
  const filePath = evidenceFilePath(options.mode, options.repoRoot, startedAt, options.outDir);
  const upstream = options.mode === "DRY_RUN" ? new DryRunAnthropicApi().fetch : globalThis.fetch;
  const recorder = new ApiExchangeRecorder(upstream);
  const { db, pool } = createDb(options.databaseUrl);
  recorder.install();
  try {
    const catalogue = await loadCatalogue(db, options.databaseUrl);
    // Built after install(): the SDK binds fetch when a client is constructed.
    const ai = new AnthropicOutingsAi();
    const checks = buildChecks(options, ai, catalogue, recorder);
    options.onStart?.({
      mode: options.mode,
      model: cfg.anthropic?.model ?? "none",
      database: describeDatabase(options.databaseUrl),
      activeOfferings: catalogue.entries.length,
      checks: checks.length,
      filePath,
    });
    const records = await new CheckRunner(recorder, options.onCheck).runAll(checks);
    const document = buildDocument({ options, cfg, catalogue, records, startedAt, finishedAt: new Date() });
    writeEvidence(document, filePath, cfg.anthropic ? [cfg.anthropic.apiKey] : []);
    return { document, filePath };
  } finally {
    recorder.uninstall();
    await pool.end();
  }
}
