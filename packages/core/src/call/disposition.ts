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
 * The enums grow with the tickets: `escalated` arrives with escalation (#14).
 */
import { z } from "zod";

export const DISPOSITION_OUTCOMES = ["resolved", "unresolved"] as const;

export const DISPOSITION_TOPICS = [
  "outage",
  "slow_internet",
  "billing",
  "payment",
  "plan_change",
  "account_access",
  "other",
] as const;

/**
 * True when the text holds a run of 10 or more digits once the spaces, dots,
 * hyphens and plus signs between digits are removed: a 10-digit account number
 * or a PH mobile in any common spacing. Short numbers and the outage reference
 * format ("OUT-2026-0412", 8 digits joined) pass.
 *
 * This only keeps numbers out of the disposition. Masking of everything that
 * is stored is #10 and #18.
 */
function hasAccountOrPhoneNumber(text: string): boolean {
  return /\d{10,}/.test(text.replace(/(?<=\d)[ .+-]+(?=\d)/g, ""));
}

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
        error: "summary must not contain an account or phone number",
      })
      .describe(
        "One or two plain English sentences for the supervisor: what the " +
          "caller needed and what happened. No account or phone numbers.",
      ),
  })
  .strict();

export type Disposition = z.infer<typeof dispositionSchema>;
