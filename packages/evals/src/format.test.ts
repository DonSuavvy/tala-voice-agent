import { describe, expect, expectTypeOf, it } from "vitest";

import type { CallEvent, CallPin, SpanEvent } from "@tala/core";

import {
  formatCaseResult,
  formatCost,
  formatDiff,
  formatEvent,
  parseReport,
  type DiffableReport,
} from "./format";
import type { CaseReportRow, CostLine, ReportPin } from "./report";
import type { Assertion, CaseResultRow } from "./types";

/**
 * What the runner prints and what `eval:diff` prints. Pure functions of a
 * report, so every line is pinned here as a literal.
 */

const line = (nanos: number, usd: string, estimated = false): CostLine => ({ nanos, usd, estimated });

const COST = {
  tala: line(4_000_000, "0.004000"),
  caller: line(750_000, "0.000750"),
  grader: line(200_000, "0.000200"),
  total: line(4_950_000, "0.004950"),
};

function reportRow(over: Partial<CaseReportRow> = {}): CaseReportRow {
  return {
    slug: "scenario-1-outage",
    title: "Batasan Hills outage",
    passed: true,
    assertions: [],
    failureReason: null,
    costUsd: "0.004950",
    latencyMs: 4_200,
    agentRunId: "call_1",
    cost: COST,
    caller: { stoppedBy: "call_ended", turns: 3, error: null },
    advisory: {
      grade: { tone: 4, taglish: 5, politeness: 5, notes: "Warm and brief." },
      reason: null,
    },
    transcript: [],
    ...over,
  };
}

describe("formatCaseResult", () => {
  it("prints the gate result first, then the advisory grade beside it", () => {
    expect(formatCaseResult(reportRow())).toBe(
      "PASS  scenario-1-outage: Batasan Hills outage ($0.004950)\n" +
        "      advisory grade: tone 4, taglish 5, politeness 5. Warm and brief.",
    );
  });

  it("prints why a case failed, and why there is no grade", () => {
    expect(
      formatCaseResult(
        reportRow({
          passed: false,
          failureReason: 'expected the call to end with "end_call", got "not_ended"',
          advisory: { grade: null, reason: "the grader's model refused" },
        }),
      ),
    ).toBe(
      "FAIL  scenario-1-outage: Batasan Hills outage ($0.004950)\n" +
        '      expected the call to end with "end_call", got "not_ended"\n' +
        "      advisory grade: none (the grader's model refused)",
    );
  });
});

describe("formatCost", () => {
  it("prints the run's actual cost, split three ways", () => {
    expect(formatCost(COST)).toBe(
      "cost: $0.004950 (Tala $0.004000, caller $0.000750, grader $0.000200)",
    );
  });

  it("says when the cost includes estimates", () => {
    expect(
      formatCost({ ...COST, tala: line(4_000_000, "0.004000", true), total: line(4_950_000, "0.004950", true) }),
    ).toBe(
      "cost: $0.004950 (Tala $0.004000, caller $0.000750, grader $0.000200), includes estimates",
    );
  });
});

/* -------------------------------------------------------------------------- */

function assertion(name: string, passed: boolean, actual: unknown, detail?: string): Assertion {
  return { name, expected: null, actual, passed, ...(detail ? { detail } : {}) };
}

function resultRow(slug: string, passed: boolean, assertions: Assertion[]): CaseResultRow {
  return {
    slug,
    title: `Case ${slug}`,
    passed,
    assertions,
    failureReason: passed ? null : (assertions.find((a) => !a.passed)?.detail ?? null),
    costUsd: "0.001000",
    latencyMs: 1,
    agentRunId: null,
  };
}

const PIN = {
  packId: "kidlat-fiber",
  sopVersion: "v1",
  promptVersion: "1a2b3c4d5e6f",
  policyVersion: "0f9e8d7c6b5a",
  model: "sonnet",
  modelId: "model-id-for-sonnet",
  gitSha: "3913f4a0000000000000000000000000000000ab",
  gitDirty: false,
};

const BEFORE: DiffableReport = {
  ranAt: "2026-11-06T08:30:05.123Z",
  pin: PIN,
  cases: [
    resultRow("a-regresses", true, [assertion("toolsCalled:check_area_outage", true, 1)]),
    resultRow("b-fixed", false, [
      assertion("endedBy", false, "not_ended", 'expected the call to end with "end_call", got "not_ended"'),
    ]),
    resultRow("c-same", true, [assertion("maxModelCalls", true, 4)]),
    resultRow("d-removed", true, []),
  ],
};

