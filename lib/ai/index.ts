import type { Outing } from "../db/schema";
import { config, type AiMode } from "../env";
import { AnthropicOutingsAi } from "./anthropic";
import { FixtureOutingsAi } from "./fixture";
import type { OutingsAi } from "./types";

export class AiUnavailableError extends Error {
  constructor() {
    super("AI is unavailable: set OUTINGS_ANTHROPIC_API_KEY or enable DEMO_FIXTURES_ENABLED.");
    this.name = "AiUnavailableError";
  }
}

let cached: OutingsAi | null = null;
let cachedFixture: OutingsAi | null = null;

/** The deployment's AI: Claude when a key is set, else the sample AI in demo mode. */
export function getOutingsAi(): OutingsAi {
  if (cached) return cached;
  const cfg = config();
  if (cfg.anthropic) cached = new AnthropicOutingsAi();
  else if (cfg.demoFixturesEnabled) cached = new FixtureOutingsAi();
  else throw new AiUnavailableError();
  return cached;
}

/** The deterministic sample AI (FIXTURE), whatever the deployment's mode. For demo outings; see `aiModeForOuting`. */
export function getFixtureOutingsAi(): OutingsAi {
  cachedFixture ??= new FixtureOutingsAi();
  return cachedFixture;
}

/**
 * The AI mode of THIS outing, mirroring `paymentModeForOuting` (lib/services/payments.ts). Demo outings
 * (isFixture: the seeded ones and every /demo story) always get the sample AI, even when an Anthropic key
 * is set: anonymous visitors never spend the owner's model budget, and their screens never say Claude.
 * Once demo mode is off they get no AI at all, never a real model. Real outings use the deployment's mode.
 */
export function aiModeForOuting(outing: Pick<Outing, "isFixture">): AiMode {
  const cfg = config();
  if (outing.isFixture) return cfg.demoFixturesEnabled ? "FIXTURE" : "DISABLED";
  return cfg.aiMode;
}

/** Test helper. */
export function resetOutingsAiForTests(): void {
  cached = null;
}

export { AiOutputError, AiProviderError } from "./validate";
export type * from "./types";
