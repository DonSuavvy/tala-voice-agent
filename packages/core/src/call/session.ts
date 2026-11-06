/**
 * The call session: Tala's main seam (spec #1, Q39).
 *
 * One session is one phone call. It is created with a company pack, the SOP
 * version that pack carries, a fresh copy of the pack's seed world and a
 * model, and everything that drives Tala drives her through it: unit tests,
 * the terminal chat, the eval suite, the LiveKit worker (#7) and the hand-built
 * voice gateway (#24). It takes final caller turns as text and emits one
 * ordered event stream.
 *
 * What it owns, and why here:
 *
 * - **The opening.** The AI and recording disclosure is the pack's fixed
 *   line, said by the session before Claude is ever called. A disclosure the
 *   model wrote could be skipped, reworded or late; this one cannot.
 * - **Turn ending.** A reply with no tool call is speech, and the turn goes
 *   back to the caller. The call ends only through `end_call`, whose input is
 *   the disposition.
 * - **Call state the model never decides.** Which account was verified lives
 *   here and in the tool context, never inferred from the conversation. The
 *   disposition carries it from the code, not from the model's say-so.
 * - **The pin.** Every call records the pack, SOP version and model it ran
 *   with, on its first and last events.
 * - **The conversation.** Append-only, as the 5.5 models' preserved thinking
 *   requires: nothing already sent is ever edited.
 * - **Streaming and interruption (#6).** Tala's words go out as
 *   `speech_delta` events while Claude writes them. A caller who talks over
 *   her calls `interrupt()`, with what they actually heard: the turn stops,
 *   and the conversation keeps only that much of what she was saying, so the
 *   model's next turn starts from what the caller knows.
 *
 * In-call approvals arrive in #13, whispers and takeover in #14.
 */
import type { BudgetConfig } from "../agent/budget";
import { ESTIMATED_RUN_NANOS } from "../agent/budget";
import { cachedSystem } from "../agent/cache";
import {
  runAgentLoop,
  type AssistantTurn,
  type ContentBlock,
  type MessageCreator,
  type MessageParam,
  type SpanEvent,
  type TextBlock,
} from "../agent/loop";
import type { LogicalModel, Provider } from "../agent/provider";
import { compilePackSop, type CompanyPack } from "../pack/load-pack";
import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import { buildTalaRegistry, type CallData } from "../tools";

import { dispositionSchema, type Disposition } from "./disposition";
import { promptVersion, versionOf } from "./pin";

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a call ran with: enough to explain any decision it made, later (spec
 * user story 43). The SOP version alone is not enough. A policy edit changes
 * both what the tools enforce and the prompt the SOP compiles to, while the
 * SOP version stays the same.
 */
export interface CallPin {
  packId: string;
  sopVersion: string;
  /** The compiled system prompt's version: the same label eval runs use. */
  promptVersion: string;
  /** The version of the policy the tools enforced on this call. */
  policyVersion: string;
  model: LogicalModel;
  /** The id actually sent to the API, e.g. `claude-opus-5-5`. */
  modelId: string;
}

export type CallEndReason = "end_call" | "refused" | "failed" | "budget_refused";

/** One ordered stream per call. Every consumer reads the same events. */
export type CallEvent =
  | { type: "call_started"; callId: string; pin: CallPin; at: Date }
  /**
   * Words Tala says, in order: each text block of a model turn, whole, once
   * the turn has arrived and before its llm_call span. For a turn the caller
   * interrupted, only what they heard. Never for a refused turn. The opening
   * and fallback lines are fixed and arrive as `speech` alone, with no deltas.
   */
  | { type: "speech"; text: string }
  /**
   * A piece of Tala's words as Claude writes them, in order, before that
   * turn's `speech`. A voice speaks these. A refusal can only be seen once
   * the turn is complete, so the deltas of a refused turn were already heard
   * even though its `speech` never comes. None follow an `interrupt()`.
   */
  | { type: "speech_delta"; text: string }
  | { type: "caller_said"; text: string; at: Date }
  | { type: "span"; span: SpanEvent }
  /** Tala's turn is over; the call waits for the caller. */
  | { type: "awaiting_caller" }
  /**
   * The caller talked over Tala and her turn has stopped. `heard` is what
   * they heard of the model turn that was streaming, as `interrupt()` was
   * told it or by default every delta emitted before it was called.
   */
  | { type: "interrupted"; heard: string }
  | {
      type: "call_ended";
      reason: CallEndReason;
      /** `end_call`'s input. Null when the call ended any other way. */
      disposition: Disposition | null;
      /** From the call's own state, never from the model. */
      verifiedAccount: string | null;
      pin: CallPin;
      error: string | null;
      at: Date;
    };

