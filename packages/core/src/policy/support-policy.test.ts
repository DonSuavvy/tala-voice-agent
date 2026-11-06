import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { compileSop, sopPlaceholders } from "../agent/sop";
import { parseSupportPolicy, SUPPORT_POLICY_RENDERERS } from "./support-policy";

/**
 * The support policy a company pack supplies: the figures the SOP states and
 * the tool handlers enforce. It is parsed at the point of decision, never
 * trusted from a TypeScript type, and its schema carries absolute caps. A
 * well-formed policy can still be harmful: OpsPilot's authorised a
 * $999,999.99 refund with zero violations (its FAILURES #15).
 */

/** When each kind of plan change takes effect: an upgrade at once, a downgrade with the next cycle. */
const PLAN_CHANGES = { upgrade: "now", downgrade: "next_cycle" } as const;

/** A whole policy with this many verification attempts. */
const withAttempts = (maxFailedAttempts: unknown) => ({
  identity: { maxFailedAttempts },
  planChanges: PLAN_CHANGES,
});

describe("parseSupportPolicy", () => {
  it("accepts a well-formed policy, and refuses wrong types and missing fields by path", () => {
    expect(parseSupportPolicy(withAttempts(3))).toEqual(withAttempts(3));

    expect(() => parseSupportPolicy(withAttempts("3"))).toThrow(ZodError);
    expect(() => parseSupportPolicy(withAttempts("3"))).toThrow(/maxFailedAttempts/);
    expect(() => parseSupportPolicy({ identity: {}, planChanges: PLAN_CHANGES })).toThrow(
      /maxFailedAttempts/,
    );
    expect(() => parseSupportPolicy({ planChanges: PLAN_CHANGES })).toThrow(/identity/);
    expect(() => parseSupportPolicy(undefined)).toThrow(ZodError);
  });

  it("allows at least one verification attempt: 1 is accepted, 0 is refused", () => {
    expect(parseSupportPolicy(withAttempts(1))).toEqual(withAttempts(1));
    expect(() => parseSupportPolicy(withAttempts(0))).toThrow(/maxFailedAttempts/);
  });

  // The secret is 4 digits. Five tries guess it 0.05% of the time; fifty
  // would make the check theatre, and fifty is a perfectly well-formed number.
  it("caps attempts absolutely: 5 is accepted, 6 and 50 are refused", () => {
    expect(parseSupportPolicy(withAttempts(5))).toEqual(withAttempts(5));
    expect(() => parseSupportPolicy(withAttempts(6))).toThrow(/maxFailedAttempts/);
    expect(() => parseSupportPolicy(withAttempts(50))).toThrow(/maxFailedAttempts/);
  });

  it("counts attempts in whole numbers: 2.5 is refused", () => {
    expect(() => parseSupportPolicy(withAttempts(2.5))).toThrow(/maxFailedAttempts/);
  });

  // A pack author who writes a limit this schema does not know would
  // otherwise see it parse, and believe it is enforced.
  it("refuses an unknown top-level key instead of ignoring it", () => {
    expect(() => parseSupportPolicy({ ...withAttempts(3), lockoutMinutes: 30 })).toThrow(
      /lockoutMinutes/,
    );
  });

  it("refuses an unknown key inside identity, such as a typo'd limit", () => {
    expect(() =>
      parseSupportPolicy({
        identity: { maxFailedAttempts: 3, maxFailedAtempts: 1 },
        planChanges: PLAN_CHANGES,
      }),
    ).toThrow(/maxFailedAtempts/);
  });
});

/** The plan-change rules: when an upgrade and a downgrade take effect. */
describe("parseSupportPolicy — plan changes", () => {
  it.each([
    ["now", "next_cycle"],
    ["next_cycle", "now"],
    ["now", "now"],
    ["next_cycle", "next_cycle"],
  ])("accepts an upgrade taking effect %s and a downgrade %s", (upgrade, downgrade) => {
    const policy = { identity: { maxFailedAttempts: 3 }, planChanges: { upgrade, downgrade } };
    expect(parseSupportPolicy(policy)).toEqual(policy);
  });

  it("refuses a policy that does not say when plan changes take effect", () => {
    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: 3 } })).toThrow(/planChanges/);
    expect(() =>
      parseSupportPolicy({ identity: { maxFailedAttempts: 3 }, planChanges: { upgrade: "now" } }),
    ).toThrow(/downgrade/);
  });

  it("refuses a timing it does not know, and an unknown key", () => {
    expect(() =>
      parseSupportPolicy({
        identity: { maxFailedAttempts: 3 },
        planChanges: { upgrade: "tomorrow", downgrade: "next_cycle" },
      }),
    ).toThrow(/upgrade/);
    expect(() =>
      parseSupportPolicy({
        identity: { maxFailedAttempts: 3 },
        planChanges: { ...PLAN_CHANGES, prorate: false },
      }),
    ).toThrow(/prorate/);
  });
});

describe("SUPPORT_POLICY_RENDERERS", () => {
  const SOP = "After {{maxFailedVerificationAttempts}} wrong answers, stop verifying.";

  it("offers the attempt limit and when each kind of plan change takes effect", () => {
    expect(sopPlaceholders(SUPPORT_POLICY_RENDERERS)).toEqual([
      "maxFailedVerificationAttempts",
      "upgradeTakesEffect",
      "downgradeTakesEffect",
    ]);
  });

  // The ticket's "changing the config changes the compiled prompt": the
  // figure the model reads is the figure the handler enforces.
  it("renders the attempt limit from the policy into the compiled SOP", () => {
    expect(
      compileSop({
        bodyMarkdown: SOP,
        policyConfig: parseSupportPolicy(withAttempts(3)),
        renderers: SUPPORT_POLICY_RENDERERS,
      }),
    ).toBe("After 3 wrong answers, stop verifying.");

    expect(
      compileSop({
        bodyMarkdown: SOP,
        policyConfig: parseSupportPolicy(withAttempts(5)),
        renderers: SUPPORT_POLICY_RENDERERS,
      }),
    ).toBe("After 5 wrong answers, stop verifying.");
  });

  /** The timing the SOP states is the timing the pricing applies. */
  it("renders when an upgrade and a downgrade take effect from the policy", () => {
    const render = (planChanges: { upgrade: string; downgrade: string }) =>
      compileSop({
        bodyMarkdown:
          "An upgrade takes effect {{upgradeTakesEffect}}. A downgrade takes effect {{downgradeTakesEffect}}.",
        policyConfig: parseSupportPolicy({ identity: { maxFailedAttempts: 3 }, planChanges }),
        renderers: SUPPORT_POLICY_RENDERERS,
      });

    expect(render({ upgrade: "now", downgrade: "next_cycle" })).toBe(
      "An upgrade takes effect at once. A downgrade takes effect when the next billing cycle starts.",
    );
    expect(render({ upgrade: "next_cycle", downgrade: "now" })).toBe(
      "An upgrade takes effect when the next billing cycle starts. A downgrade takes effect at once.",
    );
  });
});
