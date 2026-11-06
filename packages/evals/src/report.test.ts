import { describe, expect, it } from "vitest";

import type { CallEvent, CallPin, SeedWorld, SpanEvent } from "@tala/core";

import type { EvalCase } from "./case";
import type { AdvisoryGrade } from "./grader";
import { buildReport, caseRow, reportFileName, type CaseReportRow } from "./report";
import type { SimulatedCall } from "./simulated-caller";

/**
 * The report is one JSON file per run: the pin, one row per case, and the
 * cost. Building it is pure. Its rows are `CaseResultRow`s, so the diff reads
 * them, and the gate verdict in each comes from the deterministic scorer
 * alone: the advisory grade sits beside it and cannot move it.
 */

const AT = new Date("2026-11-06T05:00:00Z");

/** Not a real wire id: the report only carries what it is given. */
const PIN: CallPin = {
  packId: "kidlat-fiber",
  sopVersion: "v1",
  promptVersion: "1a2b3c4d5e6f",
  policyVersion: "0f9e8d7c6b5a",
  model: "sonnet",
  modelId: "model-id-for-sonnet",
};

const WORLD: Pick<SeedWorld, "accounts"> = {
  accounts: [
    {
      accountNumber: "8012345601",
      holderName: "Maria Santos",
      registeredMobile: "+639175550101",
      status: "active",
      planName: "Kidlat 300",
      barangayId: "batasan-hills",
    },
  ],
};

const CASE: EvalCase = {
  slug: "scenario-1-outage",
  title: "Batasan Hills outage",
  caller: { brief: "You are Maria Santos.", maxTurns: 6 },
  expect: { endedBy: "end_call" },
};

function llmSpan(costNanos: number, estimated = false): SpanEvent {
  return {
    seq: 0,
    type: "llm_call",
    name: "model-id-for-sonnet",
    input: null,
    output: { stop_reason: "end_turn", blocks: ["text"] },
    isError: false,
    usage: null,
    costNanos,
    estimated,
    latencyMs: 1,
    startedAt: AT,
    endedAt: AT,
  };
}

const DISPOSITION = {
  outcome: "resolved",
  topic: "outage",
  summary: "Caller had no internet; told her about the fiber cut.",
} as const;

function events(spans: SpanEvent[], ended = true): CallEvent[] {
  return [
    { type: "call_started", callId: "call_1", pin: PIN, at: AT },
    { type: "speech", text: "Hello po! I'm Tala." },
    { type: "caller_said", text: "Wala po kaming internet.", at: AT },
    { type: "speech", text: "May fiber cut po." },
    ...spans.map((span): CallEvent => ({ type: "span", span })),
    ...(ended
      ? [
          {
            type: "call_ended",
            reason: "end_call",
            disposition: DISPOSITION,
            verifiedAccount: null,
            pin: PIN,
            error: null,
            at: AT,
          } as const,
        ]
      : []),
  ];
}

function simulated(over: Partial<SimulatedCall> = {}): SimulatedCall {
  return {
    events: events([llmSpan(3_000_000), llmSpan(1_000_000)]),
    stoppedBy: "call_ended",
    callerError: null,
    callerTurns: 1,
    callerCalls: [
      { usage: null, costNanos: 500_000, estimated: false, isError: false },
      { usage: null, costNanos: 250_000, estimated: false, isError: false },
    ],
    ...over,
  };
}

const GRADE: AdvisoryGrade = {
  grade: { tone: 4, taglish: 5, politeness: 5, notes: "Warm and brief." },
  reason: null,
  usage: null,
  costNanos: 200_000,
  estimated: false,
};

const NO_GRADE: AdvisoryGrade = {
  grade: null,
  reason: "the grader's model refused",
  usage: null,
  costNanos: 0,
  estimated: false,
};

function row(over: { case?: EvalCase; call?: SimulatedCall; grade?: AdvisoryGrade } = {}) {
  return caseRow({
    case: over.case ?? CASE,
    call: over.call ?? simulated(),
    world: WORLD,
    grade: over.grade ?? GRADE,
    callId: "call_1",
    latencyMs: 4_200,
  });
}

/* -------------------------------------------------------------------------- */

