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
  it("scenario 2 expects what the ticket says, in order, with the payment unposted and a billing ticket", () => {
    expect(scenarioTwo().expect).toEqual({
      endedBy: "end_call",
      toolsCalled: ["verify_identity", "verify_payment", "create_trouble_ticket", "send_sms", "end_call"],
      toolsCalledInOrder: ["verify_identity", "verify_payment", "create_trouble_ticket", "send_sms", "end_call"],
      toolResults: [
        { tool: "verify_payment", result: { found: true, posted: false } },
        { tool: "create_trouble_ticket", input: { category: "billing" } },
      ],
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

  function scenarioThree() {
    const found = loadCases(KIDLAT_CASES).find((c) => c.slug === "scenario-3-slow-internet");
    if (!found) throw new Error("no scenario-3-slow-internet case");
    return found;
  }

  /** The ticket's expectations for scenario 3 (#11), as literals. */
  it("scenario 3 expects what the ticket says, in order, with a connection ticket and a booked visit", () => {
    expect(scenarioThree().expect).toEqual({
      endedBy: "end_call",
      toolsCalledInOrder: [
        "verify_identity",
        "run_line_diagnostics",
        "remote_reboot_modem",
        "create_trouble_ticket",
        "get_technician_slots",
        "book_technician_visit",
        "send_sms",
        "end_call",
      ],
      toolResults: [
        { tool: "create_trouble_ticket", input: { category: "connection" } },
        { tool: "book_technician_visit", result: { booked: true } },
      ],
      disposition: { outcome: "resolved", topic: "slow_internet" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  /** The caller can only verify with what the brief says. */
  it("scenario 3's caller knows Ana's account number and her mobile's last four", () => {
    const { brief } = scenarioThree().caller;

    expect(brief).toContain("Ana Reyes");
    expect(brief).toContain("8012345603");
    expect(brief).toContain("0103");
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

  it("briefs Tala on the billing, ticket and text tools", () => {
    const named = namesIn(compilePackSop(loadKidlatFiber()));

    expect(named).toEqual(
      expect.arrayContaining([
        "get_account_overview",
        "get_billing_history",
        "verify_payment",
        "create_trouble_ticket",
        "send_sms",
      ]),
    );
  });

  it("briefs Tala on the diagnostics, reboot, technician slot and booking tools", () => {
    const named = namesIn(compilePackSop(loadKidlatFiber()));

    expect(named).toEqual(
      expect.arrayContaining([
        "run_line_diagnostics",
        "remote_reboot_modem",
        "get_technician_slots",
        "book_technician_visit",
      ]),
    );
  });

  /** The section of the SOP under a `## ` heading, up to the next one. */
  function sectionOf(sop: string, heading: string): string {
    const start = sop.indexOf(`## ${heading}\n`);
    expect(start, `the SOP has a "${heading}" section`).toBeGreaterThanOrEqual(0);
    const end = sop.indexOf("\n## ", start + 1);
    return sop.slice(start, end === -1 ? undefined : end);
  }

  /** Windows, waits and signal levels come from the tools, so the section types none. */
  it("types no figure into its slow-internet section", () => {
    expect(sectionOf(compilePackSop(loadKidlatFiber()), "Slow or no internet")).not.toMatch(/\d/);
  });

  /** An example that copied scenario 3's data would tell Tala the answer (R2-15). */
  it("uses none of the seed's faults or slots as an example", () => {
    const pack = loadKidlatFiber();
    const sop = compilePackSop(pack).toLowerCase();

    for (const modem of pack.world.modems) {
      if (modem.fault !== null) expect(sop, modem.fault).not.toContain(modem.fault.toLowerCase());
    }
    for (const slot of pack.world.technicianSlots) expect(sop).not.toContain(slot.id);
  });
});
