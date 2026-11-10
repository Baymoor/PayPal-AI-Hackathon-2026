/**
 * Daily Claude token budget for the AG Studio assistant proxy
 * (app/api/merchant/ai/studio/route.ts).
 *
 * Why: the proxy forwards large, client-shaped conversations to Claude, and on
 * the public demo the merchant sign-in is one click. Per-request caps bound a
 * request, not a day: without a ceiling one visitor could spend the key's whole
 * monthly allowance, which switches every AI feature off for everyone.
 *
 * How: a turn RESERVES a pessimistic estimate before Claude is called and
 * SETTLES to the real usage afterwards, so parallel turns cannot overshoot
 * together. In memory and per process (the demo runs one web process); it
 * starts again on a restart and at 00:00 UTC.
 */

/** Input plus output tokens the assistant may use per UTC day. */
export const STUDIO_DAILY_TOKEN_BUDGET = 1_500_000;

/** JSON and tool schemas tokenize denser than prose, so 3 characters per token overestimates on purpose. */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/** Tokens set aside for one turn, tied to the UTC day they were taken from. */
export interface StudioTokenReservation {
  readonly day: string;
  readonly tokens: number;
}

/** Upper estimate of one turn: the whole request body as input, plus the most the model may write. */
export function estimateStudioTurnTokens(requestChars: number, maxOutputTokens: number): number {
  return Math.ceil(requestChars / CHARS_PER_TOKEN_ESTIMATE) + maxOutputTokens;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export class StudioTokenBudget {
  private day: string;
  private usedTokens = 0;

  constructor(
    private readonly dailyLimit: number,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.day = utcDay(clock());
  }

  /** Tokens still available today. */
  remaining(): number {
    this.startNewDayIfNeeded();
    return Math.max(0, this.dailyLimit - this.usedTokens);
  }

  /** Sets `tokens` aside for one turn, or returns null when today's budget cannot cover them. */
  tryReserve(tokens: number): StudioTokenReservation | null {
    this.startNewDayIfNeeded();
    if (tokens > this.dailyLimit - this.usedTokens) return null;
    this.usedTokens += tokens;
    return { day: this.day, tokens };
  }

  /** Replaces a reservation with what the turn really used (0 when Claude was never reached). */
  settle(reservation: StudioTokenReservation, actualTokens: number): void {
    this.startNewDayIfNeeded();
    // A turn that started before midnight belongs to a day that is already closed.
    if (reservation.day !== this.day) return;
    this.usedTokens = Math.max(0, this.usedTokens - reservation.tokens + Math.max(0, actualTokens));
  }

  private startNewDayIfNeeded(): void {
    const today = utcDay(this.clock());
    if (today === this.day) return;
    this.day = today;
    this.usedTokens = 0;
  }
}

declare global {
  var __outingsStudioTokenBudget: StudioTokenBudget | undefined;
}

/** The process-wide budget (on globalThis so every Next.js bundle layer shares one counter). */
export function studioTokenBudget(): StudioTokenBudget {
  if (!globalThis.__outingsStudioTokenBudget) {
    globalThis.__outingsStudioTokenBudget = new StudioTokenBudget(STUDIO_DAILY_TOKEN_BUDGET);
  }
  return globalThis.__outingsStudioTokenBudget;
}

/** Test helper. */
export function resetStudioTokenBudgetForTests(): void {
  globalThis.__outingsStudioTokenBudget = undefined;
}