const AFTER: DiffableReport = {
  ranAt: "2026-11-06T09:00:00.000Z",
  pin: { ...PIN, promptVersion: "aaaaaaaaaaaa", gitSha: "51fd0e1000000000000000000000000000000000" },
  cases: [
    resultRow("a-regresses", false, [
      assertion(
        "toolsCalled:check_area_outage",
        false,
        0,
        'expected "check_area_outage" to run, but it never did',
      ),
      assertion("speaksBeforeEveryToolCall", true, []),
    ]),
    resultRow("b-fixed", true, [assertion("endedBy", true, "end_call")]),
    resultRow("c-same", true, [assertion("maxModelCalls", true, 5)]),
    resultRow("e-added", false, [assertion("endedBy", false, "failed", "x")]),
  ],
};

describe("formatDiff", () => {
  it("prints both pins, what changed between them, and the five buckets", () => {
    expect(formatDiff(BEFORE, AFTER)).toBe(
      [
        "before: 2026-11-06T08:30:05.123Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt 1a2b3c4d5e6f  policy 0f9e8d7c6b5a  git 3913f4a",
        "after:  2026-11-06T09:00:00.000Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt aaaaaaaaaaaa  policy 0f9e8d7c6b5a  git 51fd0e1",
        "pin changes: prompt, git",
        "",
        "regressed (1)",
        "  a-regresses: Case a-regresses",
        '    toolsCalled:check_area_outage: passed -> failed (expected "check_area_outage" to run, but it never did)',
        "    + speaksBeforeEveryToolCall: passed",
        "fixed (1)",
        "  b-fixed: Case b-fixed",
        "    endedBy: failed -> passed",
        "added (1)",
        "  e-added: Case e-added (failed)",
        "removed (1)",
        "  d-removed: Case d-removed (passed)",
        "unchanged (1)",
        "  c-same: Case c-same (still passing)",
        "    maxModelCalls: still passed, actual 4 -> 5",
      ].join("\n"),
    );
  });

  it("says when the pins are the same, and when a bucket is empty", () => {
    const same: DiffableReport = { ...BEFORE, ranAt: "2026-11-06T10:00:00.000Z" };

    expect(formatDiff(BEFORE, same)).toBe(
      [
        "before: 2026-11-06T08:30:05.123Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt 1a2b3c4d5e6f  policy 0f9e8d7c6b5a  git 3913f4a",
        "after:  2026-11-06T10:00:00.000Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt 1a2b3c4d5e6f  policy 0f9e8d7c6b5a  git 3913f4a",
        "pin changes: none",
        "",
        "regressed (0)",
        "fixed (0)",
        "added (0)",
        "removed (0)",
        "unchanged (4)",
        "  a-regresses: Case a-regresses (still passing)",
        "  b-fixed: Case b-fixed (still failing)",
        "  c-same: Case c-same (still passing)",
        "  d-removed: Case d-removed (still passing)",
      ].join("\n"),
    );
  });

  it("shows an assertion a case dropped, and an unknown git commit", () => {
    const before: DiffableReport = {
      ...BEFORE,
      pin: { ...PIN, gitSha: null },
      cases: [resultRow("c-same", true, [assertion("maxModelCalls", true, 4)])],
    };
    const after: DiffableReport = {
      ...BEFORE,
      pin: { ...PIN, gitSha: null },
      cases: [resultRow("c-same", true, [])],
    };

    expect(formatDiff(before, after).split("\n").slice(0, 1)).toEqual([
      "before: 2026-11-06T08:30:05.123Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt 1a2b3c4d5e6f  policy 0f9e8d7c6b5a  git unknown",
    ]);
    expect(formatDiff(before, after).split("\n").slice(-2)).toEqual([
      "  c-same: Case c-same (still passing)",
      "    - maxModelCalls (was passed)",
    ]);
  });

  /** A pin names a commit exactly only when the tree held nothing uncommitted. */
  it("marks a run from a dirty tree, and counts a change in that as a pin change", () => {
    const before: DiffableReport = { ...BEFORE, pin: { ...PIN, gitDirty: true } };
    const after: DiffableReport = {
      ...BEFORE,
      ranAt: "2026-11-06T10:00:00.000Z",
      pin: { ...PIN, gitDirty: null },
    };

    expect(formatDiff(before, after).split("\n").slice(0, 3)).toEqual([
      "before: 2026-11-06T08:30:05.123Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt 1a2b3c4d5e6f  policy 0f9e8d7c6b5a  git 3913f4a (dirty)",
      "after:  2026-11-06T10:00:00.000Z  sonnet (model-id-for-sonnet)  pack kidlat-fiber  sop v1  prompt 1a2b3c4d5e6f  policy 0f9e8d7c6b5a  git 3913f4a (dirty unknown)",
      "pin changes: dirty",
    ]);
  });
});

