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

describe("parseSupportPolicy", () => {
  it("accepts a well-formed policy, and refuses wrong types and missing fields by path", () => {
    expect(parseSupportPolicy({ identity: { maxFailedAttempts: 3 } })).toEqual({
      identity: { maxFailedAttempts: 3 },
    });

    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: "3" } })).toThrow(ZodError);
    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: "3" } })).toThrow(
      /maxFailedAttempts/,
    );
    expect(() => parseSupportPolicy({ identity: {} })).toThrow(/maxFailedAttempts/);
    expect(() => parseSupportPolicy({})).toThrow(/identity/);
    expect(() => parseSupportPolicy(undefined)).toThrow(ZodError);
  });

  it("allows at least one verification attempt: 1 is accepted, 0 is refused", () => {
    expect(parseSupportPolicy({ identity: { maxFailedAttempts: 1 } })).toEqual({
      identity: { maxFailedAttempts: 1 },
    });
    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: 0 } })).toThrow(
      /maxFailedAttempts/,
    );
  });

  // The secret is 4 digits. Five tries guess it 0.05% of the time; fifty
  // would make the check theatre, and fifty is a perfectly well-formed number.
  it("caps attempts absolutely: 5 is accepted, 6 and 50 are refused", () => {
    expect(parseSupportPolicy({ identity: { maxFailedAttempts: 5 } })).toEqual({
      identity: { maxFailedAttempts: 5 },
    });
    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: 6 } })).toThrow(
      /maxFailedAttempts/,
    );
    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: 50 } })).toThrow(
      /maxFailedAttempts/,
    );
  });

  it("counts attempts in whole numbers: 2.5 is refused", () => {
    expect(() => parseSupportPolicy({ identity: { maxFailedAttempts: 2.5 } })).toThrow(
      /maxFailedAttempts/,
    );
  });

  // A pack author who writes a limit this schema does not know would
  // otherwise see it parse, and believe it is enforced.
  it("refuses an unknown top-level key instead of ignoring it", () => {
    expect(() =>
      parseSupportPolicy({ identity: { maxFailedAttempts: 3 }, lockoutMinutes: 30 }),
    ).toThrow(/lockoutMinutes/);
  });

  it("refuses an unknown key inside identity, such as a typo'd limit", () => {
    expect(() =>
      parseSupportPolicy({ identity: { maxFailedAttempts: 3, maxFailedAtempts: 1 } }),
    ).toThrow(/maxFailedAtempts/);
  });
});

describe("SUPPORT_POLICY_RENDERERS", () => {
  const SOP = "After {{maxFailedVerificationAttempts}} wrong answers, stop verifying.";

  // The ticket's "changing the config changes the compiled prompt": the
  // figure the model reads is the figure the handler enforces.
  it("renders the attempt limit from the policy into the compiled SOP", () => {
    expect(sopPlaceholders(SUPPORT_POLICY_RENDERERS)).toEqual(["maxFailedVerificationAttempts"]);

    expect(
      compileSop({
        bodyMarkdown: SOP,
        policyConfig: parseSupportPolicy({ identity: { maxFailedAttempts: 3 } }),
        renderers: SUPPORT_POLICY_RENDERERS,
      }),
    ).toBe("After 3 wrong answers, stop verifying.");

    expect(
      compileSop({
        bodyMarkdown: SOP,
        policyConfig: parseSupportPolicy({ identity: { maxFailedAttempts: 5 } }),
        renderers: SUPPORT_POLICY_RENDERERS,
      }),
    ).toBe("After 5 wrong answers, stop verifying.");
  });
});
