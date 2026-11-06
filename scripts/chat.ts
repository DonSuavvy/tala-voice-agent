/**
 * Talk to Tala by text in a terminal (#5).
 *
 *   npm run chat                      # Sonnet 5.5, the development default
 *   npm run chat -- --model opus      # or haiku
 *
 * Needs ANTHROPIC_API_KEY in .env.local (first-party API only) and spends real
 * credit: a short call costs about 2 cents on Sonnet. Each line you type is one
 * final caller turn, exactly what a voice transport hands the call session
 * once speech-to-text decides the caller has finished. Spans print dimmed
 * under each reply so you can see what Tala did. Type /quit to hang up.
 *
 * The test customers are in packages/packs/kidlat-fiber/pack/world.json.
 * Scenario 1: account 8012345601, mobile ending 0101, Batasan Hills.
 */
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
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

/**
 * A per-run cap for this script, not the demo's daily budget. Nothing here
 * keeps a spend ledger yet (#22), so the guard counts only this run's spend.
 */
const CHAT_CAP_USD = 0.5;

const MODELS: readonly LogicalModel[] = ["haiku", "sonnet", "opus"];

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function loadEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fine when the key is already exported; providerFromEnv says if not.
  }
}

function parseModel(): LogicalModel {
  const { values } = parseArgs({
    options: { model: { type: "string", default: "sonnet" } },
  });
  const model = values.model as LogicalModel;
  if (!MODELS.includes(model)) {
    throw new Error(`--model must be one of ${MODELS.join(", ")} (got "${values.model}")`);
  }
  return model;
}

function usd(nanos: number): string {
  return `$${microsToUsdString(nanosToMicros(nanos))}`;
}

function describeSpan(span: SpanEvent): string {
  const mark = span.isError ? "✗" : "·";
  const cost = span.costNanos > 0 ? ` ${usd(span.costNanos)}` : "";
  const detail = span.isError
    ? ` ${JSON.stringify(span.output)}`
    : span.type === "llm_call"
      ? ` ${JSON.stringify(span.output)}`
      : "";
  return dim(`   ${mark} ${span.type} ${span.name} ${span.latencyMs}ms${cost}${detail}`);
}

async function main(): Promise<void> {
  loadEnv();
  const model = parseModel();
  const provider = providerFromEnv(process.env);
  const client = createClient(process.env);
  const pack = loadKidlatFiber();

  let spentNanos = 0;
  let ended = false;

  const onEvent = (event: CallEvent): void => {
    switch (event.type) {
      case "call_started":
        console.log(
          dim(
            `call ${event.callId} · ${event.pin.packId} SOP ${event.pin.sopVersion} · ` +
              `${event.pin.model} (${provider.modelId(event.pin.model)})`,
          ),
        );
        return;
      case "speech":
        console.log(`${bold("Tala:")} ${event.text}`);
        return;
      case "span":
        spentNanos += event.span.costNanos;
        console.log(describeSpan(event.span));
        return;
      case "caller_said":
      case "awaiting_caller":
        return;
      case "call_ended":
        ended = true;
        console.log(dim(`call ended: ${event.reason}`));
        if (event.disposition) console.log(dim(JSON.stringify(event.disposition, null, 2)));
        if (event.error) console.log(dim(`error: ${event.error}`));
        return;
      default:
        event satisfies never;
    }
  };

  const session = createCallSession({
    pack,
    model,
    provider,
    createMessage: streamingMessageCreator(client),
    callId: randomUUID(),
    clock: () => new Date(),
    budget: {
      config: {
        dailyCapNanos: CHAT_CAP_USD * 1_000_000_000,
        killSwitch: false,
        runsPerMinute: 10,
      },
      spentTodayNanos: 0,
    },
    estimatedCallNanos: ESTIMATED_RUN_NANOS,
    onEvent,
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    session.start();
    while (!ended) {
      const line = (await rl.question(`${bold("You:")} `)).trim();
      if (line === "/quit") break;
      if (line.length === 0) continue;
      await session.callerSaid(line);
    }
  } finally {
    rl.close();
    console.log(dim(`spent this call: ${usd(spentNanos)}`));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