/** How one caller turn ended. */
export type TurnEnd = "awaiting_caller" | "interrupted" | "ended";

export type CallState = "not_started" | "in_progress" | "ended";

/* -------------------------------------------------------------------------- */
/* The session                                                                */
/* -------------------------------------------------------------------------- */

export interface CallSessionOptions {
  pack: CompanyPack;
  model: LogicalModel;
  /** Resolves the logical model to a wire id and a rate card. */
  provider: Provider;
  createMessage: MessageCreator;
  callId: string;
  /** Injected, never the wall clock read directly. Read once at creation as the call's start. */
  clock: () => Date;
  budget: { config: BudgetConfig; spentTodayNanos: number };
  /** What one model call is assumed to cost, for the spend pre-flight. */
  estimatedCallNanos?: number;
  /**
   * Receives every event, in order. If it throws, the call carries on: the
   * rest of the turn is still delivered, the call's state stays consistent,
   * and the first error is rethrown from `start()` or `callerSaid()` once the
   * turn is over. A console whose socket closed must not cost a paid turn.
   */
  onEvent: (event: CallEvent) => void;
}

export interface CallSession {
  readonly pin: CallPin;
  readonly state: CallState;
  /** Says the opening line. Once, before anything else. Never calls Claude. */
  start(): void;
  /**
   * One final caller transcript. Resolves when Tala's turn is over. Refused
   * while a turn is still running: a caller who talks over Tala calls
   * `interrupt()` first.
   */
  callerSaid(text: string): Promise<TurnEnd>;
  /**
   * The caller talked over Tala. Stops her running turn and resolves once it
   * has settled, when the next `callerSaid()` is taken at once.
   *
   * `heard` is what the caller actually heard of the model turn now
   * streaming. It defaults to every `speech_delta` emitted in that turn
   * before this call, and must be a prefix of them, surrounding whitespace
   * aside; anything else is rejected and the turn runs on. The conversation
   * keeps only the heard part of that turn. A turn whose tools are already
   * running keeps the words it streamed: its tools may have acted, so
   * nothing in it is cut, and `heard` is only reported.
   *
   * Does nothing when no turn is running.
   */
  interrupt(heard?: string): Promise<void>;
}

/**
 * The first user message. The API needs the conversation to open with a user
 * turn, and the opening line is Tala's; this says, truthfully, what happened
 * before she spoke.
 */
const CALL_CONNECTED = "(The call has connected. The caller has not spoken yet.)";

function isSpokenText(block: ContentBlock): block is TextBlock {
  return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
}

/** A caller turn in progress, and how it is being stopped, if it is. */
interface RunningTurn {
  controller: AbortController;
  /**
   * Set by `interrupt()`: what the caller heard, and of which model call.
   * `modelCall` is null when no model call was streaming then.
   */
  interruption: { heard: string; modelCall: number | null } | null;
  /** Resolves once the turn is over and the next caller turn can be taken. */
  settled: Promise<void>;
}

/** Whether `heard` is how `said` began, surrounding whitespace aside. */
function isHeardPrefix(heard: string, said: string): boolean {
  return said.trimStart().startsWith(heard.trim());
}

/**
 * A model turn the caller talked over, kept only as far as they heard it.
 *
 * Text blocks are kept while `heard` covers them. Where it stops inside a
 * text block, that block is cut there and every block after it is dropped:
 * thinking, text and tool calls alike. A signed thinking block binds
 * everything before it, so one must never follow text that was cut; and a
 * tool call Tala never got to announce has not run, so it goes with the words.
 * Blocks after text heard in full stay as they came, and the loop answers any
 * tool call among them "Not run".
 */
function keepHeard(content: ContentBlock[], heard: string): ContentBlock[] {
  let rest = heard.trim();
  const kept: ContentBlock[] = [];

  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      kept.push(block);
      continue;
    }
    const text = block.text;
    const body = text.trim();
    rest = rest.trimStart();

    const heardInFull = body === "" ? rest !== "" : rest.startsWith(body);
    if (heardInFull) {
      kept.push(block);
      rest = rest.slice(body.length);
      continue;
    }

    // The cut falls in this block. Whatever of it was heard stays.
    if (rest !== "" && body.startsWith(rest)) {
      const lead = text.length - text.trimStart().length;
      kept.push({ ...block, text: text.slice(0, lead + rest.length) });
    }
    break;
  }
  return kept;
}

