/**
 * The eval report (#9): one JSON file per run, pinned, with one row per case
 * and the run's cost. Everything here is pure; the runner writes the file.
 *
 * **The gate verdict is the deterministic scorer's alone.** `caseRow` scores
 * the call itself, from the case's expectations and the observation of its
 * events, so nothing else can set `passed`. The advisory grade is copied
 * beside it, read-only. The one other thing that fails a case is a simulated
 * caller that could not go on: a call it never finished proves nothing, so the
 * case fails with the caller's error as the reason.
 *
 * Rows are `CaseResultRow`s plus what a run adds (the cost split, the caller's
 * ending, the advisory grade, the transcript), so the regression diff reads
 * two reports' rows unchanged.
 *
 * **Cost is the real spend, split Tala / caller / grader.** Tala's is the sum
 * of her spans, the caller's and the grader's the priced usage of their calls.
 * Only Tala's and the caller's spend counts toward the run's cap
 * (`sessionSpendNanos`); the grader's is reported and never budgets anything.
 * A figure is marked estimated when any part of it was, for example an
 * estimated model call.
 *
 * **Account and phone numbers are masked in everything a row stores** (#10, Q21):
 * the transcript, the assertions, the failure reason, the caller's error and
 * the grade's reason. The report says so at the top. The scoring above reads
 * the unmasked call; masking only shapes what is saved and printed, so a
 * check such as "no account data before verification" still sees real values.
 */
import {
  maskDeep,
  microsToUsdString,
  nanosToMicros,
  type CallPin,
  type LogicalModel,
  type SeedWorld,
} from "@tala/core";

import type { EvalCase } from "./case";
import type { AdvisoryGrade, Grade } from "./grader";
import { observeCall } from "./observe";
import { score } from "./score";
import type { CallerStop, SimulatedCall } from "./simulated-caller";
import { transcriptOf, type TranscriptLine } from "./transcript";
import type { CaseResultRow } from "./types";

/** The report file's format, for readers such as the diff. */
export const REPORT_FORMAT = 1;

export interface CostLine {
  nanos: number;
  /** Dollars to six places, as `numeric(12,6)` stores them. */
  usd: string;
  /** True when any part of the figure was priced from an estimate. */
  estimated: boolean;
}

export interface CostSplit {
  tala: CostLine;
  caller: CostLine;
  grader: CostLine;
  total: CostLine;
}

export interface CaseReportRow extends CaseResultRow {
  cost: CostSplit;
  caller: { stoppedBy: CallerStop; turns: number; error: string | null };
  /** Shown beside the gate; never part of it. */
  advisory: { grade: Grade | null; reason: string | null };
  transcript: TranscriptLine[];
}

export interface ReportPin extends CallPin {
  gitSha: string | null;
  /** True when the tree held uncommitted changes, so `gitSha` is not exactly what ran. Null when unknown. */
  gitDirty: boolean | null;
}

export interface EvalReport {
  format: typeof REPORT_FORMAT;
  masking: "numbers of 10 or more digits, last 4 kept";
  ranAt: string;
  pin: ReportPin;
  models: { caller: LogicalModel; grader: LogicalModel };
  /** Every case passed the gate. */
  passed: boolean;
  cases: CaseReportRow[];
  cost: CostSplit;
}

function costLine(parts: readonly { nanos: number; estimated: boolean }[]): CostLine {
  const nanos = parts.reduce((sum, part) => sum + part.nanos, 0);
  return {
    nanos,
    usd: microsToUsdString(nanosToMicros(nanos)),
    estimated: parts.some((part) => part.estimated),
  };
}

function split(tala: CostLine, caller: CostLine, grader: CostLine): CostSplit {
  return { tala, caller, grader, total: costLine([tala, caller, grader]) };
}

export interface CaseRowInput {
  case: EvalCase;
  call: SimulatedCall;
  /** The seed world the call started from. */
  world: Pick<SeedWorld, "accounts">;
  grade: AdvisoryGrade;
  callId: string;
  /** How long the case took, as the runner measured it. */
  latencyMs: number | null;
}

