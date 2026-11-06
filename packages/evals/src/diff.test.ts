import { describe, expect, it } from "vitest";

import { diffEvalRuns } from "./diff";
import type { Assertion, CaseResultRow } from "./types";

/**
 * The regression diff is the part of the Eval Lab a reviewer reads under time
 * pressure, so what it must never do is lose a change. Two failure modes are
 * pinned here because both are silent:
 *
 * 1. A verdict that holds while the number underneath it moves — a call that
 *    went from 6 iterations to 4 but stayed under the `maxIterations` cap still
 *    passes, and a diff comparing only `passed` would call that case unchanged
 *    with nothing to show. It *is* unchanged, and the flip is still the interesting part.
 * 2. Object key order counting as a difference. `actual` comes back through
 *    `jsonb`, which does not preserve key order, so a naive `JSON.stringify`
 *    comparison reports a flip on every run and the real ones drown.
 */

function assertion(over: Partial<Assertion> = {}): Assertion {
  return {
    name: "action",
    expected: "credited",
    actual: "credited",
    passed: true,
    ...over,
  };
}

function row(over: Partial<CaseResultRow> = {}): CaseResultRow {
  return {
    slug: "outage-credit",
    title: "Outage credit for a Batasan Hills caller",
    passed: true,
    assertions: [assertion()],
    failureReason: null,
    costUsd: "0.001200",
    latencyMs: 4210,
    agentRunId: "5f0b3d1e-0000-4000-8000-000000000001",
    ...over,
  };
}

