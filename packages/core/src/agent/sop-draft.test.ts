import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatMoney, UnknownPlaceholderError, type SopRenderers } from "./sop";
import { SopDraftError, validateSopDraft } from "./sop-draft";

/**
 * Checking an SOP and its policy before they become the live prompt: the
 * tool registry's boot validation, applied to policy. A company pack runs it
 * at boot, and any future editor runs it before saving.
 *
 * Two failure modes, both silent without it:
 *
 * A typo'd placeholder survives into the prompt as a literal, which the model
 * reads as an instruction nobody wrote.
 *
 * A well-formed policy with absurd figures parses fine. A ₱9,999,999 credit
 * ceiling is valid JSON and valid types. OpsPilot's review Round 4 found
 * exactly that, which is why a pack's policy schema carries absolute caps and
 * this check runs the pack's parser rather than trusting the caller.
 *
 * The policy below is a test fixture, not Kidlat Fiber's real one.
 */

const MAX_CREDIT_CEILING_MINOR = 500_000; // ₱5,000

const fixturePolicySchema = z
  .object({
    credit: z
      .object({
        maxAutoApproveMinor: z.number().int().nonnegative(),
        maxCreditMinor: z.number().int().positive().max(MAX_CREDIT_CEILING_MINOR),
      })
      .strict()
      .refine((c) => c.maxAutoApproveMinor <= c.maxCreditMinor, {
        message: "maxAutoApproveMinor must not exceed maxCreditMinor",
      }),
    outage: z
      .object({ creditAfterHours: z.number().int().positive().max(168) })
      .strict(),
  })
  .strict();

type FixturePolicy = z.infer<typeof fixturePolicySchema>;

const DEFAULT: FixturePolicy = {
  credit: { maxAutoApproveMinor: 20_000, maxCreditMinor: 150_000 },
  outage: { creditAfterHours: 24 },
};

const PESO = { code: "PHP", locale: "en-PH" } as const;

const PACK = {
  parsePolicy: (raw: unknown) => fixturePolicySchema.parse(raw),
  renderers: {
    "credit.maxCredit": (p) => formatMoney(p.credit.maxCreditMinor, PESO),
    "outage.creditAfterHours": (p) => String(p.outage.creditAfterHours),
  } satisfies SopRenderers<FixturePolicy>,
};

const goodMarkdown =
  "Credit after {{outage.creditAfterHours}} hours, up to {{credit.maxCredit}}.";

function draft(policyConfig: unknown, bodyMarkdown = goodMarkdown) {
  return validateSopDraft({ bodyMarkdown, policyConfig }, PACK);
}

describe("validateSopDraft", () => {
  it("returns the parsed draft when markdown and policy are both sound", () => {
    const result = draft(DEFAULT);

    expect(result.policyConfig.outage.creditAfterHours).toBe(24);
    expect(result.bodyMarkdown).toBe(goodMarkdown);
  });

  it("returns the markdown unsubstituted, so the stored document keeps its placeholders", () => {
    expect(draft(DEFAULT).bodyMarkdown).toContain("{{credit.maxCredit}}");
  });

  it("accepts a changed figure within the caps", () => {
    const result = draft({ ...DEFAULT, outage: { creditAfterHours: 12 } });
    expect(result.policyConfig.outage.creditAfterHours).toBe(12);
  });

  /**
   * The compile is rehearsed here, at the door, not at request time. Deferring
   * it means a bad version is already live and every call fails, far from the
   * edit that caused it.
   */
  it("rejects an unknown placeholder", () => {
    expect(() => draft(DEFAULT, "after {{outage.creditAfterHour}} hours")).toThrow(
      UnknownPlaceholderError,
    );
  });

  it("rejects a ceiling above the pack's absolute cap", () => {
    expect(() =>
      draft({
        ...DEFAULT,
        credit: { maxAutoApproveMinor: 1_000, maxCreditMinor: MAX_CREDIT_CEILING_MINOR + 1 },
      }),
    ).toThrow(SopDraftError);
  });

  it("rejects an auto-approve limit above the ceiling", () => {
    expect(() =>
      draft({
        ...DEFAULT,
        credit: { maxAutoApproveMinor: 40_000, maxCreditMinor: 20_000 },
      }),
    ).toThrow(SopDraftError);
  });

  it("rejects a policy with a key the pack does not know", () => {
    expect(() => draft({ ...DEFAULT, refund: { windowDays: 30 } })).toThrow(SopDraftError);
  });

  it("rejects an empty document rather than activating a blank prompt", () => {
    expect(() => draft(DEFAULT, "   \n  ")).toThrow(SopDraftError);
  });

  it("carries a message naming what to fix", () => {
    expect(() => draft({ ...DEFAULT, outage: { creditAfterHours: 9_999 } })).toThrow(
      /creditAfterHours/,
    );
  });
});
