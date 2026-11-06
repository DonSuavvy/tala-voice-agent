/**
 * What an eval case may *expect*, as a schema rather than a convention.
 *
 * Imported from OpsPilot, where a case was a support ticket plus these
 * expectations and the scorer read one agent-loop result. A Tala case is a
 * simulated caller and the scorer reads a whole call, so the vocabulary is the
 * call's (DESIGN section 11): how the call ended, tools called and never
 * called, guardrails fired, the disposition, what Tala said, and the voice
 * checks. Beacon's loop-scoped keys are gone: `status` (a call's turns all end
 * `awaiting_caller` but the last, so the call's end is `endedBy`), `action` and
 * `replyMentions` (fields of OpsPilot's terminal tool, which a call does not
 * have: it has a disposition and speech), and `maxIterations` (per loop run, so
 * per caller turn; `maxModelCalls` counts across the call).
 *
 * **The expectations object is closed.** Zod strips unknown keys by default,
 * which for this shape would turn `toolsCaled: ["apply_bill_credit"]` into a
 * case that asserts nothing and reports green forever: the worst possible
 * failure for a regression suite, because it is invisible in exactly the
 * situation it exists to catch. `.strict()` makes a typo a parse error instead,
 * and so does a case still written with a removed key.
 *
 * The same reasoning closes the values that would assert nothing: an empty
 * phrase (every text contains it), an empty tool name (no tool has it, so
 * `toolsNever: [""]` always passes) and a voice check set to `false`.
 */
import { z } from "zod";

import { DISPOSITION_OUTCOMES, DISPOSITION_TOPICS, type CallEndReason } from "@tala/core";

/**
 * Every way a call session can end, as an enum-like object. The annotation is
 * the guard, in both directions: a reason core adds and this object lacks is a
 * missing property, and one core drops is an excess property, so either fails
 * `tsc`. A list with `satisfies CallEndReason[]` would only prove that each
 * listed reason exists (Tala FAILURES entry 6). Core does not export its
 * reasons as a value, and this ticket does not change core.
 */
const CALL_END_REASONS: { readonly [R in CallEndReason]: R } = {
  end_call: "end_call",
  refused: "refused",
  failed: "failed",
  budget_refused: "budget_refused",
};

/**
 * How a case's call ended: the session's own reason, or `not_ended` when the
 * simulated caller ran out of turns before Tala's `end_call`.
 */
export const ENDED_BY = { ...CALL_END_REASONS, not_ended: "not_ended" } as const;

export type EndedBy = CallEndReason | "not_ended";

const name = z.string().min(1);

/**
 * Every deterministic check a case can make. All optional: a case names the
 * ones that matter to it. The scorer runs them in this declared order.
 */
export const expectationsSchema = z
  .object({
    /** How the call ended. */
    endedBy: z.enum(ENDED_BY).optional(),
    /** Fields of end_call's disposition. Values are end_call's own enums. */
    disposition: z
      .object({
        outcome: z.enum(DISPOSITION_OUTCOMES).optional(),
        topic: z.enum(DISPOSITION_TOPICS).optional(),
      })
      .strict()
      .optional(),
    /** The call waited for human approval on this tool (in-call approvals, #13). */
    pausesFor: z.object({ tool: name }).strict().optional(),
    /** Each name must appear as a non-error `tool_exec` span. */
    toolsCalled: z.array(name).optional(),
    /** No name may appear as *any* `tool_exec` span, error or not. */
    toolsNever: z.array(name).optional(),
    /**
     * A `guardrail` span with this name fired. The name is the guardrail's own
     * (`injection_scan`), not a tool's: what it asserts is that a control ran,
     * which is not the same claim as `toolsNever` and is not one the model can
     * satisfy by being agreeable.
     */
    guardrailOn: z.array(name).optional(),
    /** Case-insensitive substrings of what Tala said, in any of her lines. */
    saidMentions: z.array(name).optional(),
    /** Nothing from any account in the seed world was said before verification succeeded. */
    noAccountDataBeforeVerification: z.literal(true).optional(),
    /** Every model turn that called a tool also said something to the caller. */
    speaksBeforeEveryToolCall: z.literal(true).optional(),
    /** Model calls across the whole call, at most. */
    maxModelCalls: z.number().int().positive().optional(),
  })
  .strict();

export type Expectations = z.infer<typeof expectationsSchema>;

/** Exported so a suite's own test can tell an expectation from a comment. */
export const EXPECTATION_KEYS = Object.keys(
  expectationsSchema.shape,
) as ReadonlyArray<keyof Expectations>;
