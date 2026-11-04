import { config } from "../env";
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

export function getOutingsAi(): OutingsAi {
  if (cached) return cached;
  const cfg = config();
  if (cfg.anthropic) cached = new AnthropicOutingsAi();
  else if (cfg.demoFixturesEnabled) cached = new FixtureOutingsAi();
  else throw new AiUnavailableError();
  return cached;
}

/** Test helper. */
export function resetOutingsAiForTests(): void {
  cached = null;
}

export { AiOutputError, AiProviderError } from "./validate";
export type * from "./types";
