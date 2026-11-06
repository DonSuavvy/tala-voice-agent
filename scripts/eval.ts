/**
 * The eval suite (#9): every Kidlat Fiber case, played against Tala by a
 * simulated caller, scored by the deterministic gate, graded (advisory), and
 * saved as a pinned report.
 *
 *   npm run eval                                  # Tala on Sonnet 5.5, every case
 *   npm run eval -- --model opus                  # or haiku
 *   npm run eval -- --case scenario-1-outage      # one case
 *
 * Needs ANTHROPIC_API_KEY (.env.local on a laptop, a repository secret in CI;
 * first-party API only) and spends real credit; see the cap below. The
 * simulated caller and the grader run on Sonnet 5.5.
 *
 * It prints each case's gate result with the advisory grade beside it, the
 * run's actual cost (every model call's real usage, priced with core's rate
 * cards: Tala, the caller and the grader), and where the report was written:
 * packages/evals/reports/<UTC time>-<model>.json. It exits 1 if any case
 * fails the gate; the grade never changes that.
 *
 * The $1.00 cap, exactly: Tala's model calls are checked against it before
 * each call, through the call session's budget. Each case's session is told
 * what the run's finished cases spent on Tala and on the simulated caller,
 * and adds its own Tala spend as the call goes; a call the cap would breach is
 * refused and the case ends budget_refused. The caller is not checked against
 * the cap but is bounded by the case's maxTurns, and the grader by one call
 * per case. Both are in the run's reported cost. The grader's spend never
 * counts toward the cap, so the advisory grade cannot fail a later case.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ESTIMATED_RUN_NANOS,
  compilePackSop,
  createClient,
  maskNumbers,
  microsToUsdString,
  nanosToMicros,
  providerFromEnv,
  streamingMessageCreator,
  type BudgetConfig,
  type CallEvent,
  type CallPin,
  type LogicalModel,
} from "@tala/core";
import {
  DEFAULT_CALLER_MODEL,
  DEFAULT_GRADER_MODEL,
  anthropicGradeCreator,
  buildReport,
  caseRow,
  errorText,
  formatCaseResult,
  formatCost,
  formatEvent,
  gradeTranscript,
  loadCases,
  reportFileName,
  resolveGitDirty,
  resolveGitSha,
  runSimulatedCall,
  sessionSpendNanos,
  transcriptOf,
  type CaseReportRow,
} from "@tala/evals";
import { loadKidlatFiber } from "@tala/kidlat-fiber";

/**
 * Every logical model `--model` accepts. The annotation is the guard both ways:
 * a model core adds is a missing property and one it drops an excess one, so
 * either fails `tsc`. A `LogicalModel[]` list would only prove membership
 * (Tala FAILURES entry 6).
 */
const MODEL_NAMES: { readonly [M in LogicalModel]: M } = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};
const MODELS: readonly LogicalModel[] = Object.values(MODEL_NAMES);

/** Checked before each of Tala's model calls; see the header for what counts toward it. */
const RUN_CAP_NANOS = 1_000_000_000;

/**
 * More SDK retries than a live call gets: a suite is a burst of calls, and in
 * OpsPilot the default lost cases to 429s (core's ClientTuning).
 */
const MAX_RETRIES = 5;

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CASES_DIR = fileURLToPath(new URL("../packages/packs/kidlat-fiber/evals/cases/", import.meta.url));
const REPORTS_DIR = fileURLToPath(new URL("../packages/evals/reports/", import.meta.url));

/**
 * The finished cases. Their Tala and caller spend is what each next case's
 * session is told (`sessionSpendNanos`); their whole cost is printed if the
 * run dies halfway. A case cut off mid-call is not in it.
 */
const finished: CaseReportRow[] = [];

const usd = (nanos: number) => `$${microsToUsdString(nanosToMicros(nanos))}`;

function loadEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fine when the key is already exported, as in CI.
  }
}

function parseOptions(): { model: LogicalModel; only: string | null } {
  const { values } = parseArgs({
    options: {
      model: { type: "string", default: "sonnet" },
      case: { type: "string" },
    },
  });
  const model = values.model as LogicalModel;
  if (!MODELS.includes(model)) {
    throw new Error(`--model must be one of ${MODELS.join(", ")} (got "${values.model}")`);
  }
  return { model, only: values.case ?? null };
}

/** The live transcript: what was said, and which tools ran. Other events are not printed. */
function printEvent(event: CallEvent): void {
  const line = formatEvent(event);
  if (line !== null) console.log(line);
}

