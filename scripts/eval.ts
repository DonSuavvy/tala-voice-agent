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
 * first-party API only) and spends real credit, capped at $1.00 per run. The
 * simulated caller and the grader run on Sonnet 5.5.
 *
 * It prints each case's gate result with the advisory grade beside it, the
 * run's actual cost (every model call's real usage, priced with core's rate
 * cards: Tala, the caller and the grader), and where the report was written:
 * packages/evals/reports/<UTC time>-<model>.json. It exits 1 if any case
 * fails the gate; the grade never changes that.
 *
 * The cap works through the call session's budget: each case's session is
 * told what the run has spent so far, so Tala's model calls are refused once
 * the run reaches $1.00 and the case ends budget_refused.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ESTIMATED_RUN_NANOS,
  createClient,
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
  formatCaseResult,
  formatCost,
  gradeTranscript,
  loadCases,
  reportFileName,
  resolveGitSha,
  runSimulatedCall,
  transcriptOf,
  type CaseReportRow,
} from "@tala/evals";
import { loadKidlatFiber } from "@tala/kidlat-fiber";

const MODELS: readonly LogicalModel[] = ["haiku", "sonnet", "opus"];

/** $1.00 per run, through the same budget check every model call passes. */
const RUN_CAP_NANOS = 1_000_000_000;

/**
 * More SDK retries than a live call gets: a suite is a burst of calls, and in
 * OpsPilot the default lost cases to 429s (core's ClientTuning).
 */
const MAX_RETRIES = 5;

const CASES_DIR = fileURLToPath(new URL("../packages/packs/kidlat-fiber/evals/cases/", import.meta.url));
const REPORTS_DIR = fileURLToPath(new URL("../packages/evals/reports/", import.meta.url));

/**
 * What the finished cases cost, which each next case's session is told. Also
 * printed if the run dies halfway; a case cut off mid-call is not in it.
 */
let spentNanos = 0;

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
  if (event.type === "speech") console.log(`    Tala:   ${event.text}`);
  else if (event.type === "caller_said") console.log(`    Caller: ${event.text}`);
  else if (event.type === "span" && event.span.type !== "llm_call") {
    console.log(`            [${event.span.type} ${event.span.name}${event.span.isError ? " (error)" : ""}]`);
  }
}

function pinOf(events: readonly CallEvent[]): CallPin | null {
  for (const event of events) if (event.type === "call_started") return event.pin;
  return null;
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function main(): Promise<number> {
  loadEnv();
  const { model, only } = parseOptions();

  // Everything that can be checked for free is checked before any call.
  const pack = loadKidlatFiber();
  const all = loadCases(CASES_DIR);
  const cases = only === null ? all : all.filter((c) => c.slug === only);
  if (cases.length === 0) {
    throw new Error(`no case named "${only}" (cases: ${all.map((c) => c.slug).join(", ")})`);
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
  const rows: CaseReportRow[] = [];
  let pin: CallPin | null = null;

  console.log(
    `eval: ${cases.length} case(s); Tala on ${model}, caller and grader on ` +
      `${DEFAULT_CALLER_MODEL}; cap ${usd(RUN_CAP_NANOS)}`,
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
        // The run's spend so far: Tala, the callers and the grader.
        budget: { config: budget, spentTodayNanos: spentNanos },
        estimatedCallNanos: ESTIMATED_RUN_NANOS,
      },
      callerCreateMessage: callerCreator,
      callerModel: DEFAULT_CALLER_MODEL,
      onEvent: printEvent,
    });
    const grade = await gradeTranscript({
      transcript: transcriptOf(call.events),
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
    spentNanos += row.cost.total.nanos;
    console.log(formatCaseResult(row));
  }

  if (pin === null) throw new Error("no call reported its pin (no call_started event)");

  const report = buildReport({
    ranAt,
    pin,
    gitSha: resolveGitSha(process.env, gitHead),
    callerModel: DEFAULT_CALLER_MODEL,
    graderModel: DEFAULT_GRADER_MODEL,
    rows,
  });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const file = join(REPORTS_DIR, reportFileName(ranAt, model));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

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
    const message = error instanceof Error ? error.message : String(error);
    console.error(`eval: ${message}`);
    if (spentNanos > 0) console.error(`eval: the finished cases cost ${usd(spentNanos)}`);
    process.exitCode = 1;
  },
);