/**
 * The diff copies no pin field by hand without a check: core adding a field
 * to CallPin, or removing one, must fail `tsc` (Tala FAILURES entry 6:
 * `satisfies T[]` proves membership, not coverage).
 */
describe("the pin the diff reads", () => {
  it("is exactly the call's pin, the git commit and whether the tree was dirty", () => {
    expectTypeOf<keyof DiffableReport["pin"]>().toEqualTypeOf<keyof CallPin | "gitSha" | "gitDirty">();
  });

  /** Every field, changed one at a time. `satisfies` makes a missing or extra field a type error. */
  it("names every pin field that moved", () => {
    const base = { ...PIN, model: "sonnet" } satisfies ReportPin;
    const other = {
      packId: "other-pack",
      sopVersion: "v2",
      promptVersion: "bbbbbbbbbbbb",
      policyVersion: "cccccccccccc",
      model: "opus",
      modelId: "model-id-for-opus",
      gitSha: "ffffffffffffffffffffffffffffffffffffffff",
      gitDirty: true,
    } satisfies ReportPin;

    const changes = Object.fromEntries(
      (Object.keys(other) as (keyof ReportPin)[]).map((key) => {
        const after: DiffableReport = { ...BEFORE, pin: { ...base, [key]: other[key] } };
        return [key, formatDiff({ ...BEFORE, pin: base }, after).split("\n")[2]];
      }),
    );

    expect(changes).toEqual({
      packId: "pin changes: pack",
      sopVersion: "pin changes: sop",
      promptVersion: "pin changes: prompt",
      policyVersion: "pin changes: policy",
      model: "pin changes: model",
      modelId: "pin changes: model",
      gitSha: "pin changes: git",
      gitDirty: "pin changes: dirty",
    });
  });
});

describe("parseReport", () => {
  /** Reports written before the pin recorded a dirty tree say nothing about it. */
  it("reads a report from before the dirty flag as dirty unknown", () => {
    const oldPin = Object.fromEntries(Object.entries(PIN).filter(([key]) => key !== "gitDirty"));
    const old = JSON.parse(JSON.stringify({ format: 1, ...BEFORE, pin: oldPin })) as unknown;

    expect(parseReport(old, "old.json").pin.gitDirty).toBeNull();
  });

  it("reads what the diff needs from a report file's JSON", () => {
    const fileJson = JSON.parse(
      JSON.stringify({ format: 1, masking: "none (#10)", ...BEFORE, cost: {}, models: {} }),
    ) as unknown;

    expect(parseReport(fileJson, "before.json")).toEqual(BEFORE);
  });

  it("rejects anything else, naming the file and every problem", () => {
    expect(() => parseReport({ format: 2, pin: {} }, "notes.json")).toThrow(
      /^notes\.json is not an eval report: format: .+; ranAt: .+; pin\.packId: .+/,
    );
  });
});

/**
 * The live transcript `npm run eval` prints. In CI these logs are public, so
 * account and phone numbers are masked here too (#10).
 */
describe("formatEvent", () => {
  const AT = new Date("2026-11-06T05:00:00Z");

  it("prints what was said, with account and phone numbers masked", () => {
    expect(formatEvent({ type: "speech", text: "Ending in 0101, po? Account 8012345601." })).toBe(
      "    Tala:   Ending in 0101, po? Account ******5601.",
    );
    expect(formatEvent({ type: "caller_said", text: "0917 555 0101 po", at: AT })).toBe(
      "    Caller: *******0101 po",
    );
  });

  it("prints a tool span's name and whether it failed, not its payload", () => {
    const span = (over: Partial<SpanEvent>): CallEvent => ({
      type: "span",
      span: {
        seq: 1,
        type: "tool_exec",
        name: "verify_identity",
        input: { account_number: "8012345601" },
        output: null,
        isError: false,
        usage: null,
        costNanos: 0,
        estimated: false,
        latencyMs: 1,
        startedAt: AT,
        endedAt: AT,
        ...over,
      },
    });

    expect(formatEvent(span({}))).toBe("            [tool_exec verify_identity]");
    expect(formatEvent(span({ isError: true }))).toBe(
      "            [tool_exec verify_identity (error)]",
    );
    expect(formatEvent(span({ type: "llm_call" }))).toBeNull();
  });

  it("prints nothing for other events", () => {
    expect(formatEvent({ type: "awaiting_caller" })).toBeNull();
  });
});
