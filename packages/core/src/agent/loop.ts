/**
 * The hand-rolled agent loop.
 *
 * Imported from OpsPilot (commit 83b5414), where it ran support tickets.
 *
 * **Why this is not the SDK's tool runner.** Pause/resume means serializing
 * the message array *mid-loop* and rebuilding it later, which the SDK runner
 * does not expose. In OpsPilot that carried a paused run across serverless
 * invocations to a human's approval; in Tala the same mechanism holds a call
 * while a supervisor approves a credit (#13).
 *
 * **The client is an interface, not a client.** The loop depends on
 * `MessageCreator` — `(params, options?) => Promise<AssistantTurn>` — and
 * nothing else.
 * The production adapter streams from the Anthropic API and returns the SDK's
 * assembled final message; the tests hand it scripted turns. Two things fall out of that
 * split. `npm test` needs no API key, and the four-field `usage` object is
 * assembled by the SDK rather than by hand — on the streaming path those
 * counts arrive across several event types, and reassembling them manually is
 * how a run silently books zero cache cost.
 *
 * **What the loop owns.** Ordering and refusal handling, the per-call spend
 * pre-flight, tool dispatch and error containment, the approval pause, the
 * span stream, and how a turn ends. A reply the caller can hear hands the
 * turn back to them; a silent one is dropped and the model asked again,
 * because dead air is not an answer. The terminal tool completes the run only
 * as the sole call in its turn, so nothing runs after the outcome is decided
 * and no result is cut off before the caller hears it. A caller who talks
 * over Tala ends the turn `interrupted` at the next safe point: what can stay
 * in the conversation stays, every tool call not run is answered "Not run",
 * and the call is booked at no less than its estimate. What it does not own:
 * the database, HTTP, the wall clock, or pricing. Those arrive as arguments,
 * which is what keeps this testable without a database and deterministic in
 * the eval suite.
 */
import { checkBudget, type BudgetConfig, type BudgetRefusal } from "./budget";
import type { SystemBlock } from "./cache";
import {
  costOf,
  type CacheTtl,
  type RateCard,
  type TokenUsage,
} from "./cost";
import {
  ToolRegistryError,
  type ToolContext,
  type ToolRegistry,
} from "./registry";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Deliberately open at the end. Thinking blocks — and whatever the API adds
 * next — must round-trip back to the model byte-identical, so the loop copies
 * assistant content wholesale rather than reconstructing the blocks it knows.
 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/**
 * The subset of the Anthropic `Message` this loop reads. The SDK's type
 * satisfies it structurally, so the production adapter is a pass-through and
 * the tests can build one in four lines.
 */