/**
 * The row with account and phone numbers masked in every field that can hold
 * caller or tool text. Masking again changes nothing, so rows built by
 * `caseRow` pass through `buildReport` untouched.
 */
function maskedRow(row: CaseReportRow): CaseReportRow {
  return {
    ...row,
    assertions: maskDeep(row.assertions),
    failureReason: maskDeep(row.failureReason),
    caller: maskDeep(row.caller),
    advisory: maskDeep(row.advisory),
    transcript: maskDeep(row.transcript),
  };
}

/** One case's row: scored here, from the call's own events. */
export function caseRow(input: CaseRowInput): CaseReportRow {
  const { call, grade } = input;
  const verdict = score(input.case.expect, observeCall(call.events, input.world));
  const callerFailed = call.stoppedBy === "caller_failed";

  const spans = call.events.flatMap((e) => (e.type === "span" ? [e.span] : []));
  const cost = split(
    costLine(spans.map((s) => ({ nanos: s.costNanos, estimated: s.estimated }))),
    costLine(call.callerCalls.map((c) => ({ nanos: c.costNanos, estimated: c.estimated }))),
    costLine([{ nanos: grade.costNanos, estimated: grade.estimated }]),
  );

  return maskedRow({
    slug: input.case.slug,
    title: input.case.title,
    passed: verdict.passed && !callerFailed,
    assertions: verdict.assertions,
    failureReason: callerFailed
      ? (call.callerError ?? "the simulated caller failed")
      : verdict.failureReason,
    costUsd: cost.total.usd,
    latencyMs: input.latencyMs,
    agentRunId: input.callId,
    cost,
    caller: { stoppedBy: call.stoppedBy, turns: call.callerTurns, error: call.callerError },
    advisory: { grade: grade.grade, reason: grade.reason },
    transcript: transcriptOf(call.events),
  });
}

export interface ReportInput {
  ranAt: Date;
  /** Tala's pin: the same for every case in a run. */
  pin: CallPin;
  gitSha: string | null;
  gitDirty: boolean | null;
  callerModel: LogicalModel;
  graderModel: LogicalModel;
  rows: CaseReportRow[];
}

export function buildReport(input: ReportInput): EvalReport {
  const { rows } = input;
  const sum = (part: "tala" | "caller" | "grader") => costLine(rows.map((r) => r.cost[part]));

  return {
    format: REPORT_FORMAT,
    masking: "numbers of 10 or more digits, last 4 kept",
    ranAt: input.ranAt.toISOString(),
    pin: { ...input.pin, gitSha: input.gitSha, gitDirty: input.gitDirty },
    models: { caller: input.callerModel, grader: input.graderModel },
    passed: rows.every((r) => r.passed),
    cases: rows.map(maskedRow),
    cost: split(sum("tala"), sum("caller"), sum("grader")),
  };
}

/**
 * What the run has spent that counts toward its cap, for the next case's
 * session budget: Tala's model calls and the simulated callers'. The cap is
 * checked before each of Tala's model calls, against this plus what that
 * call's own case has spent on Tala so far.
 *
 * The grader's spend is left out on purpose. It is in the run's reported
 * cost, but if it budgeted anything, the advisory grade of one case could
 * push a later case into budget_refused, and the grade would have failed a
 * run.
 */
export function sessionSpendNanos(rows: readonly CaseReportRow[]): number {
  return rows.reduce((sum, row) => sum + row.cost.tala.nanos + row.cost.caller.nanos, 0);
}

/**
 * `20261106T083005Z-sonnet.json`: the run's UTC time, then Tala's model. No
 * colons, which Windows file names cannot hold, and names sort in time order.
 */
export function reportFileName(ranAt: Date, model: LogicalModel): string {
  const stamp = ranAt.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `${stamp}-${model}.json`;
}