function pinOf(events: readonly CallEvent[]): CallPin | null {
  for (const event of events) if (event.type === "call_started") return event.pin;
  return null;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Uncommitted changes anywhere but the reports directory, which every run
 * writes to. Untracked files count: a new case file is read like any other.
 */
const gitStatus = () => git("status", "--porcelain", "--", ".", ":(exclude)packages/evals/reports");

/**
 * In GitHub Actions, names this run's report as the step's `report` output, so
 * the workflow uploads exactly this file. The checkout holds committed reports
 * too, and a run that dies before writing one names none. The path is relative
 * to the repository root, with forward slashes, as upload-artifact reads it.
 */
function tellWorkflow(file: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `report=${relative(REPO_ROOT, file).split(sep).join("/")}\n`);
}

async function main(): Promise<number> {
  loadEnv();
  const { model, only } = parseOptions();

  // Everything that can be checked for free is checked before any call.
  const pack = loadKidlatFiber();
  // The SOP text Tala is briefed with: the grader takes the company's style from it.
  const sop = compilePackSop(pack);
  const all = loadCases(CASES_DIR);
  const cases = only === null ? all : all.filter((c) => c.slug === only);
  if (cases.length === 0) {
    throw new Error(`no case named "${only}" (cases: ${all.map((c) => c.slug).join(", ")})`);
  }
  // Read before anything is written, so this run's own report cannot count.
  const gitDirty = resolveGitDirty(gitStatus);
  if (gitDirty === true) {
    console.warn(
      "eval: warning: the working tree has uncommitted changes, so the report's git commit " +
        "is not exactly what ran (the pin says dirty)",
    );
  }
  if ((process.env.ANTHROPIC_API_KEY ?? "").length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set; put it in .env.local or export it (first-party API only)",
    );
  }

  const provider = providerFromEnv(process.env);
  const client = createClient(process.env, { maxRetries: MAX_RETRIES });
  const talaCreator = streamingMessageCreator(client);
  const callerCreator = streamingMessageCreator(client);
  const graderCreator = anthropicGradeCreator(client);
  const budget: BudgetConfig = { dailyCapNanos: RUN_CAP_NANOS, killSwitch: false, runsPerMinute: 10 };

  const ranAt = new Date();
  const rows = finished;
  let pin: CallPin | null = null;

  console.log(
    `eval: ${cases.length} case(s); Tala on ${model}, caller and grader on ` +
      `${DEFAULT_CALLER_MODEL}; cap ${usd(RUN_CAP_NANOS)} on Tala's and the caller's spend, ` +
      "checked before each of Tala's model calls",
  );

  for (const kase of cases) {
    console.log(`\n${kase.slug}: ${kase.title}`);
    const callId = randomUUID();
    const started = Date.now();

    const call = await runSimulatedCall({
      caller: kase.caller,
      session: {
        pack,
        model,
        provider,
        createMessage: talaCreator,
        callId,
        clock: () => new Date(),
        // The finished cases' Tala and caller spend; never the grader's.
        budget: { config: budget, spentTodayNanos: sessionSpendNanos(finished) },
        estimatedCallNanos: ESTIMATED_RUN_NANOS,
      },
      callerCreateMessage: callerCreator,
      callerModel: DEFAULT_CALLER_MODEL,
      onEvent: printEvent,
    });
    const grade = await gradeTranscript({
      transcript: transcriptOf(call.events),
      sop,
      provider,
      createMessage: graderCreator,
      model: DEFAULT_GRADER_MODEL,
    });
    const row = caseRow({
      case: kase,
      call,
      world: pack.world,
      grade,
      callId,
      latencyMs: Date.now() - started,
    });

    pin ??= pinOf(call.events);
    rows.push(row);
    console.log(formatCaseResult(row));
  }

  if (pin === null) throw new Error("no call reported its pin (no call_started event)");

  const report = buildReport({
    ranAt,
    pin,
    gitSha: resolveGitSha(process.env, () => git("rev-parse", "HEAD")),
    gitDirty,
    callerModel: DEFAULT_CALLER_MODEL,
    graderModel: DEFAULT_GRADER_MODEL,
    rows,
  });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const file = join(REPORTS_DIR, reportFileName(ranAt, model));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  tellWorkflow(file);

  const failed = rows.filter((r) => !r.passed).length;
  console.log("");
  console.log(formatCost(report.cost));
  console.log(`report: ${relative(process.cwd(), file)}`);
  console.log(
    report.passed
      ? `gate: PASS (${rows.length} of ${rows.length} cases)`
      : `gate: FAIL (${failed} of ${rows.length} cases failed)`,
  );
  return report.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`eval: ${maskNumbers(errorText(error))}`);
    const spent = finished.reduce((sum, row) => sum + row.cost.total.nanos, 0);
    if (spent > 0) console.error(`eval: the finished cases cost ${usd(spent)}`);
    process.exitCode = 1;
  },
);