export interface AssistantTurn {
  content: ContentBlock[];
  /**
   * The API's stop reason, or Tala's own `"interrupted"`: the caller cut the
   * turn short, and `content` is what had streamed by then. The API never
   * sends `"interrupted"`, and it is never sent back to it.
   */
  stop_reason: "interrupted" | (string & {}) | null;
  /**
   * Populated *only* on a refusal — and nullable even then, which is why the
   * loop branches on `stop_reason` and treats this as detail rather than
   * signal. `if (stop_details)` is the wrong test and misses refusals.
   */
  stop_details?: { type: string; category?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  /**
   * A bare string, or blocks when the prefix is marked cacheable.
   *
   * Both shapes reach the API unchanged; the loop never inspects or rebuilds
   * this. Prompt caching is a byte-level prefix match, so anything that
   * normalised the text in passing would change the cache key and drop the hit
   * rate for a reason nothing in the trace would explain.
   */
  system: string | SystemBlock[];
  messages: MessageParam[];
  tools: unknown[];
}

/** What a model call can be given besides its request. Both are optional. */
export interface MessageCreatorOptions {
  /**
   * Aborting it stops the turn. The creator then resolves, rather than
   * throws, with what had streamed, marked `stop_reason: "interrupted"`.
   */
  signal?: AbortSignal;
  /** Each piece of text as it streams, in order. Thinking is never passed. */
  onTextDelta?: (text: string) => void;
}

export type MessageCreator = (
  params: MessageCreateParams,
  options?: MessageCreatorOptions,
) => Promise<AssistantTurn>;

/* -------------------------------------------------------------------------- */
/* Spans                                                                      */
/* -------------------------------------------------------------------------- */

export type SpanType = "llm_call" | "tool_exec" | "guardrail" | "approval_wait";

/**
 * One row of the flight recorder. Emitted as it happens rather than collected
 * at the end, so a live view and a database writer can share one code path,
 * and a run that dies halfway still has its spans.
 */
export interface SpanEvent {
  seq: number;
  type: SpanType;
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  usage: TokenUsage | null;
  costNanos: number;
  /** True when priced from a rate card with no `verifiedOn` date. */
  estimated: boolean;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Input and result                                                           */
/* -------------------------------------------------------------------------- */

export interface AgentLoopInput<C extends ToolContext = ToolContext> {
  registry: ToolRegistry<C>;
  createMessage: MessageCreator;
  /** The provider's wire id. Logical names are resolved in provider.ts. */
  model: string;
  rates: RateCard;
  /** Pass `cachedSystem(prompt)` to mark the prefix cacheable. */
  system: string | SystemBlock[];
  messages: MessageParam[];
  toolContext: C;
  budget: { config: BudgetConfig; spentTodayNanos: number };
  /**
   * What one model call is assumed to cost, for the pre-flight only. A guard
   * can only refuse *before* the spend, and the true cost is unknowable until
   * after — so the caller supplies an estimate and the loop reconciles with
   * the real figure once the turn returns.
   */
  estimatedCallNanos: number;
  maxIterations?: number;
  maxTokens?: number;
  cacheTtl?: CacheTtl;
  /**
   * Whether to ask the provider for constrained decoding.
   *
   * Defaults to **off**, as OpsPilot shipped it: there, Amazon Bedrock
   * rejected a nine-tool set with `400 Compiled grammar size (329.9MB)
   * exceeds maximum allowed size (300MB)`. Tala calls the first-party API
   * only, where the limit for its seventeen tools has not been measured, so
   * the default stays off until it is.
   *
   * Nothing is weakened by leaving it off. The wire schema constrains the
   * model; Zod constrains reality. Every tool call is parsed with the tool's
   * own schema below, before its handler sees it.
   */
  strictTools?: boolean;
  /**
   * Where this invocation's span numbering starts. Defaults to 0.
   *
   * A resumed run keeps its original run id so a trace renders as one
   * continuous waterfall, and spans are unique on `(run id, seq)`. A second
   * invocation numbering from zero would collide with the spans the paused
   * one already wrote.
   */
  startSeq?: number;
  /**
   * Every decided approval for this run, keyed by tool_use id. Set only when
   * resuming a paused run.
   *
   * When non-empty, the loop's first iteration re-processes the trailing
   * assistant turn already on `messages` instead of calling the model — that
   * turn was paid for by the invocation that paused, and re-asking would both
   * double-bill and risk returning a *different* turn to the one the human
   * actually answered. A call with a decision is dispatched (approved) or
   * answered with `is_error` (denied) instead of pausing again.
   *
   * A list rather than one decision because a single turn may carry more than
   * one confirm-write call. Each pause decides one; carrying only the latest
   * would lose the earlier answers and the turn could never clear.
   */
  resumeDecisions?: ResumeDecision[] | null;
  /** Injected like `now` everywhere else here — never `Date.now()`. */
  clock: () => Date;
  emit: (span: SpanEvent) => void | Promise<void>;
  /**
   * Aborted when the caller talks over Tala. Passed to every model call, and
   * checked again before each tool runs and before the next model call. The
   * run then ends `interrupted`: see the loop's handling below.
   */
  signal?: AbortSignal;
  /**
   * Each piece of Tala's text as the model writes it, passed to every model
   * call. Like `emit`, it must not throw: the creator calls it from inside
   * the stream, where a throw fails a call that was paid for. The call
   * session routes it through the one wrapper that holds a subscriber's
   * error until the turn is booked.
   */
  onTextDelta?: (text: string) => void;
}

/** The human's answer, carried from the approvals row into a resumed loop. */
export interface ResumeDecision {
  /** Anthropic's tool_use id for the paused call. */
  toolUseId: string;
  approved: boolean;
  /** On denial, injected back as the `is_error` body so the agent can adapt. */
  reason: string | null;
}

/**
 * Every way one loop invocation can end, as a value as well as a type.
 *
 * A value because the eval case schema validates against it at runtime. It
 * used to keep its own copy, and the `satisfies` meant to keep the two in step
 * never could: it checked each copied status existed, not that each status
 * was copied (Tala FAILURES entry 6). One list, read by both, cannot drift.
 */
export const AGENT_LOOP_STATUSES = [
  "completed",
  "awaiting_caller",
  "interrupted",
  "paused_for_approval",
  "refused",
  "failed",
  "budget_refused",
] as const;

export type AgentLoopStatus = (typeof AGENT_LOOP_STATUSES)[number];

export interface AgentLoopResult {
  status: AgentLoopStatus;
  /** The terminal tool's structured input. Null unless status is completed. */
  outcome: unknown;
  iterations: number;
  usage: TokenUsage;
  costNanos: number;
  estimated: boolean;
  messages: MessageParam[];
  /** Set on pause: what a resume rebuilds the conversation from. */
  serializedMessages: string | null;
  pendingApproval: {
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
  } | null;
  refusal: { category: string | null } | null;
  budgetReason: BudgetRefusal | null;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * OpsPilot's loop guard, now per caller turn: the most model calls one thing
 * the caller says can trigger. Twelve was generous for OpsPilot's tickets and
 * is more so for a turn, which rarely needs more than three.
 */
const DEFAULT_MAX_ITERATIONS = 12;

/**
 * Well under the 5.5 models' 128K output ceiling: headroom without inviting
 * essays. A spoken reply is a few sentences.
 */
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * What the model is told after a turn with nothing to hear and no tool call.
 * It stands in for the dropped turn, so the next request ends on a user
 * message and the model knows why it is being asked again.
 */
export const SILENT_TURN_NOTICE =
  "(The caller heard nothing. Answer them out loud, or call a tool.)";

/**
 * The result of every tool call the loop did not run because the caller
 * interrupted. Each tool_use needs a tool_result in the next user message, or
 * the API rejects the next request; this one tells the model why.
 */
export const NOT_RUN_INTERRUPTED = "Not run: the caller interrupted.";

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * The wire-shaped equivalent, for the synthesized turn a resume replays. Its
 * cost was already recorded by the invocation that paused, so counting it
 * again would inflate the run's totals by one turn per resume.
 */
const EMPTY_TURN_USAGE: AssistantTurn["usage"] = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function toTokenUsage(u: AssistantTurn["usage"]): TokenUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

/** Text the caller would actually hear. Whitespace is dead air. */
function isSpoken(block: ContentBlock): boolean {
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim() !== ""
  );
}

/**
 * Tool results go back as strings. `undefined` is not JSON, and a handler that
 * returns nothing is a successful call — reporting it as `"null"` rather than
 * dropping the block keeps the tool_use/tool_result pairing intact, which the
 * API requires.
 */
function stringifyResult(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return json ?? "null";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAgentLoop<C extends ToolContext>(
  input: AgentLoopInput<C>,
): Promise<AgentLoopResult> {
  const {
    registry,
    createMessage,
    model,
    rates,
    system,
    toolContext,
    budget,
    estimatedCallNanos,
    clock,
    emit,
    signal,
    onTextDelta,
  } = input;

  const callerInterrupted = (): boolean => signal?.aborted === true;

  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const tools = registry.toAnthropicTools({
    strict: input.strictTools ?? false,
  });
  const rateVerified = rates.verifiedOn !== null;

  const messages: MessageParam[] = [...input.messages];
  const decisions = new Map(
    (input.resumeDecisions ?? []).map((d) => [d.toolUseId, d] as const),
  );
  let seq = input.startSeq ?? 0;
  let iterations = 0;
  let accruedNanos = 0;
  let totals: TokenUsage = { ...EMPTY_USAGE };
  let estimated = false;

  const base = () => ({
    iterations,
    usage: totals,
    costNanos: accruedNanos,
    estimated,
    messages,
    outcome: null,
    serializedMessages: null,
    pendingApproval: null,
    refusal: null,
    budgetReason: null,
    error: null,
  });

  const span = async (
    s: Omit<SpanEvent, "seq" | "startedAt" | "endedAt" | "latencyMs"> & {
      startedAt: Date;
    },
  ) => {
    const endedAt = clock();
    await emit({
      ...s,
      seq: seq++,
      endedAt,
      latencyMs: endedAt.getTime() - s.startedAt.getTime(),
    });
  };

  /**
   * The answer to a tool call the caller's interruption stopped from running.
   * Its span says so, as a span does for every other call refused a run.
   */
  const notRun = async (call: ToolUseBlock): Promise<ToolResultBlock> => {
    await span({
      type: "tool_exec",
      name: call.name,
      input: call.input,
      output: { error: NOT_RUN_INTERRUPTED },
      isError: true,
      usage: null,
      costNanos: 0,
      estimated,
      startedAt: clock(),
    });
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: NOT_RUN_INTERRUPTED,
      is_error: true,
    };
  };

  /**
   * The first call in a turn that needs a human and has no answer yet, or null
   * if the whole turn can be dispatched.
   *
   * Calls whose arguments their own schema rejects, and calls whose preflight
   * throws, deliberately return null: those are answered with `is_error` in
   * the dispatch loop rather than queued for a person. Both checks are pure,
   * so running them again there costs nothing and keeps every span emitted
   * from a single place.
   */
  const firstCallAwaitingApproval = async (
    calls: ToolUseBlock[],
  ): Promise<ToolUseBlock | null> => {
    for (const call of calls) {
      if (decisions.has(call.id)) continue;

      const definition = registry.get(call.name);
      if (!definition) continue;

      let needsApproval: boolean;
      try {
        needsApproval = registry.requiresApproval(call.name);
      } catch {
        continue;
      }
      if (!needsApproval) continue;

      const parsed = definition.input.safeParse(call.input);
      if (!parsed.success) continue;

      if (definition.preflight) {
        try {
          await definition.preflight(parsed.data, toolContext);
        } catch {
          continue;
        }
      }

      return call;
    }
    return null;
  };

  /**
   * On resume, the turn to process is already on `messages` — the paused
   * invocation pushed it before returning. Re-processing it instead of asking
   * for a new one is the whole point: that turn is what the human answered.
   */
  let pendingContent: ContentBlock[] | null = null;
  if (decisions.size > 0) {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || !Array.isArray(last.content)) {
      return {
        ...base(),
        status: "failed",
        error:
          "resume: serialized messages do not end with an assistant turn — " +
          "nothing to apply the approval decision to",
      };
    }
    pendingContent = last.content;
  }

