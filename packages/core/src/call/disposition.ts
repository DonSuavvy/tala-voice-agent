/**
 * How a call ended, in Tala's own words: the `end_call` tool's input.
 *
 * `end_call` is the required final tool, so every finished call carries one of
 * these. The after-call work (#18) and the eval checks (#9) read it, which is
 * why it is a closed schema rather than free text.
 *
 * Only what the model is the right source for lives here: what the call was
 * about, whether it was resolved, and a summary. Facts the code already knows,
 * such as which account was verified and which SOP version ran, come from the
 * call session, never from the model's say-so.
 *
 * The enums grow with the tickets: `help`, a general how-to question answered
 * from the help articles, came with #16; `escalated` arrives with escalation
 * (#14).
 */
import { z } from "zod";

import { hasAccountOrPhoneNumber } from "../policy/masking";

export const DISPOSITION_OUTCOMES = ["resolved", "unresolved"] as const;

export const DISPOSITION_TOPICS = [
  "outage",
  "slow_internet",
  "billing",
  "payment",
  "plan_change",
  "account_access",
  "help",
  "other",
] as const;

export const dispositionSchema = z
  .object({
    outcome: z
      .enum(DISPOSITION_OUTCOMES)
      .describe(
        "resolved: the caller's concern was answered or handled on this call. " +
          "unresolved: it was not, for any reason.",
      ),
    topic: z
      .enum(DISPOSITION_TOPICS)
      .describe("What the call was mainly about."),
    summary: z
      .string()
      .min(10)
      .max(400)
      .refine((summary) => !hasAccountOrPhoneNumber(summary), {
        // The one definition of an account or phone number is in masking.ts.
        error: "summary must not contain an account or phone number",
      })
      .describe(
        "One or two plain English sentences for the supervisor: what the " +
          "caller needed and what happened. No account or phone numbers.",
      ),
  })
  .strict();

export type Disposition = z.infer<typeof dispositionSchema>;
