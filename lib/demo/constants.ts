/** Demo identifiers shared by the seed, the demo endpoints and merchant sign-in. */
export const DEMO_MERCHANT_SLUG = "the-sound-room";
export const DEMO_MERCHANT_NAME = "The Sound Room";
export const DEMO_TIMEZONE = "Europe/Copenhagen";
export const DEMO_MAIN_TITLE = "Maya's birthday karaoke";
export const DEMO_BUDGET_TITLE = "Friday game night";

/*
 * Demo venues: The Sound Room plus four FICTIONAL venues (invented names, not
 * real businesses) so each one-click starter has a matching merchant. Pure
 * constants: the merchant sign-in picker (client) and the server both import
 * them. Offerings and seeding live in lib/demo/venues.ts.
 */
export const DEMO_VENUE_SLUGS = [
  DEMO_MERCHANT_SLUG,
  "velvet-seats-screening-room",
  "cork-and-pebble",
  "iron-lantern-gym",
  "glasswall-padel",
] as const;
export type DemoVenueSlug = (typeof DEMO_VENUE_SLUGS)[number];

export const DEMO_VENUE_NAMES: Record<DemoVenueSlug, string> = {
  "the-sound-room": DEMO_MERCHANT_NAME,
  "velvet-seats-screening-room": "Velvet Seats Screening Room",
  "cork-and-pebble": "Cork & Pebble Tasting Room",
  "iron-lantern-gym": "Iron Lantern Gym",
  "glasswall-padel": "Glasswall Padel",
};

export function isDemoVenueSlug(value: unknown): value is DemoVenueSlug {
  return typeof value === "string" && (DEMO_VENUE_SLUGS as readonly string[]).includes(value);
}

/*
 * One-click demo scenarios (POST /api/demo/scenario). Pure constants: imported by
 * the demo hub (client) and lib/demo/scenarios.ts (server).
 */
export const DEMO_SCENARIO_KINDS = ["settle-soon", "holdout", "capture-failure", "big-group"] as const;
export type DemoScenarioKind = (typeof DEMO_SCENARIO_KINDS)[number];

/** Commitment deadline of a scenario outing, in seconds from creation (the policy minimum is 60 s). */
export const DEMO_SCENARIO_DEADLINE_SECONDS = { min: 60, max: 600, default: 120 } as const;

/** Exact titles of scenario outings (also how the hub recognises them). */
export const DEMO_SCENARIO_TITLES: Record<DemoScenarioKind, string> = {
  "settle-soon": "Maya's karaoke · settles on time (scenario)",
  holdout: "Maya's karaoke · one holdout (scenario)",
  "capture-failure": "Maya's karaoke · capture fails (scenario)",
  "big-group": "Ten friends · karaoke room $10 each (scenario)",
};

export function isDemoScenarioKind(value: unknown): value is DemoScenarioKind {
  return typeof value === "string" && (DEMO_SCENARIO_KINDS as readonly string[]).includes(value);
}

/** Clamp a requested deadline to the allowed window; anything unusable falls back to the default. */
export function clampScenarioSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEMO_SCENARIO_DEADLINE_SECONDS.default;
  return Math.min(DEMO_SCENARIO_DEADLINE_SECONDS.max, Math.max(DEMO_SCENARIO_DEADLINE_SECONDS.min, Math.round(n)));
}