  while (iterations < maxIterations) {
    // The caller is already talking, so no model call starts. A resumed turn
    // is the exception: it is already on `messages` and still owes every call
    // a result, which the dispatch below gives as "Not run".
    if (pendingContent === null && callerInterrupted()) {
      return { ...base(), status: "interrupted" };
    }

    // Pre-flight, every call, against the baseline *plus* what this run has
    // already spent. Checking once at the top from a figure read before the
    // loop started would let twelve iterations spend twelve times the amount
    // the run was cleared for.
    const decision = checkBudget({
      spentTodayNanos: budget.spentTodayNanos + accruedNanos,
      estimatedRunNanos: estimatedCallNanos,
      rateVerified,
      config: budget.config,
    });

    if (!decision.allowed) {
      const startedAt = clock();
      await span({
        type: "guardrail",
        name: "budget",
        input: {
          spentTodayNanos: budget.spentTodayNanos + accruedNanos,
          estimatedCallNanos,
          rateVerified,
        },
        output: decision,
        isError: true,
        usage: null,
        costNanos: 0,
        estimated,
        startedAt,
      });
      return {
        ...base(),
        status: "budget_refused",
        budgetReason: decision.reason,
        error: `budget: refused (${decision.reason})`,
      };
    }

    iterations += 1;

    /**
     * The resumed turn is already on `messages`, already billed, and already
     * answered by a human — so it is taken as-is rather than re-requested.
     * Asking again would double-bill it and could return a *different* turn,
     * which is not the one the human approved.
     */
    let assistant: AssistantTurn;

    if (pendingContent) {
      assistant = {
        content: pendingContent,
        stop_reason: "tool_use",
        stop_details: null,
        // Zeroed on purpose: the invocation that paused recorded this turn's
        // usage and cost on its own llm_call span. Counting it again here
        // would inflate the run's totals by one turn per resume.
        usage: { ...EMPTY_TURN_USAGE },
      };
      pendingContent = null;
    } else {
      const llmStartedAt = clock();
      try {
        assistant = await createMessage(
          {
            model,
            max_tokens: maxTokens,
            system,
            messages,
            tools,
          },
          { signal, onTextDelta },
        );
      } catch (error) {
        await span({
          type: "llm_call",
          name: model,
          input: { messages: messages.length },
          output: { error: errorText(error) },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt: llmStartedAt,
        });
        return { ...base(), status: "failed", error: errorText(error) };
      }

      const turnUsage = toTokenUsage(assistant.usage);
      const cost = costOf(rates, turnUsage, { cacheTtl: input.cacheTtl });
      const cutShort = assistant.stop_reason === "interrupted";
      // A turn the caller cut short reports only what had streamed by then,
      // which undercounts its output. The pre-flight estimate is the floor,
      // so an interruption can never book less than the guard assumed, and
      // the figure is marked estimated whichever way it went.
      const callNanos = cutShort
        ? Math.max(cost.totalNanos, estimatedCallNanos)
        : cost.totalNanos;
      const callEstimated = cutShort || cost.estimated;
      totals = addUsage(totals, turnUsage);
      accruedNanos += callNanos;
      estimated = estimated || callEstimated;

      await span({
        type: "llm_call",
        name: model,
        input: { messages: messages.length },
        output: {
          stop_reason: assistant.stop_reason,
          blocks: assistant.content.map((b) => b.type),
        },
        isError: false,
        usage: turnUsage,
        costNanos: callNanos,
        estimated: callEstimated,
        startedAt: llmStartedAt,
      });

      // Before `content`, never after. A refused turn can still carry a
      // tool_use block, and a loop that inspected content first would fire a
      // tool off a response the model declined to stand behind.
      if (assistant.stop_reason === "refusal") {
        return {
          ...base(),
          status: "refused",
          refusal: { category: assistant.stop_details?.category ?? null },
          error: "model refused the request",
        };
      }

      // What streamed before the caller talked over Tala. It stays only if
      // it holds something to keep: words she said, or a finished tool call.
      // A thinking block alone is dropped, and since it was never sent back
      // that edits nothing the model has seen. No tool runs, and every call
      // in the turn is answered, so the next request is valid.
      if (cutShort) {
        const calls = assistant.content.filter(isToolUse);
        if (calls.length > 0 || assistant.content.some(isSpoken)) {
          messages.push({ role: "assistant", content: assistant.content });
        }
        if (calls.length > 0) {
          const results: ToolResultBlock[] = [];
          for (const call of calls) results.push(await notRun(call));
          messages.push({ role: "user", content: results });
        }
        return { ...base(), status: "interrupted" };
      }

      messages.push({ role: "assistant", content: assistant.content });
    }

    const toolUses = assistant.content.filter(isToolUse);

    if (toolUses.length === 0) {
      // No tool call and nothing to hear (empty, thinking only, or blank
      // text) is silence, not a reply: handing it back would leave the caller
      // waiting on dead air. The turn is dropped rather than kept, because
      // the Messages API rejects an empty assistant message anywhere but last
      // and keeping it would fail the next request. It was never sent back,
      // so dropping it edits nothing the model has seen; its llm_call span
      // and cost stand. The notice counts toward maxIterations, so a model
      // that stays silent ends at the cap.
      // A caller who has started talking is not asked to wait for another
      // try, so an interrupted silent turn is dropped with no notice.
      if (!assistant.content.some(isSpoken)) {
        messages.pop();
        if (callerInterrupted()) return { ...base(), status: "interrupted" };
        messages.push({ role: "user", content: SILENT_TURN_NOTICE });
        continue;
      }
      // On a call, a reply with no tool call is Tala speaking and then
      // listening, so the turn goes back to the caller. OpsPilot nudged the
      // model to keep going here, because a ticket had no one to wait for.
      // A *call* still ends only through the terminal tool: the call session
      // keeps it open until `end_call` runs. If the caller talked over the
      // reply, the turn ends `interrupted` instead, so the call session can
      // keep only what they heard.
      return {
        ...base(),
        status: callerInterrupted() ? "interrupted" : "awaiting_caller",
      };
    }

    /**
     * Pause before *anything* in this turn is dispatched.
     *
     * OpsPilot FAILURES #23: the pause used to fire mid-dispatch, so a read earlier in
     * the same turn had already run — its handler fired, its `tool_exec` span
     * was persisted — and then the pause returned, discarding the local
     * results array it had written into. The trace claimed a tool ran while
     * the serialized conversation had no record of it, and resume rebuilt an
     * assistant turn whose tool_use had no matching tool_result, which the API
     * rejects.
     *
     * Deciding it up front keeps the contract resume depends on trivial:
     * `serializedMessages` is exactly `[...history, assistant]`, so resume
     * appends one user message with a result for every tool_use in that turn.
     *
     * Validation and preflight still run first (OpsPilot FAILURES #22) — nobody should
     * be interrupted to approve a call its own schema rejects, or one the
     * policy engine was always going to refuse. Both are pure, so running them
     * again below when we do *not* pause is free and keeps span emission in
     * one place.
     */
    // Nobody is asked to approve a call the caller has already talked over:
    // the dispatch below answers it "Not run" with the rest.
    const awaiting = callerInterrupted()
      ? null
      : await firstCallAwaitingApproval(toolUses);
    if (awaiting) {
      await span({
        type: "approval_wait",
        name: awaiting.name,
        input: awaiting.input,
        output: { toolUseId: awaiting.id },
        isError: false,
        usage: null,
        costNanos: 0,
        estimated,
        startedAt: clock(),
      });
      return {
        ...base(),
        status: "paused_for_approval",
        serializedMessages: JSON.stringify(messages),
        pendingApproval: {
          toolUseId: awaiting.id,
          toolName: awaiting.name,
          toolInput: awaiting.input,
        },
      };
    }

    const results: ToolResultBlock[] = [];
    let terminalOutcome: unknown = null;
    let sawTerminal = false;

    // The terminal tool decides the run's outcome, so it must be the only
    // call in its turn. Beside other calls, either one runs after the outcome
    // is decided, or the run ends before the model can relay a result, and on
    // a call the caller never hears it. Refusing it with is_error lets the
    // other calls run and Tala speak; the model calls it again on its own.
    const terminalName = registry.terminalToolName;
    const terminalMustWait = toolUses.length > 1;

    for (const call of toolUses) {
      // Checked before each call, not once per turn: a tool already running
      // when the caller talks finishes and keeps its real result, and only
      // the calls not yet started are skipped.
      if (callerInterrupted()) {
        results.push(await notRun(call));
        continue;
      }

      const startedAt = clock();

      if (terminalMustWait && call.name === terminalName) {
        const detail =
          `${terminalName} must be called on its own, in a reply with no ` +
          `other tool calls, once the caller has heard everything else. ` +
          `Call it again in a later reply.`;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      const definition = registry.get(call.name);

      // Unknown names are model output, so this is an input to survive
      // rather than a programmer error. `requiresApproval` throws
      // on unknown names by design; answering the model is the loop's job.
      if (!definition) {
        const detail = `unknown tool "${call.name}" — it is not registered`;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      let requiresApproval: boolean;
      try {
        requiresApproval = registry.requiresApproval(call.name);
      } catch (error) {
        const detail =
          error instanceof ToolRegistryError
            ? error.issues.join("; ")
            : errorText(error);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      // Parsed *before* the pause, not after.
      //
      // OpsPilot FAILURES #22: this sat below the approval branch, so a
      // confirm-write call whose input its own schema rejects was still queued
      // for a human — someone could be asked to approve a refund of -5 cents.
      // The pause is a commitment to interrupt a person; nothing unvalidated
      // should reach it.
      const parsed = definition.input.safeParse(call.input);
      if (!parsed.success) {
        const detail = `invalid arguments for ${call.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: call.input,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
        continue;
      }

      // The policy gate, for tools that declare one. Runs before the pause for
      // the same reason: an action the policy engine refuses must never become
      // a question someone has to answer.
      if (requiresApproval && definition.preflight) {
        try {
          await definition.preflight(parsed.data, toolContext);
        } catch (error) {
          const detail = errorText(error);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: detail,
            is_error: true,
          });
          await span({
            type: "guardrail",
            name: call.name,
            input: call.input,
            output: { error: detail },
            isError: true,
            usage: null,
            costNanos: 0,
            estimated,
            startedAt,
          });
          continue;
        }
      }

      // The turn was cleared for dispatch before anything ran, so a
      // confirm-write reaching this point already has an answer. What is left
      // is applying it.
      if (requiresApproval) {
        const decision = decisions.get(call.id);

        if (!decision) {
          // Unreachable: `firstCallAwaitingApproval` pauses the turn before
          // dispatch begins. Stated as a result rather than a throw so a
          // future edit that breaks the invariant degrades into a refusal the
          // agent can escalate, instead of killing the run.
          const detail =
            `${call.name} requires human approval and none was recorded ` +
            `for this call`;
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: detail,
            is_error: true,
          });
          await span({
            type: "guardrail",
            name: call.name,
            input: call.input,
            output: { error: detail },
            isError: true,
            usage: null,
            costNanos: 0,
            estimated,
            startedAt,
          });
          continue;
        }

        if (!decision.approved) {
          // Denial adaptation. The reviewer's reason goes back as an
          // `is_error` tool_result — the same channel the policy guardrail
          // uses — so the agent adapts and escalates rather than retrying
          // blindly. Mechanically it is the preflight path with a human in
          // place of the policy engine.
          const reason = decision.reason?.trim();
          const detail = reason
            ? `refused by a human reviewer: ${reason}`
            : "refused by a human reviewer, with no reason given";
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: detail,
            is_error: true,
          });
          await span({
            type: "guardrail",
            name: call.name,
            input: parsed.data,
            output: { error: detail, decision: "denied" },
            isError: true,
            usage: null,
            costNanos: 0,
            estimated,
            startedAt,
          });
          continue;
        }
        // Approved. Falls through to the handler, which revalidates anyway.
      }

      try {
        const output = await definition.handler(parsed.data, toolContext);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: stringifyResult(output),
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: parsed.data,
          output,
          isError: false,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });

        if (definition.terminal === true) {
          sawTerminal = true;
          terminalOutcome = parsed.data;
        }
      } catch (error) {
        // A confirm-write handler rejects out-of-policy calls by throwing, and
        // the agent is expected to adapt — usually by escalating. That only works if the
        // throw becomes a result the model can read.
        const detail = errorText(error);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: detail,
          is_error: true,
        });
        await span({
          type: "tool_exec",
          name: call.name,
          input: parsed.data,
          output: { error: detail },
          isError: true,
          usage: null,
          costNanos: 0,
          estimated,
          startedAt,
        });
      }
    }

    // One user message carrying every result for this turn. Splitting them
    // across messages is accepted by the API and quietly trains the model out
    // of calling tools in parallel.
    messages.push({ role: "user", content: results });

    // The terminal tool stands alone in its turn, so if it ran, nothing was
    // skipped and the outcome is decided: an interruption that arrived while
    // it ran does not reopen the call.
    if (sawTerminal) {
      return { ...base(), status: "completed", outcome: terminalOutcome };
    }
    if (callerInterrupted()) return { ...base(), status: "interrupted" };
  }

  return {
    ...base(),
    status: "failed",
    error:
      `agent loop: reached the ${maxIterations}-iteration cap without calling ` +
      `${registry.terminalToolName}`,
  };
}
