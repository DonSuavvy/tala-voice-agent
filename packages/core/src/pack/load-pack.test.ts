import { describe, expect, it } from "vitest";

import type { SeedWorld } from "../systems/seed-world";
import { TEST_COMPANY, testHelpFiles, testPackSource, testPlans, testSystems } from "../testing/fixtures";
import { compilePackSop, loadPack, PackValidationError, type PackSource } from "./load-pack";

/** The one error a broken source throws, so a test can read its issues. */
function issuesOf(source: Parameters<typeof loadPack>[0]): string[] {
  try {
    loadPack(source);
  } catch (error) {
    if (error instanceof PackValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected loadPack to throw, but it returned a pack");
}

describe("loadPack", () => {
  it("loads a complete valid pack", () => {
    const pack = loadPack(testPackSource());

    expect(pack.id).toBe("test-isp");
    expect(pack.company.name).toBe("Test ISP");
    expect(pack.policy.identity.maxFailedAttempts).toBe(3);
  });

  /**
   * One loaded pack is shared by every call, so no call may change what the
   * next one starts from. ES modules are strict, so a write to a frozen object
   * throws instead of silently doing nothing.
   */
  it("returns a deep-frozen pack that still structuredClones", () => {
    const pack = loadPack(testPackSource());

    expect(() => {
      pack.world.accounts[0].planName = "Hacked";
    }).toThrow(TypeError);
    expect(() => {
      pack.world.accounts.push(pack.world.accounts[0]);
    }).toThrow(TypeError);
    expect(() => {
      pack.policy.identity.maxFailedAttempts = 5;
    }).toThrow(TypeError);
    expect(() => {
      pack.sop.version = "v8";
    }).toThrow(TypeError);

    expect(() => testSystems(pack.world)).not.toThrow();

    const copy = structuredClone(pack.world);
    copy.accounts[0].planName = "Kidlat 1000";
    expect(copy.accounts[0].planName).toBe("Kidlat 1000");
    expect(pack.world.accounts[0].planName).toBe("Kidlat 300");
  });
});

describe("loadPack on a broken pack", () => {
  /** The ticket's acceptance test: four sections broken, one throw, four lines. */
  it("lists a problem from every broken section at once", () => {
    const source = testPackSource();
    source.policy = { identity: { maxFailedAttempts: 9 } };
    source.sop.body += "Credit up to {{creditLimit}}.\n";
    source.company = { name: "Test ISP", timeZone: "Asia/Manilla", locale: "en-PH", currency: "PHP" };
    const world = source.world as SeedWorld;
    world.accounts[1].barangayId = "nowhere";

    expect(() => loadPack(source)).toThrow(PackValidationError);
    const issues = issuesOf(source);

    expect(issues).toHaveLength(4);
    expect(issues).toContainEqual(expect.stringMatching(/^policy\.identity\.maxFailedAttempts: /));
    expect(issues).toContainEqual(expect.stringMatching(/^sop: .*\{\{creditLimit\}\}/));
    expect(issues).toContainEqual(expect.stringMatching(/^company\.timeZone: .*Asia\/Manilla/));
    expect(issues).toContain(
      'world.accounts[1].barangayId: account 8012345602 names unknown barangay "nowhere"',
    );
  });

  it("puts the pack id and the count in the message, one line per problem", () => {
    const source = testPackSource();
    source.policy = { identity: { maxFailedAttempts: 9 } };
    source.company = { name: "Test ISP", timeZone: "Asia/Manilla", locale: "en-PH", currency: "PHP" };

    expect(() => loadPack(source)).toThrow(
      /^Company pack "test-isp" failed validation with 2 problem\(s\):\n {2}- company\.timeZone: .*\n {2}- policy\.identity/,
    );
  });
});

describe("loadPack placeholders", () => {
  it("reports each distinct unknown placeholder as its own issue", () => {
    const source = testPackSource();
    source.sop.body += "{{creditLimit}} and {{ refundWindow }}\n";

    const issues = issuesOf(source).filter((i) => i.startsWith("sop: "));

    expect(issues).toEqual([
      "sop: unknown placeholder {{creditLimit}} (known: {{maxFailedVerificationAttempts}}, {{planCatalog}})",
      "sop: unknown placeholder {{refundWindow}} (known: {{maxFailedVerificationAttempts}}, {{planCatalog}})",
    ]);
  });

  it("reports the same unknown placeholder once, however often it is used", () => {
    const source = testPackSource();
    source.sop.body += "{{creditLimit}} then {{creditLimit}}\n";

    expect(issuesOf(source)).toEqual([
      "sop: unknown placeholder {{creditLimit}} (known: {{maxFailedVerificationAttempts}}, {{planCatalog}})",
    ]);
  });
});

describe("loadPack on a malformed placeholder", () => {
  const STRAY =
    'sop: stray "{{" or "}}" outside a placeholder; check for a malformed placeholder';

  it("refuses a placeholder with a missing closing brace", () => {
    const source = testPackSource();
    source.sop.body += "Locked after {{maxFailedVerificationAttempts} tries.\n";
    expect(issuesOf(source)).toEqual([STRAY]);
  });

  it("refuses a placeholder with a space inside the name", () => {
    const source = testPackSource();
    source.sop.body += "Locked after {{ max attempts }} tries.\n";
    expect(issuesOf(source)).toEqual([STRAY]);
  });
});

describe("loadPack on values of the wrong type", () => {
  it("lists an undefined id instead of testing the string \"undefined\"", () => {
    const source = { ...testPackSource(), id: undefined as unknown as string };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^id: /)]);
  });

  it("lists an undefined sop version", () => {
    const source = testPackSource();
    (source.sop as { version: unknown }).version = undefined;
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^sop\.version: /)]);
  });

  it("lists a non-string sop body without throwing a TypeError", () => {
    const source = testPackSource();
    (source.sop as { body: unknown }).body = 42;
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^sop\.body: /)]);
  });

  it("lists a missing sop section as issues, not a TypeError", () => {
    const source = { ...testPackSource(), sop: undefined as unknown as PackSource["sop"] };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^sop: /)]);
  });
});

