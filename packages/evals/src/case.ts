/**
 * What an eval case may *expect*, as a schema rather than a convention.
 *
 * Imported from OpsPilot, where a case was a support ticket plus these
 * expectations. The ticket half is gone: a Tala case is a simulated caller,
 * and its shape, along with the voice checks (no account data before
 * `verify_identity` succeeded, the `end_call` disposition), is #9. Beacon's
 * two money expectations (a refund amount, and the amount a paused refund
 * carried) are gone too; Tala's credit amounts arrive with #13.
 *
 * **The expectations object is closed.** Zod strips unknown keys by default,
 * which for this shape would turn `toolsCaled: ["apply_bill_credit"]` into a
 * case that asserts nothing and reports green forever — the worst possible
 * failure for a regression suite, because it is invisible in exactly the
 * situation it exists to catch. `.strict()` makes a typo a parse error instead.
 */
import { z } from "zod";

import type { AgentLoopStatus } from "@tala/core";

/**
 * Mirrors `AgentLoopStatus`. The `satisfies` below is what keeps the two in
 * step: adding a status to the loop without adding it here fails `tsc`, rather
 * than failing a case months later with "expected paused_for_approval".
 */
export const AGENT_LOOP_STATUSES = [
  "completed",
  "paused_for_approval",
  "refused",
  "failed",
  "budget_refused",
] as const satisfies readonly AgentLoopStatus[];

/**
 * Every deterministic check a case can make. All optional — a case names the
 * ones that matter to it — but a case naming *none* should be caught by the
 * suite's own test, because an empty expectations object is a legal
 * intermediate state while a case is being written.
 *
 * Two of these read the terminal tool's output, which only exists on a
 * completed run (`action`, `replyMentions`), and one only exists on a paused
 * one (`pausesFor`). The scorer reports the mismatch rather than throwing, so
 * a case that expects the wrong terminal state fails with a sentence saying so.
 */
export const expectationsSchema = z
  .object({
    /** The loop's terminal status. */
    status: z.enum(AGENT_LOOP_STATUSES).optional(),
    /** The terminal tool's `action` field. Completed runs only. */
    action: z.string().optional(),
    /** The run stopped for human approval on this tool. */
    pausesFor: z.object({ tool: z.string() }).strict().optional(),
    /** Each name must appear as a non-error `tool_exec` span. */
    toolsCalled: z.array(z.string()).optional(),
    /** No name may appear as *any* `tool_exec` span, error or not. */
    toolsNever: z.array(z.string()).optional(),
    /**
     * A `guardrail` span with this name fired. The name is the guardrail's own
     * — `injection_scan` — not a tool's: what it asserts is that a control ran,
     * which is not the same claim as `toolsNever` and is not one the model can
     * satisfy by being agreeable.
     */
    guardrailOn: z.array(z.string()).optional(),
    /** Case-insensitive substrings of the terminal tool's `reply` field. */
    replyMentions: z.array(z.string()).optional(),
    /** Loop iterations used, at most. */
    maxIterations: z.number().int().positive().optional(),
  })
  .strict();

export type Expectations = z.infer<typeof expectationsSchema>;

/** Exported so a suite's own test can tell an expectation from a comment. */
export const EXPECTATION_KEYS = Object.keys(
  expectationsSchema.shape,
) as ReadonlyArray<keyof Expectations>;
