import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildTalaRegistry, compilePackSop, createInMemorySystems } from "@tala/core";
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

/** The case with this slug, or a failed test. */
function caseNamed(slug: string) {
  const found = loadCases(KIDLAT_CASES).find((c) => c.slug === slug);
  if (!found) throw new Error(`no ${slug} case`);
  return found;
}

describe("Kidlat Fiber's eval cases", () => {
  it("all load, scenario 1's outage check among them", () => {
    const slugs = loadCases(KIDLAT_CASES).map((c) => c.slug);

    expect(slugs).toContain("scenario-1-outage");
  });

  /** The ticket's expectations for scenario 1 (#9, E10), as literals. */
  it("scenario 1 expects what the ticket says", () => {
    const scenarioOne = caseNamed("scenario-1-outage");

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
    const scenarioOne = caseNamed("scenario-1-outage");

    expect(scenarioOne.caller.brief).toContain("8012345601");
    expect(scenarioOne.caller.brief).toContain("0101");
  });

  const scenarioTwo = () => caseNamed("scenario-2-payment");

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

  const scenarioThree = () => caseNamed("scenario-3-slow-internet");

  /**
   * The ticket's expectations for scenario 3 (#11), as literals: the area is
   * checked before the line, as the SOP says, and the earliest window is
   * booked, as the caller asks.
   */
  it("scenario 3 expects what the ticket says, in order, with a connection ticket and the earliest window booked", () => {
    expect(scenarioThree().expect).toEqual({
      endedBy: "end_call",
      toolsCalledInOrder: [
        "verify_identity",
        "check_area_outage",
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
        { tool: "book_technician_visit", input: { slot_id: "san-antonio-1" }, result: { booked: true } },
      ],
      disposition: { outcome: "resolved", topic: "slow_internet" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  /**
   * The slot the case expects is the seed's earliest in San Antonio. Slots
   * are stated by days after the call, so the order is the same whenever the
   * call starts.
   */
  it("scenario 3's expected slot is the earliest open window in Ana's barangay", async () => {
    const pack = loadKidlatFiber();
    const booking = scenarioThree().expect.toolResults?.find((r) => r.tool === "book_technician_visit");
    const callStartedAt = new Date("2026-11-06T05:00:00Z");
    const world = createInMemorySystems(pack.world, callStartedAt, pack.company.timeZone);

    const [earliest] = await world.fieldService.availableSlots("san-antonio");
    expect(booking?.input).toEqual({ slot_id: earliest.slotId });
  });

  /** The caller can only verify with what the brief says. */
  it("scenario 3's caller knows Ana's account number and her mobile's last four", () => {
    const { brief } = scenarioThree().caller;

    expect(brief).toContain("Ana Reyes");
    expect(brief).toContain("8012345603");
    expect(brief).toContain("0103");
  });
});

/** Issue #16's cases: an upgrade accepted, an upgrade declined, and a help question. */
describe("Kidlat Fiber's plan-change and help cases", () => {
  const pack = loadKidlatFiber();
  const planNamed = (name: string) => {
    const plan = pack.plans.find((p) => p.name === name);
    if (!plan) throw new Error(`no plan named ${name}`);
    return plan;
  };
  const accountOf = (accountNumber: string) => {
    const account = pack.world.accounts.find((a) => a.accountNumber === accountNumber);
    if (!account) throw new Error(`no account ${accountNumber}`);
    return account;
  };

  /**
   * The quote is for Kidlat 500, the change is confirmed and made, and only
   * then does the call end.
   */
  it("the accepted upgrade expects a quote, a confirmed change, in that order", () => {
    expect(caseNamed("scenario-plan-upgrade-accepted").expect).toEqual({
      endedBy: "end_call",
      toolsCalledInOrder: ["verify_identity", "change_plan_quote", "change_plan", "end_call"],
      toolResults: [
        { tool: "change_plan_quote", input: { plan_id: "kidlat-500" } },
        { tool: "change_plan", input: { customer_confirmed: true }, result: { changed: true } },
      ],
      disposition: { outcome: "resolved", topic: "plan_change" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  it("the accepted upgrade quotes Kidlat 500 by its catalog id, an upgrade from Maria's plan", () => {
    const quote = caseNamed("scenario-plan-upgrade-accepted").expect.toolResults?.find(
      (r) => r.tool === "change_plan_quote",
    );
    const maria = planNamed(accountOf("8012345601").planName);

    expect(quote?.input).toEqual({ plan_id: planNamed("Kidlat 500").id });
    expect(planNamed("Kidlat 500").monthlyPriceMinor).toBeGreaterThan(maria.monthlyPriceMinor);
  });

  it("the accepted upgrade's caller is Maria, with her numbers, asking for Kidlat 500", () => {
    const { brief } = caseNamed("scenario-plan-upgrade-accepted").caller;

    expect(brief).toContain("Maria Santos");
    expect(brief).toContain("8012345601");
    expect(brief).toContain("0101");
    expect(brief).toContain("Kidlat 500");
  });

  /** Jose hears the price and keeps his plan: no change is ever attempted. */
  it("the declined upgrade expects a quote and no change", () => {
    expect(caseNamed("scenario-plan-upgrade-declined").expect).toEqual({
      endedBy: "end_call",
      toolsCalledInOrder: ["verify_identity", "change_plan_quote", "end_call"],
      toolsNever: ["change_plan"],
      disposition: { outcome: "resolved", topic: "plan_change" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  it("the declined upgrade's caller is Jose, with his numbers, asking about Kidlat 300, an upgrade for him", () => {
    const { brief } = caseNamed("scenario-plan-upgrade-declined").caller;
    const jose = planNamed(accountOf("8012345602").planName);

    expect(brief).toContain("Jose Dela Cruz");
    expect(brief).toContain("8012345602");
    expect(brief).toContain("0102");
    expect(brief).toContain("Kidlat 300");
    expect(planNamed("Kidlat 300").monthlyPriceMinor).toBeGreaterThan(jose.monthlyPriceMinor);
  });

  it("the modem-lights question expects a search of the help articles and the article's advice", () => {
    expect(caseNamed("help-modem-lights").expect).toEqual({
      endedBy: "end_call",
      toolsCalled: ["search_knowledge_base", "end_call"],
      saidMentions: ["bent"],
      disposition: { topic: "help" },
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
    });
  });

  /**
   * The word Tala must say comes from the right article and nowhere else she
   * could take it from: no other article, not the SOP, not the caller.
   */
  it("the modem-lights question's word is the modem-lights article's alone", () => {
    const { saidMentions } = caseNamed("help-modem-lights").expect;
    const { brief } = caseNamed("help-modem-lights").caller;
    const sop = compilePackSop(pack).toLowerCase();

    for (const word of saidMentions ?? []) {
      const has = (text: string) => new RegExp(`\\b${word}\\b`, "i").test(text);
      expect(pack.help.filter((a) => has(`${a.title} ${a.body}`)).map((a) => a.id)).toEqual([
        "modem-lights",
      ]);
      expect(has(sop), "the SOP").toBe(false);
      expect(has(brief), "the caller's brief").toBe(false);
    }
  });

  it("the modem-lights caller asks about a red LOS light and has no account number to give", () => {
    const { brief } = caseNamed("help-modem-lights").caller;

    expect(brief).toContain("LOS");
    expect(brief).toMatch(/red/);
    for (const account of pack.world.accounts) expect(brief).not.toContain(account.accountNumber);
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

  /**
   * How many windows to offer, the windows themselves, the wait and the signal
   * level all come from the tools, so the section states no number, in digits
   * or in words.
   */
  it("states no number in its slow-internet section", () => {
    const section = sectionOf(compilePackSop(loadKidlatFiber()), "Slow or no internet");

    expect(section).not.toMatch(/\d/);
    expect(section).not.toMatch(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  });

  /** Windows are read as the tool gives them, so an example naming days would mislead. */
  it("names no weekday in its slow-internet section", () => {
    const section = sectionOf(compilePackSop(loadKidlatFiber()), "Slow or no internet");

    expect(section).not.toMatch(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i);
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

  it("briefs Tala on the plan-change tools in its Changing plans section", () => {
    const named = namesIn(sectionOf(compilePackSop(loadKidlatFiber()), "Changing plans"));

    expect(named).toEqual(expect.arrayContaining(["change_plan_quote", "change_plan"]));
  });

  it("briefs Tala on the help-article search in its Help questions section", () => {
    const named = namesIn(sectionOf(compilePackSop(loadKidlatFiber()), "Help questions"));

    expect(named).toContain("search_knowledge_base");
  });

  /** Tala names plans and speeds from the catalog, and passes its ids to the quote. */
  it("lists every plan in the catalog, with its speed and id, in its Changing plans section", () => {
    const pack = loadKidlatFiber();
    const section = sectionOf(compilePackSop(pack), "Changing plans");

    for (const plan of pack.plans) {
      expect(section).toContain(`- ${plan.name}: ${plan.downloadMbps} Mbps, plan id ${plan.id}`);
    }
  });

  /**
   * Plans, speeds and prices come from the catalog and the quote, so the
   * sections as written state none: no digits, no amounts, no speeds, no plan
   * names. The compiled SOP has the catalog's, through its placeholder.
   */
  it.each(["Changing plans", "Help questions"])(
    "types no plan, speed, price or other figure in its %s section",
    (heading) => {
      const pack = loadKidlatFiber();
      const written = sectionOf(pack.sop.body, heading);

      expect(written).not.toMatch(/\d/);
      expect(written).not.toMatch(/₱|peso|centavo|mbps/i);
      for (const plan of pack.plans) expect(written).not.toContain(plan.name);
    },
  );

  it("states the plan catalog through its placeholder", () => {
    expect(sectionOf(loadKidlatFiber().sop.body, "Changing plans")).toContain("{{planCatalog}}");
  });

  /**
   * An example that copied the help case would tell Tala the answer (R2-15):
   * neither the Help questions section nor the rest of the SOP mentions the
   * modem's lights or names an article.
   */
  it("uses neither the modem lights nor any help article as an example", () => {
    const pack = loadKidlatFiber();
    const sop = compilePackSop(pack);

    for (const text of [sectionOf(sop, "Help questions"), sop]) {
      expect(text).not.toMatch(/\bLOS\b|\blights?\b/i);
      for (const article of pack.help) {
        expect(text).not.toContain(article.id);
        expect(text).not.toContain(article.title);
      }
    }
  });
});
