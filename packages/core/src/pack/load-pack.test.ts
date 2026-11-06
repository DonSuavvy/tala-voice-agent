import { describe, expect, it } from "vitest";

import { createInMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import { CALL_STARTED_AT, testPackSource } from "../testing/fixtures";
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

    expect(() => createInMemorySystems(pack.world, CALL_STARTED_AT)).not.toThrow();

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
    source.company = { name: "Test ISP", timeZone: "Asia/Manilla", locale: "en-PH" };
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
    source.company = { name: "Test ISP", timeZone: "Asia/Manilla", locale: "en-PH" };

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
      "sop: unknown placeholder {{creditLimit}} (known: {{maxFailedVerificationAttempts}})",
      "sop: unknown placeholder {{refundWindow}} (known: {{maxFailedVerificationAttempts}})",
    ]);
  });

  it("reports the same unknown placeholder once, however often it is used", () => {
    const source = testPackSource();
    source.sop.body += "{{creditLimit}} then {{creditLimit}}\n";

    expect(issuesOf(source)).toEqual([
      "sop: unknown placeholder {{creditLimit}} (known: {{maxFailedVerificationAttempts}})",
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
    source.company = { name: "Test ISP", timeZone: "Asia/Manila", locale: "en_PH" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^company\.locale: .*"en_PH"/)]);
  });

  it("rejects a persona that is missing its fallback line", () => {
    const source = testPackSource();
    source.persona = { openingLine: "Hello po!" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^persona\.fallbackLine: /)]);
  });

  /** Nothing reads an agent name, so a pack that still carries one is refused. */
  it("refuses a persona that still has an agentName", () => {
    const source = testPackSource();
    source.persona = { ...(source.persona as object), agentName: "Tala" };
    expect(issuesOf(source)).toEqual([expect.stringMatching(/^persona: .*agentName/)]);
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
});
