/**
 * The support policy: the figures a company pack sets, the SOP states and the
 * tool handlers enforce.
 *
 * It follows the policy-engine pattern from ADR 0001. Every decision parses
 * the raw config here instead of trusting a TypeScript type, so a malformed
 * policy throws rather than failing open. The schema carries absolute caps,
 * because a well-formed policy can still be harmful. And `.strict()` at every
 * level makes a typo in a pack's policy a boot error instead of a limit that
 * is silently ignored.
 *
 * #16 adds the plan-change rules: when an upgrade and a downgrade take effect.
 * Later tickets add bill credits (#13). The currency money is spoken in is
 * the company's, not the policy's: `company.currency` in the pack (#10).
 */
import { z } from "zod";

import type { SopRenderers } from "../agent/sop";

/**
 * The absolute ceiling on failed identity checks per call. The secret is the
 * last 4 digits of the registered mobile, 10,000 values, so 5 tries guess it
 * 0.05% of the time. A well-formed policy with 50 would make the check
 * theatre: OpsPilot's well-formed policy authorised $999,999.99 (its
 * FAILURES #15), which is why the cap is in the schema, not in review.
 */
const MAX_FAILED_ATTEMPTS_CEILING = 5;

/**
 * When a plan change takes effect: `now`, when the caller agrees, or
 * `next_cycle`, when the account's next billing cycle starts.
 */
export const PLAN_CHANGE_TIMINGS = ["now", "next_cycle"] as const;
export type PlanChangeTiming = (typeof PLAN_CHANGE_TIMINGS)[number];

export const supportPolicySchema = z
  .object({
    identity: z
      .object({
        maxFailedAttempts: z.number().int().min(1).max(MAX_FAILED_ATTEMPTS_CEILING),
      })
      .strict(),
    /** When a change to a plan that costs more (upgrade) or no more (downgrade) takes effect. */
    planChanges: z
      .object({
        upgrade: z.enum(PLAN_CHANGE_TIMINGS),
        downgrade: z.enum(PLAN_CHANGE_TIMINGS),
      })
      .strict(),
  })
  .strict();

export type SupportPolicy = z.infer<typeof supportPolicySchema>;

/** Parses untrusted input into a policy, or throws the ZodError, whose message names the path. */
export function parseSupportPolicy(raw: unknown): SupportPolicy {
  return supportPolicySchema.parse(raw);
}

/** A timing as the SOP states it, after "takes effect". */
const TIMING_IN_WORDS: Readonly<Record<PlanChangeTiming, string>> = {
  now: "at once",
  next_cycle: "when the next billing cycle starts",
};

/**
 * The placeholders an SOP may use, each rendered from the same policy the
 * handlers enforce, so the prose and the limit cannot drift apart.
 */
export const SUPPORT_POLICY_RENDERERS: SopRenderers<SupportPolicy> = {
  maxFailedVerificationAttempts: (policy) => String(policy.identity.maxFailedAttempts),
  upgradeTakesEffect: (policy) => TIMING_IN_WORDS[policy.planChanges.upgrade],
  downgradeTakesEffect: (policy) => TIMING_IN_WORDS[policy.planChanges.downgrade],
};
