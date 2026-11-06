import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCases } from "./load-cases";

/**
 * Kidlat Fiber's eval cases, as `npm run eval` loads them: data in the
 * company pack, read from its directory. This needs no key; it proves the
 * suite the runner will play parses, so a broken case fails here before any
 * money is spent.
 */

const KIDLAT_CASES = fileURLToPath(new URL("../../packs/kidlat-fiber/evals/cases/", import.meta.url));

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