describe("loadPack on the small parts", () => {
  it("rejects an id that is not a slug", () => {
    const source = { ...testPackSource(), id: "Test ISP" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^id: .*"Test ISP"/)]);
  });

  it("rejects a version with characters a prompt-cache key should not carry", () => {
    const source = testPackSource();
    source.sop.version = "v 7!";
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^sop\.version: .*"v 7!"/)]);
  });

  it("rejects a blank SOP body", () => {
    const source = testPackSource();
    source.sop.body = "  \n ";
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^sop\.body: /)]);
  });

  it("rejects a locale that is not a BCP 47 tag", () => {
    const source = testPackSource();
    source.company = { name: "Test ISP", ...TEST_COMPANY, locale: "en_PH" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^company\.locale: .*"en_PH"/)]);
  });

  it("loads the currency the company's money is spoken in", () => {
    expect(loadPack(testPackSource()).company.currency).toBe("PHP");
  });

  it.each(["PESO", "php", "XYZ", ""])("rejects %j, which is not an ISO 4217 currency code", (code) => {
    const source = testPackSource();
    source.company = { name: "Test ISP", ...TEST_COMPANY, currency: code };
    expect(issuesOf(source)).toEqual([
      `company.currency: "${code}" is not an ISO 4217 currency code`,
    ]);
  });

  it("rejects a company with no currency", () => {
    const source = testPackSource();
    source.company = { name: "Test ISP", timeZone: TEST_COMPANY.timeZone, locale: "en-PH" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^company\.currency: /)]);
  });

  /** The test pack's persona with every fixed line but one. */
  function personaWithout(line: string): Record<string, unknown> {
    const persona = { ...(testPackSource().persona as Record<string, unknown>) };
    delete persona[line];
    return persona;
  }

  it("rejects a persona that is missing its fallback line", () => {
    const source = testPackSource();
    source.persona = personaWithout("fallbackLine");
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^persona\.fallbackLine: /)]);
  });

  it("rejects a persona that is missing its filler line", () => {
    const source = testPackSource();
    source.persona = personaWithout("fillerLine");
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^persona\.fillerLine: /)]);
  });

  it("rejects a persona that is missing its closing line", () => {
    const source = testPackSource();
    source.persona = personaWithout("closingLine");
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^persona\.closingLine: /)]);
  });

  /** Nothing reads an agent name, so a pack that still carries one is refused. */
  it("refuses a persona that still has an agentName", () => {
    const source = testPackSource();
    source.persona = { ...(source.persona as object), agentName: "Tala" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^persona: .*agentName/)]);
  });
});

