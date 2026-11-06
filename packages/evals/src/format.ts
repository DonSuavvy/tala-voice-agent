/**
 * What the eval commands print (#9): each case's gate result with its
 * advisory grade beside it, the run's cost, and the diff between two runs.
 * Pure functions of report data, so the output is pinned by tests.
 *
 * `eval:diff` reads two report files with `parseReport`, which checks only
 * what the diff needs (the pin and the `CaseResultRow` fields of each case),
 * so a report written by an older runner with fewer extras still diffs.
 */
import { z } from "zod";

import { diffEvalRuns } from "./diff";
import { REPORT_FORMAT, type CaseReportRow, type CostSplit, type ReportPin } from "./report";
import type { AssertionFlip, CaseDiff, CaseResultRow } from "./types";

const INDENT = "      ";

export function formatCaseResult(row: CaseReportRow): string {
  const lines = [`${row.passed ? "PASS" : "FAIL"}  ${row.slug}: ${row.title} ($${row.costUsd})`];
  if (!row.passed) lines.push(`${INDENT}${row.failureReason ?? "failed"}`);

  const { grade, reason } = row.advisory;
  if (grade === null) {
    lines.push(`${INDENT}advisory grade: none (${reason ?? "no reason given"})`);
  } else {
    const notes = grade.notes.trim();
    lines.push(
      `${INDENT}advisory grade: tone ${grade.tone}, taglish ${grade.taglish}, ` +
        `politeness ${grade.politeness}${notes ? `. ${notes}` : ""}`,
    );
  }
  return lines.join("\n");
}

export function formatCost(cost: CostSplit): string {
  return (
    `cost: $${cost.total.usd} (Tala $${cost.tala.usd}, caller $${cost.caller.usd}, ` +
    `grader $${cost.grader.usd})${cost.total.estimated ? ", includes estimates" : ""}`
  );
}

/* -------------------------------------------------------------------------- */
/* The diff                                                                   */
/* -------------------------------------------------------------------------- */

