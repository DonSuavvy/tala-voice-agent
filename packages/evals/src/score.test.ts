import { describe, expect, it } from "vitest";

import type { SpanEvent, SpanType } from "@tala/core";

import type { Expectations } from "./case";
import { score, type Observed } from "./score";

/**
 * The scorer is where "determinism lives in the scorers, not in sampling" is
 * actually cashed out — sampling parameters such as `temperature` are rejected
 * on the current API version, so this function is the only thing standing
 * between the suite and a flaky gate.
 *
 * Every expected value below is a literal. A test that recomputes the sentence
 * it is checking passes when the sentence is wrong, and the sentence is the
 * product here: `failure_reason` is what a reviewer reads in the diff view.
 */

const AT = new Date("2026-09-08T10:00:00.000Z");

function span(
  type: SpanType,
  name: string,
  over: Partial<SpanEvent> = {},
): SpanEvent {
  return {
    seq: 0,
    type,
    name,
    input: null,
    output: null,
    isError: false,
    usage: null,
    costNanos: 0,
    estimated: false,
    latencyMs: 1,
    startedAt: AT,
    endedAt: AT,
    ...over,
  };
}

function outcome(over: Record<string, unknown> = {}) {
  return {
    action: "answered",
    reply: "Your credit is on next month's bill.",
    confidence: "high",
    ...over,
  };
}

function observed(over: Partial<Observed> = {}): Observed {
  return {
    status: "completed",
    outcome: outcome(),
    pendingApproval: null,
    spans: [],
    iterations: 2,
    ...over,
  };
}

/** The paused shape: no outcome, an approval carrying the tool's own input. */
function paused(toolName: string, toolInput: unknown): Observed {
  return observed({
    status: "paused_for_approval",
    outcome: null,
    pendingApproval: { toolName, toolInput },
  });
}

function only(expectations: Expectations, o: Observed) {
  return score(expectations, o);
}

describe("score — the empty case", () => {
  it("passes with zero assertions when nothing is expected", () => {
    const result = score({}, observed());

    expect(result.passed).toBe(true);
    expect(result.assertions).toEqual([]);
    expect(result.failureReason).toBeNull();
  });
});

describe("score — status", () => {
  it("passes when the terminal status matches", () => {
    const result = only({ status: "completed" }, observed());

    expect(result.passed).toBe(true);
    expect(result.assertions).toEqual([
      {
        name: "status",
        expected: "completed",
        actual: "completed",
        passed: true,
      },
    ]);
  });

  it("fails with a sentence naming both statuses", () => {
    const result = only({ status: "paused_for_approval" }, observed());

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(
      'expected status "paused_for_approval", got "completed"',
    );
  });
});

