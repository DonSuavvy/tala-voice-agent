import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildTalaRegistry, compilePackSop } from "@tala/core";
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

  function scenarioTwo() {
    const found = loadCases(KIDLAT_CASES).find((c) => c.slug === "scenario-2-payment");
    if (!found) throw new Error("no scenario-2-payment case");
    return found;
  }

  /** The ticket's expectations for scenario 2 (#10), as literals. */
  it("scenario 2 expects what the ticket says", () => {
    expect(scenarioTwo().expect).toEqual({
      endedBy: "end_call",
      toolsCalled: ["verify_identity", "verify_payment", "create_trouble_ticket", "send_sms", "end_call"],
      disposition: { outcome: "resolved", topic: "payment" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  /** The caller can only verify, and Tala can only find the payment, with what the brief says. */
  it("scenario 2's caller knows Jose's account number, his mobile's last four and the GCash reference", () => {
    const { brief } = scenarioTwo().caller;

    expect(brief).toContain("Jose Dela Cruz");
    expect(brief).toContain("8012345602");
    expect(brief).toContain("0102");
    expect(brief).toContain("1234567890123");
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

describe("Kidlat Fiber's SOP, as Tala reads it", () => {
  /** Every `snake_case` name in backticks: how the SOP names a tool or a ticket category. */
  function namesIn(sop: string): string[] {
    return [...sop.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
  }

  /** A renamed tool, or a typo in the SOP, would brief Tala on a tool she does not have. */
  it("names only tools Tala has", () => {
    const tools = buildTalaRegistry()
      .list()
      .map((tool) => tool.name);

    for (const name of namesIn(compilePackSop(loadKidlatFiber()))) {
      expect(tools, `the SOP names \`${name}\``).toContain(name);
    }
  });

  it("briefs Tala on scenario 2's tools", () => {
    const named = namesIn(compilePackSop(loadKidlatFiber()));

    expect(named).toEqual(expect.arrayContaining(["verify_payment", "create_trouble_ticket", "send_sms"]));
  });
});
