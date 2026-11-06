/**
 * Talk to Tala by text in a terminal (#5), as she streams and can be cut off (#6).
 *
 *   npm run chat                      # Sonnet 5.5, the development default
 *   npm run chat -- --model opus      # or haiku
 *
 * Needs ANTHROPIC_API_KEY in .env.local (first-party API only) and spends real
 * credit: a short call costs about 2 cents on Sonnet. Each line you type is one
 * final caller turn, exactly what a voice transport hands the call session
 * once speech-to-text decides the caller has finished.
 *
 * Tala's words print as Claude writes them, and spans print dimmed under each
 * reply so you can see what she did. Type a line and press Enter while she is
 * still talking to interrupt her: she stops there, the call keeps only the
 * words that had printed (what a voice transport would report the caller
 * heard), and your line is the next caller turn. Type /quit or /exit, or press
 * Ctrl+C, to hang up.
 *
 * The terminal stays in its ordinary line mode, never raw mode, so it behaves
 * the same in Windows PowerShell (`npm.cmd run chat`) as in any other shell:
 * you edit your line as usual, and nothing reaches Tala until you press Enter.
 * Words she streams while you type land on the same line as your typing.
 *
 * The test customers are in packages/packs/kidlat-fiber/pack/world.json.
 * Scenario 1: account 8012345601, mobile ending 0101, Batasan Hills.
 */
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
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

const HANG_UP = new Set(["/quit", "/exit"]);

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

  /** Whether a line of Tala's has started printing and not ended yet. */
  let midLine = false;
  const endLine = (): void => {
    if (midLine) stdout.write("\n");
    midLine = false;
  };

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
      case "speech_delta":
        // Every line Tala says arrives as deltas, the fixed lines included.
        if (!midLine) stdout.write(`${bold("Tala:")} `);
        stdout.write(event.text);
        midLine = true;
        return;
      case "speech":
        // The record of the line whose words just printed.
        endLine();
        return;
      case "span":
        endLine();
        spentNanos += event.span.costNanos;
        console.log(describeSpan(event.span));
        return;
      case "interrupted":
        endLine();
        console.log(dim(`   (interrupted: the call keeps ${JSON.stringify(event.heard)})`));
        return;
      case "caller_said":
      case "awaiting_caller":
        return;
      case "call_ended":
        endLine();
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

  // Line mode: `terminal: false` leaves echo and line editing to the terminal
  // itself and never switches it to raw mode, so a line arrives only on Enter,
  // in PowerShell as anywhere else.
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  let closed = false;
  const inputClosed = new Promise<void>((resolve) => {
    rl.once("close", () => {
      closed = true;
      resolve();
    });
  });
  const prompt = (): void => {
    if (!closed && !ended) stdout.write(`${bold("You:")} `);
  };

  /** Tala's turn while it runs. It settles when the turn is over, and never rejects. */
  let turn: Promise<void> | null = null;
  let hangingUp = false;

  const startTurn = (line: string): void => {
    const running: Promise<void> = session
      .callerSaid(line)
      .then(
        (end) => {
          // After an interruption, the line that cut in is already the next turn.
          if (end === "awaiting_caller") prompt();
        },
        (error: unknown) => {
          endLine();
          console.error(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        if (turn === running) turn = null;
        if (ended) rl.close();
      });
    turn = running;
  };

  /** Waits for Tala's running turn, if there is one, to settle. */
  const untilTalaIsDone = async (): Promise<void> => {
    const running = turn;
    if (running !== null) await running;
  };

  /** Stops Tala's running turn where its printing stopped: the default heard. */
  const stopTala = async (): Promise<void> => {
    if (turn === null) return;
    await session.interrupt();
    await untilTalaIsDone();
  };

  const hangUp = async (): Promise<void> => {
    if (hangingUp) return;
    hangingUp = true;
    endLine();
    await stopTala();
    rl.close();
  };

  /** One typed line. Lines are taken one at a time; Tala's turn runs alongside. */
  const handle = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (hangingUp || ended) return;
    if (HANG_UP.has(line)) return hangUp();
    if (line.length === 0) {
      if (turn === null) prompt();
      return;
    }
    // Typed over Tala: she stops, the call keeps what had printed, and this
    // line is the next caller turn.
    await stopTala();
    if (hangingUp || ended) return;
    startTurn(line);
  };

  let lines: Promise<void> = Promise.resolve();
  rl.on("line", (raw) => {
    // Enter has already moved the cursor to a fresh line.
    midLine = false;
    lines = lines
      .then(() => handle(raw))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
  });
  process.once("SIGINT", () => {
    void hangUp();
  });

  session.start();
  prompt();

  await inputClosed;
  // Lines read before the input closed are still taken, and a turn still
  // running finishes: piped input ends that way.
  await lines;
  await untilTalaIsDone();
  endLine();
  console.log(dim(`spent this call: ${usd(spentNanos)}`));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