describe("score — action", () => {
  it("passes when end_call reported the expected action", () => {
    const result = only(
      { action: "escalated" },
      observed({ outcome: outcome({ action: "escalated" }) }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions[0]).toEqual({
      name: "action",
      expected: "escalated",
      actual: "escalated",
      passed: true,
    });
  });

  it("fails when the action differs", () => {
    const result = only({ action: "escalated" }, observed());

    expect(result.failureReason).toBe(
      'expected action "escalated", got "answered"',
    );
  });


  /**
   * A completed run *should* always have an outcome — `end_call` is the
   * forced terminal tool. When it does not, that is the finding, and it must
   * read as one rather than as `undefined !== "escalated"`.
   */
  it("says so plainly when a completed run produced no outcome", () => {
    const result = only({ action: "escalated" }, observed({ outcome: null }));

    expect(result.passed).toBe(false);
    expect(result.assertions[0]).toEqual({
      name: "action",
      expected: "escalated",
      actual: null,
      passed: false,
      detail: 'expected action "escalated", but the run produced no outcome',
    });
    expect(result.failureReason).toBe(
      'expected action "escalated", but the run produced no outcome',
    );
  });
});

describe("score — pausesFor", () => {
  it("passes when the run paused on the right tool, with one assertion", () => {
    const result = only(
      { pausesFor: { tool: "apply_bill_credit" } },
      paused("apply_bill_credit", { amount_minor: 4_900 }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions.map((a) => a.name)).toEqual(["pausesFor.tool"]);
  });

  it("fails when the run never paused", () => {
    const result = only(
      { pausesFor: { tool: "apply_bill_credit" } },
      observed(),
    );

    expect(result.failureReason).toBe(
      'expected a pause on "apply_bill_credit", but the run never paused',
    );
  });

  it("fails when it paused on a different tool", () => {
    const result = only(
      { pausesFor: { tool: "apply_bill_credit" } },
      paused("change_plan", { new_plan: "fiber-300" }),
    );

    expect(result.failureReason).toBe(
      'expected a pause on "apply_bill_credit", got a pause on "change_plan"',
    );
  });
});

describe("score — toolsCalled", () => {
  it("passes on a successful tool_exec span, one assertion per name", () => {
    const result = only(
      { toolsCalled: ["get_billing_history", "search_knowledge_base"] },
      observed({
        spans: [
          span("tool_exec", "get_billing_history"),
          span("tool_exec", "search_knowledge_base"),
        ],
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions.map((a) => a.name)).toEqual([
      "toolsCalled:get_billing_history",
      "toolsCalled:search_knowledge_base",
    ]);
  });

  it("fails when the tool never ran", () => {
    const result = only({ toolsCalled: ["search_knowledge_base"] }, observed());

    expect(result.failureReason).toBe(
      'expected "search_knowledge_base" to run, but it never did',
    );
  });

  /** An errored call is not a call the case can rely on having happened. */
  it("fails when every call to the tool errored", () => {
    const result = only(
      { toolsCalled: ["search_knowledge_base"] },
      observed({ spans: [span("tool_exec", "search_knowledge_base", { isError: true })] }),
    );

    expect(result.failureReason).toBe(
      'expected "search_knowledge_base" to run, but every call to it failed',
    );
  });

  it("ignores spans of other types with the same name", () => {
    const result = only(
      { toolsCalled: ["apply_bill_credit"] },
      observed({ spans: [span("approval_wait", "apply_bill_credit")] }),
    );

    expect(result.passed).toBe(false);
  });
});

describe("score — toolsNever", () => {
  it("passes when the tool is absent from the trace", () => {
    const result = only(
      { toolsNever: ["apply_bill_credit"] },
      observed({ spans: [span("tool_exec", "search_knowledge_base")] }),
    );

    expect(result.passed).toBe(true);
  });

  /**
   * The security-relevant half. A credit that fired and *then* failed still
   * fired — the handler ran, the audit row exists — so an error span counts as
   * a hit. Treating `isError` as "did not happen" is how a case that exists to
   * prove zero side effects reports green on a side effect.
   */
  it("counts an errored call as a call", () => {
    const result = only(
      { toolsNever: ["apply_bill_credit"] },
      observed({ spans: [span("tool_exec", "apply_bill_credit", { isError: true })] }),
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe(
      'expected "apply_bill_credit" never to run, but it did',
    );
  });

  it("does not count a guardrail that blocked the call before dispatch", () => {
    const result = only(
      { toolsNever: ["apply_bill_credit"] },
      observed({ spans: [span("guardrail", "apply_bill_credit", { isError: true })] }),
    );

    expect(result.passed).toBe(true);
  });
});

describe("score — guardrailOn", () => {
  it("passes when a guardrail span exists for the tool", () => {
    const result = only(
      { guardrailOn: ["apply_bill_credit"] },
      observed({ spans: [span("guardrail", "apply_bill_credit", { isError: true })] }),
    );

    expect(result.passed).toBe(true);
    expect(result.assertions[0].name).toBe("guardrailOn:apply_bill_credit");
  });

  it("fails when none fired", () => {
    const result = only(
      { guardrailOn: ["apply_bill_credit"] },
      observed({ spans: [span("tool_exec", "apply_bill_credit")] }),
    );

    expect(result.failureReason).toBe(
      'expected a guardrail to block "apply_bill_credit", but none fired',
    );
  });
});

describe("score — replyMentions", () => {
  it("matches case-insensitively", () => {
    const result = only(
      { replyMentions: ["NEXT MONTH'S BILL"] },
      observed(),
    );

    expect(result.passed).toBe(true);
  });

  it("fails when the phrase is absent", () => {
    const result = only({ replyMentions: ["24 hours"] }, observed());

    expect(result.failureReason).toBe(
      'expected the reply to mention "24 hours", but it did not',
    );
  });

  it("reports a missing outcome rather than an empty reply", () => {
    const result = only(
      { replyMentions: ["24 hours"] },
      observed({ outcome: null }),
    );

    expect(result.failureReason).toBe(
      'expected the reply to mention "24 hours", but the run produced no outcome',
    );
  });
});

describe("score — maxIterations", () => {
  it("passes at the cap", () => {
    const result = only({ maxIterations: 2 }, observed({ iterations: 2 }));

    expect(result.passed).toBe(true);
  });

  it("fails above it", () => {
    const result = only({ maxIterations: 2 }, observed({ iterations: 5 }));

    expect(result.failureReason).toBe("expected at most 2 iterations, got 5");
  });
});

describe("score — ordering", () => {
  /**
   * `failureReason` is "the first failing assertion", so the order has to be
   * fixed rather than incidental — otherwise the same failing run produces a
   * different headline sentence on different days and the diff view shows a
   * flip that never happened.
   */
  it("reports the first failure in declared key order, not input order", () => {
    const result = score(
      {
        maxIterations: 1,
        toolsNever: ["apply_bill_credit"],
        status: "paused_for_approval",
      },
      observed({ spans: [span("tool_exec", "apply_bill_credit")] }),
    );

    expect(result.assertions.map((a) => a.name)).toEqual([
      "status",
      "toolsNever:apply_bill_credit",
      "maxIterations",
    ]);
    expect(result.failureReason).toBe(
      'expected status "paused_for_approval", got "completed"',
    );
  });
});