describe("caseRow: the gate verdict", () => {
  it("is a CaseResultRow scored by the deterministic scorer", () => {
    const result = row();

    expect(result).toMatchObject({
      slug: "scenario-1-outage",
      title: "Batasan Hills outage",
      passed: true,
      assertions: [{ name: "endedBy", expected: "end_call", actual: "end_call", passed: true }],
      failureReason: null,
      costUsd: "0.004950",
      latencyMs: 4_200,
      agentRunId: "call_1",
    });
  });

  it("fails with the scorer's first failing assertion as the reason", () => {
    const result = row({ call: simulated({ events: events([llmSpan(1)], false), stoppedBy: "turn_cap" }) });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe('expected the call to end with "end_call", got "not_ended"');
  });

  /** The acceptance criterion: the advisory grade can never fail (or pass) a case. */
  it.each([
    ["a perfect grade on a failing call", { ...CASE, expect: { endedBy: "not_ended" } }, GRADE, false],
    ["no grade on a passing call", CASE, NO_GRADE, true],
    [
      "the lowest grade on a passing call",
      CASE,
      { ...GRADE, grade: { tone: 1, taglish: 1, politeness: 1, notes: "Cold." } },
      true,
    ],
  ] as const)("does not move with the grade: %s", (_label, kase, grade, passed) => {
    const result = row({ case: kase, grade });

    expect(result.passed).toBe(passed);
    expect(result.advisory).toEqual({ grade: grade.grade, reason: grade.reason });
  });

  /**
   * A caller that could not go on leaves a call that proves nothing, so the
   * case fails whatever the assertions say, and the reason is the caller's.
   */
  it("fails a case whose simulated caller failed, with the caller's error as the reason", () => {
    const result = row({
      case: { ...CASE, expect: { endedBy: "not_ended" } },
      call: simulated({
        events: events([llmSpan(1)], false),
        stoppedBy: "caller_failed",
        callerError: "the simulated caller's model call failed: overloaded",
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe("the simulated caller's model call failed: overloaded");
    expect(result.assertions).toEqual([
      { name: "endedBy", expected: "not_ended", actual: "not_ended", passed: true },
    ]);
    expect(result.caller).toEqual({
      stoppedBy: "caller_failed",
      turns: 1,
      error: "the simulated caller's model call failed: overloaded",
    });
  });
});

describe("caseRow: cost", () => {
  it("splits the case's cost into Tala, the caller and the grader, with the total", () => {
    expect(row().cost).toEqual({
      tala: { nanos: 4_000_000, usd: "0.004000", estimated: false },
      caller: { nanos: 750_000, usd: "0.000750", estimated: false },
      grader: { nanos: 200_000, usd: "0.000200", estimated: false },
      total: { nanos: 4_950_000, usd: "0.004950", estimated: false },
    });
  });

  /** An interrupted model call books an estimate; any estimated part makes the total one. */
  it("marks a part, and the total, as estimated when any of it is", () => {
    const result = row({
      call: simulated({ events: events([llmSpan(3_000_000), llmSpan(1_000_000, true)]) }),
    });

    expect(result.cost.tala.estimated).toBe(true);
    expect(result.cost.caller.estimated).toBe(false);
    expect(result.cost.total.estimated).toBe(true);
  });
});

describe("caseRow: what was said", () => {
  it("keeps the transcript, unmasked", () => {
    expect(row().transcript).toEqual([
      { speaker: "tala", text: "Hello po! I'm Tala." },
      { speaker: "caller", text: "Wala po kaming internet." },
      { speaker: "tala", text: "May fiber cut po." },
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe("buildReport", () => {
  const RAN_AT = new Date("2026-11-06T08:30:05.123Z");

  function report(rows: CaseReportRow[]) {
    return buildReport({
      ranAt: RAN_AT,
      pin: PIN,
      gitSha: "3913f4a0000000000000000000000000000000ab",
      gitDirty: true,
      callerModel: "sonnet",
      graderModel: "sonnet",
      rows,
    });
  }

  it("pins the run and says the record is not masked yet", () => {
    const result = report([row()]);

    expect(result).toMatchObject({
      format: 1,
      masking: "none (#10)",
      ranAt: "2026-11-06T08:30:05.123Z",
      pin: {
        packId: "kidlat-fiber",
        sopVersion: "v1",
        promptVersion: "1a2b3c4d5e6f",
        policyVersion: "0f9e8d7c6b5a",
        model: "sonnet",
        modelId: "model-id-for-sonnet",
        gitSha: "3913f4a0000000000000000000000000000000ab",
        gitDirty: true,
      },
      models: { caller: "sonnet", grader: "sonnet" },
    });
  });

  it("passes only when every case passed", () => {
    const failing = row({ case: { ...CASE, slug: "other", expect: { endedBy: "failed" } } });

    expect(report([row(), row()]).passed).toBe(true);
    expect(report([row(), failing]).passed).toBe(false);
  });

  it("adds up the run's cost, three ways, and says when it includes estimates", () => {
    const estimated = row({
      call: simulated({ events: events([llmSpan(1_000_000, true)]) }),
    });
    const result = report([row(), estimated]);

    expect(result.cost).toEqual({
      tala: { nanos: 5_000_000, usd: "0.005000", estimated: true },
      caller: { nanos: 1_500_000, usd: "0.001500", estimated: false },
      grader: { nanos: 400_000, usd: "0.000400", estimated: false },
      total: { nanos: 6_900_000, usd: "0.006900", estimated: true },
    });
  });
});

describe("reportFileName", () => {
  /** UTC, no colons (Windows file names), so file names sort in time order. */
  it("is the run's UTC timestamp and Tala's model", () => {
    expect(reportFileName(new Date("2026-11-06T08:30:05.123Z"), "sonnet")).toBe(
      "20261106T083005Z-sonnet.json",
    );
  });
});
