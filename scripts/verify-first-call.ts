/**
 * Live check for #5: scenario 1's outage call against real Claude.
 *
 *   npm run verify:first-call                    # Opus 5.5
 *   npm run verify:first-call -- --model haiku
 *
 * Not part of `npm test`: it needs ANTHROPIC_API_KEY (.env.local, first-party
 * API only) and spends real credit, a few cents on Opus. It plays a scripted
 * caller through the same call session the terminal chat and the voice paths
 * use, then checks the trace for what the ticket promises:
 *
 * 1. Tala's first words are the AI and recording disclosure.
 * 2. verify_identity succeeded for the scenario 1 customer.
 * 3. check_area_outage ran after that and returned the Batasan Hills outage.
 * 4. The call ended through end_call with a structured disposition.
 *
 * It also prints each model turn's block types and stop reason, the cache
 * reads, and the cost, so the first live run answers what tests cannot: does
 * the SDK 1.x streaming path work, does the prefix cache, and does Opus 5.5
 * return the short line before a tool call as text or as a thinking block.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import {
  ESTIMATED_RUN_NANOS,
  createCallSession,
  createClient,
  microsToUsdString,
  nanosToMicros,
  providerFromEnv,
  streamingMessageCreator,
  type CallEvent,
  type LogicalModel,
  type SpanEvent,
} from "@tala/core";
import { loadKidlatFiber } from "@tala/kidlat-fiber";

/** What the scripted caller says, one line per turn, in order. */
const CALLER_LINES = [
  "Hello po, wala po kaming internet since this morning.",
  "Yung account number ko po ay 8012345601, tapos yung last four ng mobile ko ay 0101.",
  "Ah okay po, salamat sa info. Yun lang po.",
  "Bye po.",
  "Salamat po, bye.",
];

const MODELS: readonly LogicalModel[] = ["haiku", "sonnet", "opus"];

const SCENARIO_ACCOUNT = "8012345601";
const SCENARIO_OUTAGE = "OUT-2026-0412";

const usd = (nanos: number) => `$${microsToUsdString(nanosToMicros(nanos))}`;

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fine when the key is already exported; providerFromEnv says if not.
  }
  const { values } = parseArgs({ options: { model: { type: "string", default: "opus" } } });
  const model = values.model as LogicalModel;
  if (!MODELS.includes(model)) {
    throw new Error(`--model must be one of ${MODELS.join(", ")} (got "${values.model}")`);
  }

  const provider = providerFromEnv(process.env);
  const pack = loadKidlatFiber();
  const events: CallEvent[] = [];

  const session = createCallSession({
    pack,
    model,
    provider,
    createMessage: streamingMessageCreator(createClient(process.env)),
    callId: randomUUID(),
    clock: () => new Date(),
    budget: {
      config: { dailyCapNanos: 500_000_000, killSwitch: false, runsPerMinute: 10 },
      spentTodayNanos: 0,
    },
    estimatedCallNanos: ESTIMATED_RUN_NANOS,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "speech") console.log(`Tala:   ${event.text}`);
      if (event.type === "caller_said") console.log(`Caller: ${event.text}`);
      if (event.type === "span" && event.span.type === "llm_call") {
        const u = event.span.usage;
        console.log(
          `        [${JSON.stringify(event.span.output)} in=${u?.inputTokens} ` +
            `cacheRead=${u?.cacheReadInputTokens} cacheWrite=${u?.cacheCreationInputTokens} ` +
            `out=${u?.outputTokens} ${event.span.latencyMs}ms ${usd(event.span.costNanos)}]`,
        );
      }
      if (event.type === "span" && event.span.type !== "llm_call") {
        console.log(
          `        [${event.span.type} ${event.span.name}${event.span.isError ? " ERROR" : ""}: ` +
            `${JSON.stringify(event.span.output)}]`,
        );
      }
    },
  });

  session.start();
  for (const line of CALLER_LINES) {
    if (events.some((e) => e.type === "call_ended")) break;
    await session.callerSaid(line);
  }

  const spans = events.flatMap((e) => (e.type === "span" ? [e.span] : []));
  const toolSpans = (name: string): SpanEvent[] =>
    spans.filter((s) => s.type === "tool_exec" && s.name === name && !s.isError);
  const verified = toolSpans("verify_identity").find(
    (s) => (s.output as { verified?: boolean }).verified === true,
  );
  const outage = toolSpans("check_area_outage").find((s) =>
    JSON.stringify(s.output).includes(SCENARIO_OUTAGE),
  );
  const ended = events.find((e) => e.type === "call_ended");
  const firstSpeech = events.find((e) => e.type === "speech");

  const checks: [string, boolean][] = [
    [
      "opens with the AI and recording disclosure",
      firstSpeech?.type === "speech" && firstSpeech.text === pack.persona.openingLine,
    ],
    [
      `verify_identity succeeded for ${SCENARIO_ACCOUNT}`,
      verified !== undefined &&
        JSON.stringify(verified.input).includes(SCENARIO_ACCOUNT),
    ],
    [
      `check_area_outage returned ${SCENARIO_OUTAGE} after verification`,
      outage !== undefined && verified !== undefined && outage.seq > verified.seq,
    ],
    [
      "ended through end_call with a disposition",
      ended?.type === "call_ended" && ended.reason === "end_call" && ended.disposition !== null,
    ],
  ];

  const total = spans.reduce((sum, s) => sum + s.costNanos, 0);
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ended?.type === "call_ended") {
    console.log(`disposition: ${JSON.stringify(ended.disposition)}`);
    console.log(`pinned to:   ${JSON.stringify(ended.pin)}`);
  }
  console.log(`model calls: ${spans.filter((s) => s.type === "llm_call").length}, cost: ${usd(total)}`);

  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
