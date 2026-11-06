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
 * Later tickets add bill credits and currency (#13).
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

export const supportPolicySchema = z
  .object({
    identity: z
      .object({
        maxFailedAttempts: z.number().int().min(1).max(MAX_FAILED_ATTEMPTS_CEILING),
      })
      .strict(),
  })
  .strict();

export type SupportPolicy = z.infer<typeof supportPolicySchema>;

/** Parses untrusted input into a policy, or throws the ZodError, whose message names the path. */
export function parseSupportPolicy(raw: unknown): SupportPolicy {
  return supportPolicySchema.parse(raw);
}

/**
 * The placeholders an SOP may use, each rendered from the same policy the
 * handlers enforce, so the prose and the limit cannot drift apart.
 */
export const SUPPORT_POLICY_RENDERERS: SopRenderers<SupportPolicy> = {
  maxFailedVerificationAttempts: (policy) => String(policy.identity.maxFailedAttempts),
};
