/**
 * What flagged input costs the agent, decided before the model is called.
 *
 * `scanForInjection` names what it saw. This is the layer that acts on it, and
 * it is deliberately the only one in the injection story that does not depend
 * on the model agreeing with it: a flagged turn is handed a registry with no
 * confirm-write tool in it, so a credit is not merely discouraged, it is
 * absent. An attacker who says the perfect sentence still cannot call a tool
 * the model was never given.
 *
 * Imported from OpsPilot, where it guarded a support ticket. Tala guards what
 * a caller says (#15); the wording of the notice the model reads after a
 * flagged turn belongs to that ticket and the company pack, not here.
 *
 * Two properties are load-bearing and each has a test:
 *
 * 1. **Pure.** No database, no clock, no model. `now` is injected like
 *    everywhere else in this codebase, so the span it stamps is reproducible
 *    and the eval suite can assert on it.
 * 2. **The system prompt is not an input or an output.** The SOP is the
 *    cacheable prefix, and a prefix that differs between a flagged turn and a
 *    clean one is not a prefix. Anything the caller adds goes in a user turn.
 *
 * The narrowing is not a substitute for anything downstream. Limits are still
 * revalidated in the handler, confirm-write still pauses for a human on an
 * unflagged turn, and the SOP still says the caller's words are data.
 */
import type { SpanEvent } from "./loop";
import { scanForInjection } from "./injection";
import { buildRegistry, type ToolContext, type ToolRegistry } from "./registry";

/** The one span this emits. Named so `guardrailOn` in an eval case can pin it. */
export const INJECTION_SCAN_SPAN = "injection_scan";

export interface GuardInputArgs<C extends ToolContext> {
  registry: ToolRegistry<C>;
  /** The untrusted text: what the caller said, or any other model-visible input. */
  text: string;
  /** Injected, never read from the wall clock. Stamps the span. */
  now: Date;
}

export interface GuardedInput<C extends ToolContext> {
  flagged: boolean;
  /** The scan's signals, in its fixed order. Empty on clean input. */
  signals: string[];
  /** The original registry when clean; a confirm-write-free one when flagged. */
  registry: ToolRegistry<C>;
  /** The tool names withheld. Empty when clean. */
  restrictedTools: string[];
  /** Null unless flagged. Seq 0; the caller renumbers if it has spans already. */
  guardrailSpan: SpanEvent | null;
}

/**
 * Scan untrusted text and decide what the turn it opens is allowed to do.
 *
 * Every path that hands caller text to the model must go through here, and a
 * resumed turn must re-derive its registry from the same text rather than
 * trusting a serialized conversation to remember it: that carries the
 * messages, not the tools. A control that only one call site applies is a
 * control a demo can pass and production can miss.
 */
export function guardInput<C extends ToolContext>({
  registry,
  text,
  now,
}: GuardInputArgs<C>): GuardedInput<C> {
  const { flagged, signals } = scanForInjection(text);

  if (!flagged) {
    return {
      flagged: false,
      signals,
      registry,
      restrictedTools: [],
      guardrailSpan: null,
    };
  }

  const definitions = registry.list();
  const restrictedTools = definitions
    .filter((d) => d.safetyClass === "confirm_write")
    .map((d) => d.name);

  // Rebuilt rather than filtered in place, so the narrowed set goes through
  // the same boot validation as the full one — including "exactly one terminal
  // tool", which is what stops a future confirm-write terminal from producing
  // a registry that can never end a run.
  const narrowed = buildRegistry(
    definitions.filter((d) => d.safetyClass !== "confirm_write"),
  );

  return {
    flagged: true,
    signals,
    registry: narrowed,
    restrictedTools,
    guardrailSpan: {
      seq: 0,
      type: "guardrail",
      name: INJECTION_SCAN_SPAN,
      input: { signals },
      output: { flagged: true, restrictedTools },
      isError: false,
      usage: null,
      costNanos: 0,
      estimated: false,
      // The scan is deterministic string matching on text already in memory.
      // Reporting a measured duration here would be reporting scheduler noise,
      // and it would make the span unassertable in an eval.
      latencyMs: 0,
      startedAt: now,
      endedAt: now,
    },
  };
}