describe("diffEvalRuns", () => {
  it("calls a case that passed in base and fails in head regressed, and shows the actual that moved", () => {
    const before = row({
      passed: true,
      assertions: [
        assertion({ name: "action", expected: "credited", actual: "credited" }),
        assertion({
          name: "maxIterations",
          expected: 6,
          actual: 4,
          passed: true,
        }),
      ],
    });
    const after = row({
      passed: false,
      failureReason: "expected at most 6 iterations, got 9",
      assertions: [
        assertion({ name: "action", expected: "credited", actual: "credited" }),
        assertion({
          name: "maxIterations",
          expected: 6,
          actual: 9,
          passed: false,
          detail: "expected at most 6 iterations, got 9",
        }),
      ],
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.regressed).toHaveLength(1);
    expect(diff.fixed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);

    const entry = diff.regressed[0];
    expect(entry.slug).toBe("outage-credit");
    expect(entry.kind).toBe("regressed");
    expect(entry.before?.passed).toBe(true);
    expect(entry.after?.passed).toBe(false);
    expect(entry.flips).toHaveLength(1);
    expect(entry.flips[0].name).toBe("maxIterations");
    expect(entry.flips[0].before?.actual).toBe(4);
    expect(entry.flips[0].after?.actual).toBe(9);
    expect(entry.flips[0].after?.detail).toBe("expected at most 6 iterations, got 9");
  });

  it("calls a case that failed in base and passes in head fixed", () => {
    const before = row({
      slug: "injection-attempt",
      title: "Spoken prompt injection",
      passed: false,
      failureReason: "Expected zero side-effect tools, got apply_bill_credit",
      assertions: [
        assertion({
          name: "toolsNever",
          expected: [],
          actual: ["apply_bill_credit"],
          passed: false,
        }),
      ],
    });
    const after = row({
      slug: "injection-attempt",
      title: "Spoken prompt injection",
      passed: true,
      assertions: [
        assertion({
          name: "toolsNever",
          expected: [],
          actual: [],
          passed: true,
        }),
      ],
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.regressed).toEqual([]);
    expect(diff.fixed).toHaveLength(1);
    expect(diff.fixed[0].kind).toBe("fixed");
    expect(diff.fixed[0].slug).toBe("injection-attempt");
    expect(diff.fixed[0].flips).toHaveLength(1);
    expect(diff.fixed[0].flips[0].before?.passed).toBe(false);
    expect(diff.fixed[0].flips[0].after?.passed).toBe(true);
  });

  it("keeps a case unchanged when the verdict holds, and still reports the actual that moved", () => {
    const before = row({
      assertions: [
        assertion({
          name: "maxIterations",
          expected: 6,
          actual: 6,
          passed: true,
        }),
      ],
    });
    const after = row({
      assertions: [
        assertion({
          name: "maxIterations",
          expected: 6,
          actual: 4,
          passed: true,
        }),
      ],
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.regressed).toEqual([]);
    expect(diff.fixed).toEqual([]);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0].kind).toBe("unchanged");
    expect(diff.unchanged[0].flips).toHaveLength(1);
    expect(diff.unchanged[0].flips[0].name).toBe("maxIterations");
    expect(diff.unchanged[0].flips[0].before?.actual).toBe(6);
    expect(diff.unchanged[0].flips[0].after?.actual).toBe(4);
  });

  it("puts a head-only case in added and a base-only case in removed, with no flips", () => {
    const kept = row({ slug: "duplicate-charge", title: "Duplicate charge" });
    const gone = row({
      slug: "churn-risk",
      title: "Angry customer, churn risk",
    });
    const fresh = row({
      slug: "plan-downgrade",
      title: "Downgrade to the starter plan",
    });

    const diff = diffEvalRuns([kept, gone], [kept, fresh]);

    expect(diff.unchanged).toHaveLength(1);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].slug).toBe("plan-downgrade");
    expect(diff.added[0].kind).toBe("added");
    expect(diff.added[0].title).toBe("Downgrade to the starter plan");
    expect(diff.added[0].before).toBeNull();
    expect(diff.added[0].after?.slug).toBe("plan-downgrade");
    expect(diff.added[0].flips).toEqual([]);

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].slug).toBe("churn-risk");
    expect(diff.removed[0].kind).toBe("removed");
    expect(diff.removed[0].title).toBe("Angry customer, churn risk");
    expect(diff.removed[0].before?.slug).toBe("churn-risk");
    expect(diff.removed[0].after).toBeNull();
    expect(diff.removed[0].flips).toEqual([]);
  });

  it("takes the title from head when a case was renamed", () => {
    const before = row({ slug: "kb-how-to", title: "KB how-to" });
    const after = row({
      slug: "kb-how-to",
      title: "KB how-to, API keys",
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.unchanged[0].title).toBe("KB how-to, API keys");
  });

  it("does not call a difference in object key order a flip", () => {
    const before = row({
      assertions: [
        assertion({
          name: "outcome",
          expected: { action: "credited", creditMinor: 4900 },
          actual: { action: "credited", creditMinor: 4900 },
          passed: true,
        }),
      ],
    });
    const after = row({
      assertions: [
        assertion({
          name: "outcome",
          expected: { creditMinor: 4900, action: "credited" },
          actual: { creditMinor: 4900, action: "credited" },
          passed: true,
        }),
      ],
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0].flips).toEqual([]);
  });

  it("treats a reordered array inside `actual` as a real change", () => {
    const before = row({
      assertions: [
        assertion({
          name: "toolsCalled",
          expected: ["get_billing_history", "apply_bill_credit"],
          actual: ["get_billing_history", "apply_bill_credit"],
          passed: true,
        }),
      ],
    });
    const after = row({
      assertions: [
        assertion({
          name: "toolsCalled",
          expected: ["get_billing_history", "apply_bill_credit"],
          actual: ["apply_bill_credit", "get_billing_history"],
          passed: true,
        }),
      ],
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.unchanged[0].flips).toHaveLength(1);
    expect(diff.unchanged[0].flips[0].name).toBe("toolsCalled");
  });

  it("reports an assertion present on one side only as a flip, base order first", () => {
    const before = row({
      assertions: [
        assertion({ name: "status", expected: "resolved", actual: "resolved" }),
        assertion({
          name: "pausesFor",
          expected: "apply_bill_credit",
          actual: "apply_bill_credit",
          passed: true,
        }),
        assertion({
          name: "replyMentions",
          expected: "credit",
          actual: "credit",
          passed: true,
        }),
      ],
    });
    const after = row({
      assertions: [
        assertion({ name: "status", expected: "resolved", actual: "resolved" }),
        assertion({
          name: "replyMentions",
          expected: "credit",
          actual: "credit",
          passed: true,
        }),
        assertion({
          name: "guardrailOn",
          expected: "budget",
          actual: "budget",
          passed: true,
        }),
      ],
    });

    const diff = diffEvalRuns([before], [after]);

    expect(diff.unchanged).toHaveLength(1);

    const flips = diff.unchanged[0].flips;
    expect(flips).toHaveLength(2);
    // Base assertion order leads: `pausesFor` is second in base and absent from
    // head. `guardrailOn` is head-only and follows.
    expect(flips[0].name).toBe("pausesFor");
    expect(flips[0].before?.expected).toBe("apply_bill_credit");
    expect(flips[0].after).toBeNull();
    expect(flips[1].name).toBe("guardrailOn");
    expect(flips[1].before).toBeNull();
    expect(flips[1].after?.expected).toBe("budget");
  });

  it("orders each bucket by slug, ascending, without reordering the caller's arrays", () => {
    const base = [
      row({ slug: "zeta-credit", passed: true }),
      row({ slug: "alpha-credit", passed: true }),
      row({ slug: "mid-credit", passed: true }),
    ];
    const head = [
      row({ slug: "zeta-credit", passed: false }),
      row({ slug: "alpha-credit", passed: false }),
      row({ slug: "mid-credit", passed: false }),
    ];

    const diff = diffEvalRuns(base, head);

    expect(diff.regressed.map((c) => c.slug)).toEqual([
      "alpha-credit",
      "mid-credit",
      "zeta-credit",
    ]);
    expect(base.map((r) => r.slug)).toEqual([
      "zeta-credit",
      "alpha-credit",
      "mid-credit",
    ]);
    expect(head.map((r) => r.slug)).toEqual([
      "zeta-credit",
      "alpha-credit",
      "mid-credit",
    ]);
  });

  it("returns five empty buckets for two empty runs", () => {
    expect(diffEvalRuns([], [])).toEqual({
      regressed: [],
      fixed: [],
      unchanged: [],
      added: [],
      removed: [],
    });
  });
});