describe("loadPack's plan catalog", () => {
  it("loads the plans, each with its id, name, download speed and monthly price", () => {
    expect(loadPack(testPackSource()).plans).toEqual([
      { id: "kidlat-100", name: "Kidlat 100", downloadMbps: 100, monthlyPriceMinor: 129_900 },
      { id: "kidlat-300", name: "Kidlat 300", downloadMbps: 300, monthlyPriceMinor: 169_900 },
      { id: "kidlat-500", name: "Kidlat 500", downloadMbps: 500, monthlyPriceMinor: 209_900 },
    ]);
  });

  it("freezes the catalog with the rest of the pack", () => {
    const [plan] = loadPack(testPackSource()).plans;

    expect(() => {
      plan.monthlyPriceMinor = 1;
    }).toThrow(TypeError);
  });

  /** A plan with one field broken: each case names the path it must report. */
  it.each([
    ["an id that is not a slug", { id: "Kidlat 100" }, "plans[0].id"],
    ["an empty name", { name: "" }, "plans[0].name"],
    ["a speed of zero", { downloadMbps: 0 }, "plans[0].downloadMbps"],
    ["a fractional speed", { downloadMbps: 100.5 }, "plans[0].downloadMbps"],
    ["a price of zero", { monthlyPriceMinor: 0 }, "plans[0].monthlyPriceMinor"],
    ["a price in fractions of a minor unit", { monthlyPriceMinor: 1299.5 }, "plans[0].monthlyPriceMinor"],
    ["a price given as text", { monthlyPriceMinor: "129900" }, "plans[0].monthlyPriceMinor"],
    ["an unknown key", { uploadMbps: 50 }, "plans[0]"],
  ])("refuses a plan with %s, by path", (_what, change, path) => {
    const source = testPackSource();
    const plans = testPlans();
    source.plans = [{ ...plans[0], ...change }, ...plans.slice(1)];

    const issues = issuesOf(source);

    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith(`${path}: `), issues[0]).toBe(true);
  });

  it("refuses a pack with no plans", () => {
    const source = testPackSource();
    source.plans = [];
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^plans: /)]);
  });

  /** The first of two clashing plans is kept; the later one is the line to change. */
  it("refuses a duplicate plan id or name, reporting the later plan", () => {
    const source = testPackSource();
    const [hundred, threeHundred, fiveHundred] = testPlans();
    source.plans = [
      hundred,
      { ...threeHundred, id: "kidlat-100" },
      { ...fiveHundred, name: "Kidlat 300" },
    ];

    expect(issuesOf(source)).toEqual([
      'plans[1].id: duplicate plan id "kidlat-100"',
      'plans[2].name: duplicate plan name "Kidlat 300"',
    ]);
  });

  /** An account on a plan the catalog lacks could never be quoted a change. */
  it("reports each account whose plan is not in the catalog, one issue per account", () => {
    const source = testPackSource();
    const world = source.world as SeedWorld;
    world.accounts[1].planName = "Kidlat 200";
    world.accounts[2].planName = "kidlat 500";

    expect(issuesOf(source)).toEqual([
      'world.accounts[1].planName: account 8012345602 names unknown plan "Kidlat 200"',
      'world.accounts[2].planName: account 8012345603 names unknown plan "kidlat 500"',
    ]);
  });
});