export function createCallSession(options: CallSessionOptions): CallSession {
  const { pack, model, provider, createMessage, callId, clock } = options;

  const registry = buildTalaRegistry();
  // Compiled once and pinned: the same bytes on every request, so the
  // tools + system prefix caches, and a mid-call policy edit cannot reach a
  // call already running.
  const system = cachedSystem(compilePackSop(pack));
  const pin: CallPin = {
    packId: pack.id,
    sopVersion: pack.sop.version,
    promptVersion: promptVersion(system),
    // The parsed policy's keys come out in schema order, so the same policy
    // always serializes, and therefore versions, the same way.
    policyVersion: versionOf(JSON.stringify(pack.policy)),
    model,
    modelId: provider.modelId(model),
  };
  const startedAt = clock();

  let subscriberError: Error | null = null;
  /** Every event goes through here, so a throwing subscriber cannot unwind the call. */
  const onEvent = (event: CallEvent): void => {
    try {
      options.onEvent(event);
    } catch (error) {
      subscriberError ??= error instanceof Error ? error : new Error(String(error));
    }
  };
  /** Called once a turn's state is settled: the subscriber learns it failed. */
  const rethrowSubscriberError = (): void => {
    if (subscriberError === null) return;
    const error = subscriberError;
    subscriberError = null;
    throw error;
  };
  const data: CallData = {
    systems: createInMemorySystems(pack.world, startedAt),
    identity: initialIdentityState(),
    company: { timeZone: pack.company.timeZone, locale: pack.company.locale },
  };

  let history: MessageParam[] = [];
  let state: CallState = "not_started";
  let nextSeq = 0;
  let spentNanos = 0;

  /** The caller turn now running, if any. */
  let running: RunningTurn | null = null;
  /** The deltas emitted for the model call now streaming, or the last one. */
  let streamed: string[] = [];
  let modelCalls = 0;
  /** The model call now streaming, by number, or null between calls. */
  let streaming: number | null = null;

  /**
   * Deltas go out as Claude writes them, through the same wrapper as every
   * event: a subscriber that throws is held, not let loose inside the stream.
   * After `interrupt()` none go out, though a few may still arrive.
   */
  const onTextDelta = (text: string): void => {
    if (running?.interruption) return;
    streamed.push(text);
    onEvent({ type: "speech_delta", text });
  };

  /**
   * Speech is what each model turn says, emitted as the turn arrives and
   * before its tools run, as a caller would hear it. A refused turn is never
   * spoken: the model declined to stand behind it.
   *
   * A turn the caller talked over is cut to what they heard here, before the
   * loop sees it, so the loop never holds a tool call that was dropped.
   */
  const speakingCreator: MessageCreator = async (params, callOptions) => {
    const thisCall = ++modelCalls;
    streamed = [];
    streaming = thisCall;
    let turn: AssistantTurn;
    try {
      turn = await createMessage(params, callOptions);
    } finally {
      streaming = null;
    }

    const interruption = running?.interruption;
    if (interruption && interruption.modelCall === thisCall) {
      turn = { ...turn, content: keepHeard(turn.content, interruption.heard) };
    }

    if (turn.stop_reason !== "refusal") {
      for (const block of turn.content) {
        if (isSpokenText(block)) onEvent({ type: "speech", text: block.text });
      }
    }
    return turn;
  };

  const end = (reason: CallEndReason, disposition: Disposition | null, error: string | null): TurnEnd => {
    state = "ended";
    onEvent({
      type: "call_ended",
      reason,
      disposition,
      verifiedAccount: data.identity.verifiedAccount,
      pin,
      error,
      at: clock(),
    });
    return "ended";
  };

  /** Anything but end_call ends with the pack's apology, never with silence. */
  const endBadly = (reason: Exclude<CallEndReason, "end_call">, error: string | null): TurnEnd => {
    onEvent({ type: "speech", text: pack.persona.fallbackLine });
    return end(reason, null, error);
  };

  return {
    pin,
    get state() {
      return state;
    },

    start() {
      if (state !== "not_started") {
        throw new Error("call session: start() was already called for this call");
      }
      state = "in_progress";
      onEvent({ type: "call_started", callId, pin, at: startedAt });
      history = [
        { role: "user", content: CALL_CONNECTED },
        { role: "assistant", content: [{ type: "text", text: pack.persona.openingLine }] },
      ];
      onEvent({ type: "speech", text: pack.persona.openingLine });
      onEvent({ type: "awaiting_caller" });
      rethrowSubscriberError();
    },

    async callerSaid(text) {
      if (state === "not_started") {
        throw new Error("call session: the call has not started; call start() first");
      }
      if (state === "ended") throw new Error("call session: the call has ended");
      // A caller who talks over Tala interrupts her first; then this is taken.
      if (running) throw new Error("call session: Tala's turn is still running");
      const words = text.trim();
      if (words.length === 0) throw new Error("call session: a caller turn needs words");

      // Set before anything runs, so a subscriber can interrupt from the
      // turn's very first event.
      let settle: () => void = () => {};
      const turn: RunningTurn = {
        controller: new AbortController(),
        interruption: null,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
      };
      running = turn;
      try {
        const ended = await runTurn(words, turn);
        // Only now, with the turn's events delivered and the call's state
        // settled, does a failing subscriber hear about it.
        rethrowSubscriberError();
        return ended;
      } finally {
        running = null;
        settle();
      }
    },

    async interrupt(heard) {
      const turn = running;
      if (turn === null) return;

      if (turn.interruption === null) {
        const said = streamed.join("");
        const kept = heard ?? said;
        if (!isHeardPrefix(kept, said)) {
          throw new Error(
            `call session: heard ${JSON.stringify(kept)} is not a prefix of what Tala ` +
              `has said in this turn (${JSON.stringify(said)})`,
          );
        }
        turn.interruption = { heard: kept, modelCall: streaming };
        turn.controller.abort();
      }
      await turn.settled;
    },
  };

  /** One caller turn through the agent loop, to its end. */
  async function runTurn(words: string, turn: RunningTurn): Promise<TurnEnd> {
    // Nothing of this turn has been said yet, whatever the last one said.
    streamed = [];
    const now = clock();
    onEvent({ type: "caller_said", text: words, at: now });

    const result = await runAgentLoop({
      registry,
      createMessage: speakingCreator,
      model: pin.modelId,
      rates: provider.rateCard(model),
      system,
      messages: [...history, { role: "user", content: words }],
      toolContext: {
        workspaceId: pack.id,
        runId: callId,
        callId,
        now,
        data,
        policyConfig: pack.policy,
      },
      budget: {
        config: options.budget.config,
        spentTodayNanos: options.budget.spentTodayNanos + spentNanos,
      },
      estimatedCallNanos: options.estimatedCallNanos ?? ESTIMATED_RUN_NANOS,
      // One call is one span sequence, however many caller turns it has.
      startSeq: nextSeq,
      clock,
      emit: (span) => {
        nextSeq = span.seq + 1;
        onEvent({ type: "span", span });
      },
      signal: turn.controller.signal,
      onTextDelta,
    });

    spentNanos += result.costNanos;
    // The loop returns the conversation it was given plus what it appended.
    // Nothing earlier is rewritten.
    history = result.messages;

    switch (result.status) {
      case "awaiting_caller":
        onEvent({ type: "awaiting_caller" });
        return "awaiting_caller";
      case "interrupted":
        // The conversation already holds only what the caller heard. The
        // call stays open: their next words are the next caller turn.
        onEvent({ type: "interrupted", heard: turn.interruption?.heard ?? "" });
        return "interrupted";
      case "completed":
        // The loop parsed this with end_call's own schema already; parsing
        // again turns `unknown` into a type without a cast.
        return end("end_call", dispositionSchema.parse(result.outcome), null);
      case "refused":
      case "failed":
      case "budget_refused":
        return endBadly(result.status, result.error);
      case "paused_for_approval":
        // No tool in #5 is confirm-write, so nothing can pause. In-call
        // approvals are #13; until then a pause is a bug, said plainly.
        return endBadly(
          "failed",
          `call session: ${result.pendingApproval?.toolName ?? "a tool"} paused for ` +
            `approval, and in-call approvals are not built yet (#13)`,
        );
      default:
        return result.status satisfies never;
    }
  }
}
