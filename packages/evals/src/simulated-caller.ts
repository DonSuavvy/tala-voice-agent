/**
 * The simulated caller (#9): a model playing a case's caller, talking to Tala
 * through the call session and nothing else, the way a person on the phone
 * would. The session says its opening line; then, up to the case's turn cap,
 * the caller speaks, Tala takes her turn, and the caller hears what she said.
 *
 * - **Only Tala ends a call.** The caller has no tools and is told it cannot
 *   hang up. A caller that runs out of turns leaves the call open, and the
 *   case ends `not_ended` (the observation reads that from the missing
 *   `call_ended`).
 * - **The caller's conversation is append-only**, like Tala's own: its turns
 *   go back exactly as the model returned them, thinking blocks included,
 *   because the 5.5 models bind those blocks to the conversation that produced
 *   them. Only the words of a turn are said to Tala.
 * - **A caller that cannot go on stops the case without throwing.** A failed
 *   or refused model call, or a turn with no words, ends the simulation with
 *   the reason, and keeps the events: what Tala already spent is real and the
 *   run has to count it.
 * - **The end of a turn is read from the session's state**, not from the
 *   value `callerSaid` returns, so the turn endings streaming adds (#6) need
 *   nothing here.
 *
 * The caller is called through the same `MessageCreator` seam as Tala, so the
 * unit tests script both sides and the live suite passes the real client.
 */
import {
  costOf,
  createCallSession,
  type AssistantTurn,
  type CallEvent,
  type CallSessionOptions,
  type LogicalModel,
  type MessageCreator,
  type MessageParam,
  type TokenUsage,
} from "@tala/core";

import type { EvalCase } from "./case";

/** The model that plays callers unless a run says otherwise (DESIGN section 11). */
export const DEFAULT_CALLER_MODEL: LogicalModel = "sonnet";

/**
 * Generous on purpose: the 5.5 models think by default and thinking counts
 * against this, so a tight cap could end a turn before the caller says a word.
 * A short line costs the same under any cap. The same figure as Tala's loop.
 */
const CALLER_MAX_TOKENS = 8_192;

/** The caller's instructions, around the case's brief. */
export function callerSystemPrompt(brief: string): string {
  return [
    "You are playing a caller on a phone call to an internet provider's customer " +
      "support hotline, to test the hotline's AI agent. The agent's words come to you " +
      "as the other side of the conversation, and you reply as the caller.",
    "",
    "The caller you play:",
    "<brief>",
    brief.trim(),
    "</brief>",
    "",
    "How to reply:",
    "- Write only the words the caller says aloud: no stage directions, actions, " +
      "narration, quotation marks or notes.",
    "- One turn at a time: say what the caller says next, then stop and let the agent answer.",
    "- Keep it as short as a real caller would on the phone.",
    "- Stay in character, and share what the caller knows the way a real caller " +
      "would, for example when the agent asks for it.",
    "- You cannot hang up or end the call. Only the agent can. When the caller is " +
      "satisfied, say so and say goodbye, then keep answering briefly until the " +
      "agent ends the call.",
  ].join("\n");
}

/** Why the simulation stopped. */
export type CallerStop =
  /** Tala's end_call, or any other way the session ended the call. */
  | "call_ended"
  /** The caller used every turn the case allows; the call is still open. */
  | "turn_cap"
  /** The caller's model call failed, was refused, or said nothing. */
  | "caller_failed";

/** One simulated-caller model call, for the run's cost. */
export interface CallerModelCall {
  /** Null when the call failed before a response came back. */
  usage: TokenUsage | null;
  costNanos: number;
  /** True when priced from a rate card with no verified date. */
  estimated: boolean;
  isError: boolean;
}

export interface SimulatedCall {
  /** Every event the call session emitted, in order. */
  events: CallEvent[];
  stoppedBy: CallerStop;
  /** Why the caller could not go on; null unless `stoppedBy` is caller_failed. */
  callerError: string | null;
  /** Caller turns said to Tala. */
  callerTurns: number;
  callerCalls: CallerModelCall[];
}

export interface SimulatedCallOptions {
  /** The case's caller: its brief and turn cap. */
  caller: EvalCase["caller"];
  /** Everything the call session needs. Its provider also prices the caller. */
  session: Omit<CallSessionOptions, "onEvent">;
  /** How the simulated caller's model is called. */
  callerCreateMessage: MessageCreator;
  callerModel?: LogicalModel;
  /** Each session event as it happens, e.g. for printing a live transcript. */
  onEvent?: (event: CallEvent) => void;
}

/** The words of a turn, as one line. Thinking and other blocks are not said. */
function wordsOf(content: readonly { type: string; text?: unknown }[]): string {
  return content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join(" ")
    .trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSimulatedCall(options: SimulatedCallOptions): Promise<SimulatedCall> {
  const { caller, session: sessionOptions, callerCreateMessage } = options;
  const callerModel = options.callerModel ?? DEFAULT_CALLER_MODEL;
  const provider = sessionOptions.provider;

  const events: CallEvent[] = [];
  const session = createCallSession({
    ...sessionOptions,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });

  const callerCalls: CallerModelCall[] = [];
  const system = callerSystemPrompt(caller.brief);
  const history: MessageParam[] = [];
  let callerTurns = 0;

  /**
   * Everything Tala said since event `from`, as one caller-side turn. Never
   * empty while the call is open: the session speaks before it hands the turn
   * back, and a silent model turn is asked again (FAILURES entry 7).
   */
  const heardSince = (from: number): string =>
    events
      .slice(from)
      .flatMap((e) => (e.type === "speech" ? [e.text.trim()] : []))
      .join(" ");

  const stop = (stoppedBy: CallerStop, callerError: string | null = null): SimulatedCall => ({
    events,
    stoppedBy,
    callerError,
    callerTurns,
    callerCalls,
  });

  session.start();
  history.push({ role: "user", content: heardSince(0) });

  while (callerTurns < caller.maxTurns) {
    let reply: AssistantTurn;
    try {
      reply = await callerCreateMessage({
        model: provider.modelId(callerModel),
        max_tokens: CALLER_MAX_TOKENS,
        system,
        messages: [...history],
        tools: [],
      });
    } catch (error) {
      callerCalls.push({ usage: null, costNanos: 0, estimated: false, isError: true });
      return stop("caller_failed", `the simulated caller's model call failed: ${errorText(error)}`);
    }

    const usage: TokenUsage = {
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
      cacheCreationInputTokens: reply.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: reply.usage.cache_read_input_tokens ?? 0,
    };
    const cost = costOf(provider.rateCard(callerModel), usage);
    callerCalls.push({ usage, costNanos: cost.totalNanos, estimated: cost.estimated, isError: false });

    // Before the content, as in Tala's loop: a refused turn is never said.
    if (reply.stop_reason === "refusal") {
      return stop("caller_failed", "the simulated caller's model refused");
    }
    const line = wordsOf(reply.content);
    if (line.length === 0) return stop("caller_failed", "the simulated caller said nothing");

    history.push({ role: "assistant", content: reply.content });
    const from = events.length;
    await session.callerSaid(line);
    callerTurns += 1;

    if (session.state === "ended") return stop("call_ended");
    history.push({ role: "user", content: heardSince(from) });
  }

  return stop("turn_cap");
}
