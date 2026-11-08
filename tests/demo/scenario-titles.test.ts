/**
 * Scenario outings keep their hub label as the stored title (the hub finds the kind by it), while
 * participants see a plain story name.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SCENARIO_KINDS, DEMO_SCENARIO_TITLES, participantFacingTitle } from "@/lib/demo/constants";

describe("scenario titles", () => {
  it("stored titles stay unique, so the kind lookup by title is unambiguous", () => {
    const titles = DEMO_SCENARIO_KINDS.map((k) => DEMO_SCENARIO_TITLES[k]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("participants never see the hub's scenario label", () => {
    for (const kind of DEMO_SCENARIO_KINDS) {
      expect(participantFacingTitle(DEMO_SCENARIO_TITLES[kind])).not.toMatch(/scenario/i);
    }
  });

  it("leaves every other outing title unchanged", () => {
    expect(participantFacingTitle("Friday game night")).toBe("Friday game night");
  });
});
