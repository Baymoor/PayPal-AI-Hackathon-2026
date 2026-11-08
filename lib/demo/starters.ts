/**
 * One-click starters for /new: realistic example briefs that prefill the plan
 * field (they never submit). Each maps to a catalogue category and the demo
 * venue that sells it, so the FIXTURE parser and ranker can be checked end to
 * end. Pure constants: imported by the client form and by tests.
 */
import type { DemoVenueSlug } from "./constants";

export const STARTER_IDS = ["karaoke-birthday", "movie-night", "wine-tasting", "gym-session", "padel-doubles"] as const;
export type StarterId = (typeof STARTER_IDS)[number];

export interface OutingStarter {
  id: StarterId;
  /** Short button label. */
  label: string;
  /** Written the way a person would type it: day/time, group size, rough budget, one detail. */
  brief: string;
  /** Catalogue category the brief should map to. */
  category: string;
  /** Demo venue whose offering fits the starter best. */
  venueSlug: DemoVenueSlug;
}

export const OUTING_STARTERS: readonly OutingStarter[] = [
  {
    id: "karaoke-birthday",
    label: "Karaoke for Maya's birthday",
    brief:
      "Karaoke for Maya's birthday on Friday evening. Six of us, ideally a private room, and we want to cover Maya's share. Around $100 total.",
    category: "karaoke",
    venueSlug: "the-sound-room",
  },
  {
    id: "movie-night",
    label: "Movie night",
    brief:
      "Movie night for eight of us on Saturday evening. Ideally a private screening room so we can pick the film ourselves. About $120 total, split evenly.",
    category: "cinema",
    venueSlug: "velvet-seats-screening-room",
  },
  {
    id: "wine-tasting",
    label: "Wine tasting with the girlies",
    brief:
      "Wine tasting with the girlies next Thursday after work. Six of us, around $50 each. Would love our own table so we can actually hear each other.",
    category: "wine-tasting",
    venueSlug: "cork-and-pebble",
  },
  {
    id: "gym-session",
    label: "Gym session at the new gym with the boys",
    brief:
      "Gym session at the new gym with the boys on Saturday morning. Five of us, about $90 total, and we want a coach to run the whole thing.",
    category: "fitness",
    venueSlug: "iron-lantern-gym",
  },
  {
    id: "padel-doubles",
    label: "Padel doubles",
    brief: "Padel doubles on Sunday afternoon, four of us. One court for 90 minutes, about $60 total, split four ways.",
    category: "padel",
    venueSlug: "glasswall-padel",
  },
];