const assertionSchema = z.object({
  name: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

const rowSchema = z.object({
  slug: z.string(),
  title: z.string(),
  passed: z.boolean(),
  assertions: z.array(assertionSchema),
  failureReason: z.string().nullable(),
  costUsd: z.string(),
  latencyMs: z.number().nullable(),
  agentRunId: z.string().nullable(),
});

/**
 * One schema per pin field. The `satisfies` is the guard, in both directions:
 * a field core adds to `CallPin` is a missing property here and one it drops
 * is an excess property, so either fails `tsc` (Tala FAILURES entry 6). The
 * values are read as plain text: an older report may name a model or a pack
 * this code no longer knows.
 */
const pinShape = {
  packId: z.string(),
  sopVersion: z.string(),
  promptVersion: z.string(),
  policyVersion: z.string(),
  model: z.string(),
  modelId: z.string(),
  gitSha: z.string().nullable(),
  // Reports from before the pin recorded it say nothing, which reads as unknown.
  gitDirty: z.boolean().nullable().default(null),
} satisfies { [K in keyof ReportPin]-?: z.ZodType };

const pinSchema = z.object(pinShape);

/**
 * What `pin changes` calls each field, in the pin's order, guarded the same
 * way. `model` and `modelId` share a label because they move together.
 */
const PIN_LABELS = {
  packId: "pack",
  sopVersion: "sop",
  promptVersion: "prompt",
  policyVersion: "policy",
  model: "model",
  modelId: "model",
  gitSha: "git",
  gitDirty: "dirty",
} as const satisfies { readonly [K in keyof ReportPin]-?: string };

const diffableSchema = z.object({
  format: z.literal(REPORT_FORMAT),
  ranAt: z.string(),
  pin: pinSchema,
  cases: z.array(rowSchema),
});

/** What the diff reads from a report. An `EvalReport` is one. */
export interface DiffableReport {
  ranAt: string;
  pin: z.infer<typeof pinSchema>;
  cases: CaseResultRow[];
}

/** A report file's parsed JSON, checked. Throws naming the file and every problem. */
export function parseReport(raw: unknown, source: string): DiffableReport {
  const parsed = diffableSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${source} is not an eval report: ${problems}`);
  }
  const { ranAt, pin, cases } = parsed.data;
  return { ranAt, pin, cases };
}

function dirtyMark(dirty: boolean | null): string {
  if (dirty === null) return " (dirty unknown)";
  return dirty ? " (dirty)" : "";
}

/**
 * How the pin line prints each field, in print order, guarded like the
 * labels: a pin field with no printer fails `tsc`, so none can go unprinted.
 * A field printed beside another returns null, and says which.
 */
const PIN_PRINTERS = {
  model: (pin) => `${pin.model} (${pin.modelId})`,
  modelId: () => null, // printed with model
  packId: (pin) => `pack ${pin.packId}`,
  sopVersion: (pin) => `sop ${pin.sopVersion}`,
  promptVersion: (pin) => `prompt ${pin.promptVersion}`,
  policyVersion: (pin) => `policy ${pin.policyVersion}`,
  gitSha: (pin) =>
    `git ${pin.gitSha === null ? "unknown" : pin.gitSha.slice(0, 7)}${dirtyMark(pin.gitDirty)}`,
  gitDirty: () => null, // printed with gitSha
} satisfies { [K in keyof ReportPin]-?: (pin: DiffableReport["pin"]) => string | null };

function pinLine(label: string, report: DiffableReport): string {
  const parts = (Object.keys(PIN_PRINTERS) as (keyof ReportPin)[])
    .map((field) => PIN_PRINTERS[field](report.pin))
    .filter((part): part is string => part !== null);
  return `${label} ${report.ranAt}  ${parts.join("  ")}`;
}

/** Which parts of the pin moved, in the pin's own order. */
function pinChanges(before: DiffableReport["pin"], after: DiffableReport["pin"]): string {
  const moved: string[] = [];
  for (const field of Object.keys(PIN_LABELS) as (keyof ReportPin)[]) {
    const label = PIN_LABELS[field];
    if (before[field] !== after[field] && !moved.includes(label)) moved.push(label);
  }
  return `pin changes: ${moved.length > 0 ? moved.join(", ") : "none"}`;
}

const verdict = (passed: boolean) => (passed ? "passed" : "failed");

function flipLine(flip: AssertionFlip): string {
  const { name, before, after } = flip;
  if (before === null && after !== null) return `+ ${name}: ${verdict(after.passed)}`;
  if (after === null && before !== null) return `- ${name} (was ${verdict(before.passed)})`;
  if (before === null || after === null) return name;

  if (before.passed !== after.passed) {
    const detail = after.detail ? ` (${after.detail})` : "";
    return `${name}: ${verdict(before.passed)} -> ${verdict(after.passed)}${detail}`;
  }
  return (
    `${name}: still ${verdict(after.passed)}, actual ` +
    `${JSON.stringify(before.actual)} -> ${JSON.stringify(after.actual)}`
  );
}

function caseLines(entry: CaseDiff): string[] {
  const head = `  ${entry.slug}: ${entry.title}`;
  switch (entry.kind) {
    case "added":
      return [`${head} (${verdict(entry.after?.passed ?? false)})`];
    case "removed":
      return [`${head} (${verdict(entry.before?.passed ?? false)})`];
    case "unchanged":
      return [
        `${head} (${entry.after?.passed ? "still passing" : "still failing"})`,
        ...entry.flips.map((flip) => `    ${flipLine(flip)}`),
      ];
    default:
      return [head, ...entry.flips.map((flip) => `    ${flipLine(flip)}`)];
  }
}

/**
 * Both pins, what changed between them, and the five buckets: regressed and
 * fixed first, because those are what a reviewer came for.
 */
export function formatDiff(before: DiffableReport, after: DiffableReport): string {
  const diff = diffEvalRuns(before.cases, after.cases);
  const lines = [pinLine("before:", before), pinLine("after: ", after), pinChanges(before.pin, after.pin), ""];

  for (const bucket of ["regressed", "fixed", "added", "removed", "unchanged"] as const) {
    lines.push(`${bucket} (${diff[bucket].length})`);
    for (const entry of diff[bucket]) lines.push(...caseLines(entry));
  }
  return lines.join("\n");
}
