import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compilePackSop } from "@tala/core";
import { loadCases, speakingStyleOf } from "@tala/evals";
import { loadKidlatFiber } from "@tala/kidlat-fiber";

/**
 * The Kidlat Fiber pack as `npm run eval` uses it. Repo-level, because
 * `@tala/evals` itself depends on no company pack. None of this needs a key,
 * so a pack change that would break the suite fails here before any money is
 * spent.
 */

const KIDLAT_CASES = fileURLToPath(
  new URL("../packages/packs/kidlat-fiber/evals/cases/", import.meta.url),
);

describe("Kidlat Fiber's eval cases", () => {
  it("all load, and scenario 1's outage check is the first", () => {
    const cases = loadCases(KIDLAT_CASES);

    expect(cases[0].slug).toBe("scenario-1-outage");
  });

  /** The ticket's expectations for scenario 1 (#9, E10), as literals. */
  it("scenario 1 expects what the ticket says", () => {
    const [scenarioOne] = loadCases(KIDLAT_CASES);

    expect(scenarioOne.caller.maxTurns).toBe(6);
    expect(scenarioOne.expect).toEqual({
      endedBy: "end_call",
      toolsCalled: ["verify_identity", "check_area_outage", "end_call"],
      disposition: { outcome: "resolved", topic: "outage" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  /** The caller can only verify with what the brief tells them. */
  it("scenario 1's caller knows Maria's account number and her mobile's last four", () => {
    const [scenarioOne] = loadCases(KIDLAT_CASES);

    expect(scenarioOne.caller.brief).toContain("8012345601");
    expect(scenarioOne.caller.brief).toContain("0101");
  });
});

describe("Kidlat Fiber's SOP, as the advisory grader reads it", () => {
  /** Renaming the heading would quietly leave every case without a grade. */
  it("has a How you speak section for the grader to grade against", () => {
    const style = speakingStyleOf(compilePackSop(loadKidlatFiber()));

    expect(style).not.toBeNull();
    expect(style).toContain("Taglish");
  });
});