describe("loadPack's help articles", () => {
  it("loads each article's id, title, tags and body, in the order the pack gives them", () => {
    expect(loadPack(testPackSource()).help).toEqual([
      {
        id: "modem-lights",
        title: "What the lights on your modem mean",
        tags: ["modem", "lights", "ilaw"],
        body: "Power is on when the modem has power. A red LOS light means no signal reaches it.",
      },
      {
        id: "wifi-password",
        title: "Changing your Wi-Fi password",
        tags: ["wifi", "password"],
        body: "Open the settings page printed on the modem's sticker and choose a new password.",
      },
    ]);
  });

  it("reads Windows line endings and spaces around the header's values", () => {
    const source = testPackSource();
    source.help = [
      {
        file: "help/restart.md",
        markdown: "---\r\nid:  restart \r\ntitle: Restarting your modem\r\ntags:restart ,  reboot\r\n---\r\n\r\nTurn it off.\r\n",
      },
    ];

    expect(loadPack(source).help).toEqual([
      { id: "restart", title: "Restarting your modem", tags: ["restart", "reboot"], body: "Turn it off." },
    ]);
  });

  it("loads a pack with no help articles", () => {
    const source = testPackSource();
    source.help = [];
    expect(loadPack(source).help).toEqual([]);
  });

  /** One article, broken one way: each case names the issue it must report, with the file. */
  it.each([
    [
      "no front matter",
      "Just a body.\n",
      'help[0]: help/broken.md does not start with a "---" front-matter header',
    ],
    [
      "a header that never closes",
      "---\nid: broken\ntitle: Broken\ntags: x\nThe body.\n",
      'help[0]: help/broken.md does not start with a "---" front-matter header',
    ],
    [
      "a header line that is not a key and value",
      "---\nid: broken\ntitle: Broken\ntags: x\njust words\n---\nThe body.\n",
      'help[0]: help/broken.md: header line "just words" is not "key: value"',
    ],
    [
      "a key given twice",
      "---\nid: broken\ntitle: Broken\ntitle: Again\ntags: x\n---\nThe body.\n",
      'help[0]: help/broken.md: header key "title" is given twice',
    ],
    [
      "an id that is not a slug",
      "---\nid: Broken One\ntitle: Broken\ntags: x\n---\nThe body.\n",
      "help[0].id: help/broken.md: ",
    ],
    ["no title", "---\nid: broken\ntags: x\n---\nThe body.\n", "help[0].title: help/broken.md: "],
    ["no tags", "---\nid: broken\ntitle: Broken\n---\nThe body.\n", "help[0].tags: help/broken.md: "],
    [
      "an empty tag",
      "---\nid: broken\ntitle: Broken\ntags: modem,, lights\n---\nThe body.\n",
      "help[0].tags[1]: help/broken.md: ",
    ],
    [
      "an unknown key",
      "---\nid: broken\ntitle: Broken\ntags: x\nauthor: me\n---\nThe body.\n",
      "help[0]: help/broken.md: ",
    ],
    [
      "a blank body",
      "---\nid: broken\ntitle: Broken\ntags: x\n---\n  \n",
      "help[0].body: help/broken.md has no text after its header",
    ],
  ])("refuses an article with %s, naming its file", (_what, markdown, issue) => {
    const source = testPackSource();
    source.help = [{ file: "help/broken.md", markdown }];

    const issues = issuesOf(source);

    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith(issue), issues[0]).toBe(true);
  });

  it("refuses a duplicate article id, reporting the later article", () => {
    const source = testPackSource();
    const [lights, password] = testHelpFiles();
    source.help = [lights, { ...password, markdown: password.markdown.replace("id: wifi-password", "id: modem-lights") }];

    expect(issuesOf(source)).toEqual([
      'help[1].id: help/wifi-password.md: duplicate article id "modem-lights"',
    ]);
  });

  it("refuses help that is not a list of files", () => {
    const source = testPackSource();
    source.help = { file: "help/modem-lights.md" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^help: /)]);
  });
});

describe("compilePackSop", () => {
  it("renders the SOP's figure from the policy, so changing the policy changes the prompt", () => {
    const three = testPackSource();
    three.policy = { identity: { maxFailedAttempts: 3 } };
    const five = testPackSource();
    five.policy = { identity: { maxFailedAttempts: 5 } };

    expect(compilePackSop(loadPack(three))).toContain("locked after 3 failed attempts");
    expect(compilePackSop(loadPack(five))).toContain("locked after 5 failed attempts");
  });

  /** The plans Tala names come from the pack's catalog, never from typed text. */
  it("renders the pack's plan catalog, so changing the catalog changes the prompt", () => {
    const shipped = testPackSource();
    shipped.sop.body += "Plans:\n{{planCatalog}}\n";
    const renamed = testPackSource();
    renamed.sop.body += "Plans:\n{{planCatalog}}\n";
    renamed.plans = testPlans().map((plan) =>
      plan.id === "kidlat-500" ? { ...plan, downloadMbps: 600 } : plan,
    );

    expect(compilePackSop(loadPack(shipped))).toContain(
      "Plans:\n" +
        "- Kidlat 100: 100 Mbps, plan id kidlat-100\n" +
        "- Kidlat 300: 300 Mbps, plan id kidlat-300\n" +
        "- Kidlat 500: 500 Mbps, plan id kidlat-500\n",
    );
    expect(compilePackSop(loadPack(renamed))).toContain("- Kidlat 500: 600 Mbps, plan id kidlat-500\n");
  });
});
