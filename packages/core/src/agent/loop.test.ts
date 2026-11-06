import { describe, expect, it, vi } from "vitest";


import { checkBudget, type BudgetConfig } from "./budget";
import { rateCard, type RateCard } from "./cost";
import {
  AGENT_LOOP_STATUSES,
  runAgentLoop,
  SILENT_TURN_NOTICE,
  type AssistantTurn,
  type ContentBlock,
  type MessageCreator,
  type MessageParam,
  type SpanEvent,
} from "./loop";
import {
  buildRegistry,
  type ToolContext,
  type ToolDefinition,
} from "./registry";

import { z } from "zod";

/**
 * The hand-rolled agent loop.
 *
 * Imported from OpsPilot with its tests. Pause/resume requires serializing
 * the message array mid-loop and reconstructing it later, which the SDK's tool
 * runner does not support. So the loop is ours, and it has to be tested like
 * production code rather than demonstrated once in a script.
 *
 * **Everything here runs against a scripted client.** `npm test` must never
 * need a database *or* an API key, so `createMessage` is a narrow interface the
 * loop owns — `(params) => Promise<AssistantTurn>` — and the tests hand it
 * queued turns. The production adapter behind that interface streams from
 * the Anthropic API and returns the SDK's assembled final message, which is structurally
 * an `AssistantTurn`. That split is deliberate: the four-field `usage` object
 * arrives split across event types on the streaming path, and hand-assembling
 * it is exactly how a run silently records zero cache cost. Let the SDK
 * assemble; let the loop consume something it can fake.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** $1/$5 per MTok — 1000 nanos per input token, 5000 per output token. */
const VERIFIED_RATES: RateCard = rateCard(1, 5, {
  verifiedOn: "2026-08-13",
  source: "test fixture",
});

const UNVERIFIED_RATES: RateCard = rateCard(1, 5, {
  verifiedOn: null,
  source: "test fixture — unverified on purpose",
});

/** 10 in + 10 out against VERIFIED_RATES = 10*1000 + 10*5000 = 60_000 nanos. */
const TURN_NANOS = 60_000;

function usage(over: Partial<AssistantTurn["usage"]> = {}) {
  return {
    input_tokens: 10,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  };
}

function toolUse(name: string, input: unknown, id = `toolu_${name}`) {
  return { type: "tool_use" as const, id, name, input };
}

function turn(
  content: ContentBlock[],
  over: Partial<AssistantTurn> = {},
): AssistantTurn {
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    stop_details: null,
    usage: usage(),
    ...over,
  };
}

/** A turn that calls the forced terminal tool and ends the run. */
function resolveTurn(action = "answered") {
  return turn([
    toolUse("end_call", {
      action,
      credit_minor: 0,
      reply: "All set.",
      confidence: "high",
    }),
  ]);
}

/**
 * A scripted stand-in for the Anthropic client. Returns queued turns in order
 * and records the params it was called with, so a test can assert on the
 * *shape of the messages array* the loop built — which is where the tool-result
 * batching rule lives.
 */
function scriptedClient(turns: AssistantTurn[]) {
  const calls: Parameters<MessageCreator>[0][] = [];
  const create: MessageCreator = vi.fn(async (params) => {
    calls.push(structuredClone(params) as Parameters<MessageCreator>[0]);
    const next = turns.shift();
    if (!next) throw new Error("scripted client ran out of turns");
    return next;
  });
  return { create, calls };
}

function tool(
  name: string,
  over: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `A ${name} tool used by the agent loop tests, described at length enough to pass boot validation.`,
    input: z.object({ q: z.string() }),
    safetyClass: "read",
    idempotent: true,
    handler: async () => ({ ok: name }),
    ...over,
  } as ToolDefinition;
}

/** The forced terminal tool, shaped like Tala's: it returns its own input. */
function endCallTool() {
  return tool("end_call", {
    safetyClass: "auto_write",
    terminal: true,
    input: z.object({
      action: z.string(),
      credit_minor: z.number(),
      reply: z.string(),
      confidence: z.string(),
    }),
    handler: async (input) => input,
  });
}

/** A registry mirroring the real safety-class mix, with handlers that work. */
function testRegistry(
  over: {
    handler?: ToolDefinition["handler"];
    creditHandler?: ToolDefinition["handler"];
  } = {},
) {
  return buildRegistry([
    tool("get_account_overview", over.handler ? { handler: over.handler } : {}),
    tool("search_knowledge_base"),
    tool("apply_bill_credit", {
      safetyClass: "confirm_write",
      input: z.object({ account_number: z.string(), amount_minor: z.number() }),
      // Throws unless a test opts in, so any run that dispatches a
      // confirm-write without an approval fails loudly rather than passing.
      handler:
        over.creditHandler ??
        (async () => {
          throw new Error(
            "confirm_write handler must never run before approval",
          );
        }),
    }),
    endCallTool(),
  ]);
}

function budget(over: Partial<BudgetConfig> = {}): BudgetConfig {
  // $5 a day, ten runs a minute.
  return {
    dailyCapNanos: 5_000_000_000,
    killSwitch: false,
    runsPerMinute: 10,
    ...over,
  };
}

/** A monotonic fake clock, so latency and timestamps are assertable. */
function fakeClock(startMs = 1_760_000_000_000, stepMs = 5) {
  let t = startMs;
  return () => new Date((t += stepMs));
}

function loopInput(
  turns: AssistantTurn[],
  over: Partial<Parameters<typeof runAgentLoop>[0]> = {},
) {
  const client = scriptedClient(turns);
  const spans: SpanEvent[] = [];
  const input = {
    registry: testRegistry(),
    createMessage: client.create,
    model: "claude-haiku-5-5",
    rates: VERIFIED_RATES,
    system: "You are Tala.",
    messages: [{ role: "user" as const, content: "Caller: where is my credit?" }],
    toolContext: {
      // The loop never reads the policy either; it only forwards the context.
      policyConfig: {},
      workspaceId: "ws_1",
      runId: "run_1",
      callId: "call_1",
      now: new Date("2026-08-13T00:00:00Z"),
      // The loop never touches the repository — it only forwards the context
      // to handlers, and this file's handlers are fakes that ignore it.
      data: {} as ToolContext["data"],
    },
    budget: { config: budget(), spentTodayNanos: 0 },
    estimatedCallNanos: TURN_NANOS,
    clock: fakeClock(),
    emit: (s: SpanEvent) => {
      spans.push(s);
    },
    ...over,
  };
  return { input, client, spans };
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — reaching an outcome", () => {
  it("runs a read tool, then the terminal tool, and completes", async () => {
    const { input, client } = loopInput([
      turn([toolUse("get_account_overview", { q: "KF-1007" })]),
      resolveTurn("answered"),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(2);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.outcome).toMatchObject({
      action: "answered",
      confidence: "high",
    });
  });

  /**
   * `end_call` is the forced terminal tool: the deterministic eval
   * scorers key off its structured output, so a run that kept going after it
   * would produce two candidate outcomes and no rule for picking one.
   */
  it("stops at the terminal tool without asking the model for another turn", async () => {
    const { input, client } = loopInput([
      resolveTurn(),
      turn([toolUse("search_knowledge_base", { q: "never reached" })]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  /**
   * On a call, a reply with no tool call is Tala speaking and then listening.
   * OpsPilot nudged the model to keep going ("you have not finished"), because
   * a ticket had no one to wait for. A caller is someone to wait for, so the
   * loop hands the turn back and the call session waits for their next words.
   *
   * The nudge's purpose, that every run ends with a structured outcome the
   * evals can score, moves up a level: a *call* ends only through `end_call`.
   */
  it("ends the turn as awaiting_caller when the model replies without a tool call", async () => {
    const { input, client } = loopInput([
      turn([{ type: "text", text: "Ano po ang account number ninyo?" }]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("awaiting_caller");
    expect(result.outcome).toBeNull();
    expect(result.iterations).toBe(1);
    // The queued end_call turn is never requested: the caller speaks next.
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it("leaves the conversation ending on what Tala said, with nothing appended", async () => {
    const { input } = loopInput([
      turn([{ type: "text", text: "Ano po ang account number ninyo?" }]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.messages).toEqual([
      { role: "user", content: "Caller: where is my credit?" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Ano po ang account number ninyo?" }],
      },
    ]);
  });

  it("runs the turn's tools first, then waits for the caller after the spoken reply", async () => {
    const { input, client } = loopInput([
      turn([toolUse("search_knowledge_base", { q: "modem lights" })]),
      turn([{ type: "text", text: "Pakitingnan po ang PON light." }]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("awaiting_caller");
    expect(result.iterations).toBe(2);
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxIterations rather than looping forever", async () => {
    const turns = Array.from({ length: 12 }, () =>
      turn([toolUse("search_knowledge_base", { q: "again" })]),
    );
    const { input } = loopInput(turns, { maxIterations: 12 });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("failed");
    expect(result.iterations).toBe(12);
    expect(result.error).toMatch(/iteration/i);
  });
});

/* -------------------------------------------------------------------------- */
/* A silent turn                                                              */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — a silent turn", () => {
  /**
   * A turn with no tool call and nothing to say out loud is not a reply: the
   * caller would hear dead air and then be expected to speak. So the loop
   * tells the model and asks again, and a model that stays silent runs into
   * the same cap as one that loops on tools.
   */
  it("gives up at the iteration cap when every turn is silent", async () => {
    const turns = Array.from({ length: 12 }, () => turn([]));
    const { input, client } = loopInput(turns);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("failed");
    expect(result.iterations).toBe(12);
    expect(client.create).toHaveBeenCalledTimes(12);
    expect(result.error).toBe(
      "agent loop: reached the 12-iteration cap without calling end_call",
    );
  });

  /**
   * The Messages API rejects an assistant message with empty content anywhere
   * but last, so an empty turn kept in `messages` would fail the very next
   * request. It was never sent back, so dropping it edits nothing the model
   * has seen.
   */
  it("drops an empty turn, tells the model, and asks again", async () => {
    const { input, client } = loopInput([
      turn([]),
      turn([{ type: "text", text: "Ano po ang account number ninyo?" }]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("awaiting_caller");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.calls[1].messages).toEqual([
      { role: "user", content: "Caller: where is my credit?" },
      {
        role: "user",
        content:
          "(The caller heard nothing. Answer them out loud, or call a tool.)",
      },
    ]);
    expect(SILENT_TURN_NOTICE).toBe(
      "(The caller heard nothing. Answer them out loud, or call a tool.)",
    );
  });

  /**
   * Thinking is not speech. A turn that only thought says nothing to the
   * caller, and dropping it means its thinking block is never replayed.
   */
  /**
   * Dropping the turn from the conversation does not unspend it: the model
   * was called and billed, so the trace and the run's totals still show it.
   */
  it("still reports a silent turn's llm_call span and cost", async () => {
    const { input, spans } = loopInput([
      turn([]),
      turn([{ type: "text", text: "Ano po ang account number ninyo?" }]),
    ]);

    const result = await runAgentLoop(input);

    expect(spans.map((s) => [s.type, s.costNanos])).toEqual([
      ["llm_call", 60_000],
      ["llm_call", 60_000],
    ]);
    expect(spans[0].output).toEqual({ stop_reason: "end_turn", blocks: [] });
    expect(result.costNanos).toBe(120_000);
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("treats a turn whose only text is whitespace as silent", async () => {
    const { input, client } = loopInput([
      turn([{ type: "text", text: "  " }]),
      turn([{ type: "text", text: "Ano po ang account number ninyo?" }]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("awaiting_caller");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.calls[1].messages).toEqual([
      { role: "user", content: "Caller: where is my credit?" },
      {
        role: "user",
        content:
          "(The caller heard nothing. Answer them out loud, or call a tool.)",
      },
    ]);
  });

  it("treats a thinking-only turn as silent and never sends it back", async () => {
    const { input, client } = loopInput([
      turn([{ type: "thinking", thinking: "", signature: "s" }]),
      turn([{ type: "text", text: "Ano po ang account number ninyo?" }]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("awaiting_caller");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.calls[1].messages).toEqual([
      { role: "user", content: "Caller: where is my credit?" },
      {
        role: "user",
        content:
          "(The caller heard nothing. Answer them out loud, or call a tool.)",
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The terminal tool stands alone                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — the terminal tool stands alone", () => {
  /**
   * `end_call` decides the run's outcome, so nothing may run after it, and on
   * a call nothing may run beside it either: a result the model never gets to
   * relay is a result the caller never hears. Refusing it with is_error lets
   * the model finish the other work, speak, and call it again on its own.
   */
  const ALONE =
    "end_call must be called on its own, in a reply with no other tool " +
    "calls, once the caller has heard everything else. Call it again in a " +
    "later reply.";

  const disposition = (action: string) => ({
    action,
    credit_minor: 0,
    reply: "All set.",
    confidence: "high",
  });

  it("runs the other tool, refuses the terminal call beside it, and completes on the next turn", async () => {
    const { input, client } = loopInput([
      turn([
        toolUse("search_knowledge_base", { q: "outage" }, "toolu_search"),
        toolUse("end_call", disposition("too_soon"), "toolu_end_early"),
      ]),
      resolveTurn("answered"),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(2);
    expect(result.outcome).toEqual(disposition("answered"));
    expect(client.calls[1].messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_search",
          content: '{"ok":"search_knowledge_base"}',
        },
        { type: "tool_result", tool_use_id: "toolu_end_early", content: ALONE, is_error: true },
      ],
    });
  });

  /** The reviewed defect: end_call first used to decide the run, then the read ran anyway. */
  it("still runs a tool that follows a refused terminal call", async () => {
    const { input, client, spans } = loopInput([
      turn([
        toolUse("end_call", disposition("too_soon"), "toolu_end_early"),
        toolUse("search_knowledge_base", { q: "outage" }, "toolu_search"),
      ]),
      resolveTurn("answered"),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.outcome).toEqual(disposition("answered"));
    expect(client.calls[1].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_end_early", content: ALONE, is_error: true },
        {
          type: "tool_result",
          tool_use_id: "toolu_search",
          content: '{"ok":"search_knowledge_base"}',
        },
      ],
    });
    expect(
      spans.filter((s) => s.type === "tool_exec").map((s) => [s.name, s.isError]),
    ).toEqual([
      ["end_call", true],
      ["search_knowledge_base", false],
      ["end_call", false],
    ]);
  });

  it("refuses both terminal calls when one turn makes two", async () => {
    const { input, client, spans } = loopInput([
      turn([
        toolUse("end_call", disposition("first"), "toolu_end_1"),
        toolUse("end_call", disposition("second"), "toolu_end_2"),
      ]),
      resolveTurn("answered"),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.outcome).toEqual(disposition("answered"));
    expect(client.calls[1].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_end_1", content: ALONE, is_error: true },
        { type: "tool_result", tool_use_id: "toolu_end_2", content: ALONE, is_error: true },
      ],
    });
    expect(
      spans.filter((s) => s.type === "tool_exec").map((s) => [s.name, s.isError]),
    ).toEqual([
      ["end_call", true],
      ["end_call", true],
      ["end_call", false],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — refusal", () => {
  /**
   * CLAUDE.md's gotcha, pinned: `stop_reason: "refusal"` must be handled
   * *before* `content` is read. The turn below carries a tool_use block, which
   * a loop that inspected content first would happily execute — firing a tool
   * off the back of a response the model declined to stand behind.
   */
  it("refuses without executing tool_use blocks present in the refused turn", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const { input } = loopInput(
      [
        turn([toolUse("get_account_overview", { q: "KF-1007" })], {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
        }),
      ],
      { registry: testRegistry({ handler }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("refused");
    expect(handler).not.toHaveBeenCalled();
    expect(result.refusal?.category).toBe("cyber");
  });

  /**
   * The subtler half of the same gotcha. `stop_details` is populated *only* on
   * a refusal — but it can still be null *on* one, so `if (stop_details)` is
   * the wrong test and would let a refusal through as a normal turn.
   */
  it("refuses when stop_reason says so even though stop_details is null", async () => {
    const { input } = loopInput([
      turn([], { stop_reason: "refusal", stop_details: null }),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("refused");
    expect(result.refusal?.category).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The spend guard                                                            */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — budget", () => {
  /**
   * A loop that can call the API before consulting the guard is a loop that can spend money it
   * was refused, so the check has to be a pre-flight, not a report.
   */
  it("refuses before the first call when the cap is already spent", async () => {
    const { input, client } = loopInput([resolveTurn()], {
      budget: {
        config: budget({ dailyCapNanos: 1_000 }),
        spentTodayNanos: 1_000,
      },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(result.budgetReason).toBe("daily_cap_reached");
    expect(client.create).not.toHaveBeenCalled();
    expect(result.costNanos).toBe(0);
  });

  it("refuses before the first call when the kill switch is pulled", async () => {
    const { input, client } = loopInput([resolveTurn()], {
      budget: { config: budget({ killSwitch: true }), spentTodayNanos: 0 },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(result.budgetReason).toBe("kill_switch");
    expect(client.create).not.toHaveBeenCalled();
  });

  /**
   * The failure this exists to prevent: a guard checked once at the top of the
   * run, using a figure read from the database before the loop started, lets a
   * 12-iteration run spend twelve times the amount it was cleared for. Spend
   * accrued *inside* the run has to count against the same cap.
   *
   * Cap $0.00015 (150_000 nanos) against 60_000-nano turns: iterations 1 and 2
   * clear the pre-flight, iteration 3 does not.
   */
  it("counts spend accrued inside the run against the cap", async () => {
    const turns = Array.from({ length: 5 }, () =>
      turn([toolUse("search_knowledge_base", { q: "again" })]),
    );
    const { input, client } = loopInput(turns, {
      budget: {
        config: budget({ dailyCapNanos: 150_000 }),
        spentTodayNanos: 0,
      },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(result.budgetReason).toBe("run_would_exceed_cap");
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(result.costNanos).toBe(2 * TURN_NANOS);
  });

  /**
   * A rate card with no `verifiedOn` date might be wrong by any amount
   * (OpsPilot's Bedrock card was, and the one comparable AWS figure was 2x the
   * first-party price), so the guard charges unverified cards at
   * UNVERIFIED_RATE_SAFETY_FACTOR. Enforcing a cap with rates that might be
   * half the real ones is not a cap. Same cap as above, but doubled charging
   * means iteration 2 is already refused.
   */
  it("charges an unverified rate card at the pessimistic multiple", async () => {
    const turns = Array.from({ length: 5 }, () =>
      turn([toolUse("search_knowledge_base", { q: "again" })]),
    );
    const { input, client } = loopInput(turns, {
      rates: UNVERIFIED_RATES,
      budget: {
        config: budget({ dailyCapNanos: 150_000 }),
        spentTodayNanos: 0,
      },
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("budget_refused");
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(result.estimated).toBe(true);
  });

  /** The guard's own arithmetic, restated at the loop's boundary. */
  it("agrees with checkBudget about the boundary it enforces", () => {
    expect(
      checkBudget({
        spentTodayNanos: 2 * TURN_NANOS,
        estimatedRunNanos: TURN_NANOS,
        rateVerified: true,
        config: budget({ dailyCapNanos: 150_000 }),
      }).allowed,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Approval pause                                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — confirm-write pause", () => {
  /**
   * The pause is the pause/resume story and the Vercel-timeout answer at once:
   * the run serializes its message array, ends the invocation, and a later
   * OpsPilot's `/api/agent/resume` reconstructs it. The handler must not run — approval
   * happens *before* the side effect, not after.
   */
  it("pauses on a confirm-write tool without running its handler", async () => {
    const { input, client } = loopInput([
      turn([
        toolUse("apply_bill_credit", { account_number: "KF-1002", amount_minor: 4900 }),
      ]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("paused_for_approval");
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(result.pendingApproval).toMatchObject({
      toolName: "apply_bill_credit",
      toolUseId: "toolu_apply_bill_credit",
      toolInput: { account_number: "KF-1002", amount_minor: 4900 },
    });
  });

  /**
   * The serialized array is what resume rebuilds the conversation from. If it
   * does not round-trip, the resumed turn is invalid and the API rejects it —
   * which is why OpsPilot's `agent_runs.serialized_messages` is `text` rather than
   * `jsonb` in the first place.
   */
  it("serializes a message array that round-trips through JSON", async () => {
    const { input } = loopInput([
      turn([
        toolUse("apply_bill_credit", { account_number: "KF-1002", amount_minor: 4900 }),
      ]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.serializedMessages).toBeTypeOf("string");
    const restored = JSON.parse(result.serializedMessages!) as { role: string }[];
    expect(Array.isArray(restored)).toBe(true);
    // user turn + the assistant turn carrying the pending tool_use
    expect(restored).toHaveLength(2);
    expect(restored[1].role).toBe("assistant");
  });

  it("emits an approval_wait span so the pause is visible in the trace", async () => {
    const { input, spans } = loopInput([
      turn([
        toolUse("apply_bill_credit", { account_number: "KF-1002", amount_minor: 4900 }),
      ]),
    ]);

    await runAgentLoop(input);

    expect(spans.map((s) => s.type)).toContain("approval_wait");
  });

  /**
   * A turn can carry a read *and* a confirm-write. The loop dispatches in
   * order, so the read runs, its `tool_exec` span is persisted — and then the
   * pause returns, discarding the local `results` array the read wrote into.
   *
   * That leaves the trace claiming a tool ran while the serialized
   * conversation has no record of it, and resume then rebuilds an assistant
   * turn whose `tool_use` block has no matching `tool_result`. The API rejects
   * that outright.
   *
   * The pause is a commitment to interrupt a person; nothing in the turn
   * should have happened yet when it fires.
   */
  it("pauses before dispatching anything else in the same turn", async () => {
    const { input, spans } = loopInput([
      turn([
        toolUse("get_account_overview", { q: "KF-1007" }, "toolu_read"),
        toolUse(
          "apply_bill_credit",
          { account_number: "KF-1002", amount_minor: 4900 },
          "toolu_credit",
        ),
      ]),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("paused_for_approval");
    expect(result.pendingApproval?.toolUseId).toBe("toolu_credit");
    // The read must not have executed: its result would be thrown away.
    expect(spans.filter((s) => s.type === "tool_exec")).toHaveLength(0);
  });

  /**
   * The corollary, stated as the contract resume depends on:
   * `serializedMessages` is exactly `[...history, assistant]`. No partial
   * user turn, no half-populated tool_result message — so resume's job is
   * unconditional: append one user message carrying a result for every
   * `tool_use` in that final assistant turn.
   */
  it("serializes history plus the assistant turn and nothing else", async () => {
    const { input } = loopInput([
      turn([
        toolUse("get_account_overview", { q: "KF-1007" }, "toolu_read"),
        toolUse(
          "apply_bill_credit",
          { account_number: "KF-1002", amount_minor: 4900 },
          "toolu_credit",
        ),
      ]),
    ]);

    const result = await runAgentLoop(input);
    const restored = JSON.parse(result.serializedMessages!) as { role: string }[];

    expect(restored).toHaveLength(2);
    expect(restored[1].role).toBe("assistant");
  });
});

/* -------------------------------------------------------------------------- */
/* Span numbering across invocations                                          */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — startSeq", () => {
  /**
   * OpsPilot's `run_spans` has a unique index on `(run_id, seq)`, and a resumed run keeps
   * its original run row so the trace viewer renders one continuous waterfall.
   * A second `runAgentLoop` numbering from zero collides with the spans the
   * paused invocation already wrote — the insert fails and the resumed run
   * dies on its first span.
   */
  it("numbers spans from the offset it is given", async () => {
    const { input, spans } = loopInput([resolveTurn()], { startSeq: 7 });

    await runAgentLoop(input);

    expect(spans.length).toBeGreaterThan(0);
    expect(spans.map((s) => s.seq)).toEqual([7, 8]);
  });

  it("still numbers from zero when no offset is given", async () => {
    const { input, spans } = loopInput([resolveTurn()]);

    await runAgentLoop(input);

    expect(spans[0].seq).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Resuming a decided approval                                                */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — resuming a decided approval", () => {
  /**
   * Drive a real loop to its pause and hand back exactly what
   * OpsPilot's `/api/agent/resume` would read out of the database. Building the paused
   * state by hand would let these tests agree with a fiction — the pause is
   * the thing whose output resume has to consume.
   */
  async function pausedAt(turns: AssistantTurn[]) {
    const { input } = loopInput(turns);
    const paused = await runAgentLoop(input);
    expect(paused.status).toBe("paused_for_approval");
    return {
      messages: JSON.parse(paused.serializedMessages!) as MessageParam[],
      pending: paused.pendingApproval!,
    };
  }

  const creditTurn = () =>
    turn([
      toolUse(
        "apply_bill_credit",
        { account_number: "KF-1002", amount_minor: 4900 },
        "toolu_credit",
      ),
    ]);

  it("dispatches an approved call and runs on to the terminal tool", async () => {
    const { messages, pending } = await pausedAt([creditTurn()]);
    const credited = vi.fn(async () => ({ credited: true }));

    const { input, client } = loopInput([resolveTurn("credited")], {
      messages,
      registry: testRegistry({ creditHandler: credited }),
      resumeDecisions: [
        { toolUseId: pending.toolUseId, approved: true, reason: null },
      ],
    });

    const result = await runAgentLoop(input);

    expect(credited).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.outcome).toMatchObject({ action: "credited" });
    // One model call: the turn being resumed was already paid for.
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  /**
   * Denial adaptation. The reviewer's reason has to reach the model as an
   * `is_error` tool_result — the same channel the policy guardrail uses — or
   * the agent has no way to know why it was stopped and cannot escalate.
   */
  it("answers a denied call with is_error carrying the reviewer's reason", async () => {
    const { messages, pending } = await pausedAt([creditTurn()]);
    const credited = vi.fn(async () => ({ credited: true }));

    const { input, client } = loopInput([resolveTurn("escalated")], {
      messages,
      registry: testRegistry({ creditHandler: credited }),
      resumeDecisions: [
        {
          toolUseId: pending.toolUseId,
          approved: false,
          reason: "Above the credit limit — send to a supervisor.",
        },
      ],
    });

    const result = await runAgentLoop(input);

    expect(credited).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");

    const blocks = client.calls[0].messages.at(-1)!.content as ContentBlock[];
    const denial = blocks[0] as {
      is_error?: boolean;
      content: string;
      tool_use_id: string;
    };
    expect(denial.tool_use_id).toBe("toolu_credit");
    expect(denial.is_error).toBe(true);
    expect(denial.content).toContain("Above the credit limit");
  });

  it("records the denial as a guardrail span so the trace shows the refusal", async () => {
    const { messages, pending } = await pausedAt([creditTurn()]);

    const { input, spans } = loopInput([resolveTurn("escalated")], {
      messages,
      resumeDecisions: [
        { toolUseId: pending.toolUseId, approved: false, reason: "No." },
      ],
    });

    await runAgentLoop(input);

    const guardrail = spans.find(
      (s) => s.type === "guardrail" && s.name === "apply_bill_credit",
    );
    expect(guardrail?.isError).toBe(true);
  });

  /**
   * The mixed turn, end to end. `apply_bill_credit` is decided; `get_account_overview`
   * shares the turn and was never dispatched, because the pause is decided
   * before anything runs. Both need a `tool_result` in the single user message
   * resume appends — a turn with an unanswered tool_use is rejected by the API.
   */
  it("returns a result for every tool_use in the resumed turn", async () => {
    const mixed = turn([
      toolUse("get_account_overview", { q: "KF-1007" }, "toolu_read"),
      toolUse(
        "apply_bill_credit",
        { account_number: "KF-1002", amount_minor: 4900 },
        "toolu_credit",
      ),
    ]);
    const { messages, pending } = await pausedAt([mixed]);

    const { input, client } = loopInput([resolveTurn("credited")], {
      messages,
      registry: testRegistry({ creditHandler: async () => ({ ok: true }) }),
      resumeDecisions: [
        { toolUseId: pending.toolUseId, approved: true, reason: null },
      ],
    });

    await runAgentLoop(input);

    const blocks = client.calls[0].messages.at(-1)!.content as ContentBlock[];
    const ids = blocks.map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(ids).toEqual(["toolu_read", "toolu_credit"]);
  });

  /**
   * Resume is handed a conversation, not asked to invent one. If the trailing
   * message is not an assistant turn the serialized state is not a pause, and
   * guessing would mean applying a human's decision to the wrong call.
   */
  it("fails cleanly when the serialized state does not end mid-turn", async () => {
    const { input } = loopInput([resolveTurn()], {
      messages: [{ role: "user", content: "not a paused conversation" }],
      resumeDecisions: [
        { toolUseId: "toolu_credit", approved: true, reason: null },
      ],
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("assistant turn");
  });

  /**
   * The resumed turn was never answered, so it has no tool_result yet. If the
   * caller has interrupted, nothing in it runs, an approved credit included,
   * and every call still gets its result, or the next request is rejected.
   */
  it("answers every call of a resumed turn with 'Not run' when the caller has interrupted", async () => {
    const mixed = turn([
      toolUse("get_account_overview", { q: "KF-1007" }, "toolu_read"),
      toolUse(
        "apply_bill_credit",
        { account_number: "KF-1002", amount_minor: 4900 },
        "toolu_credit",
      ),
    ]);
    const { messages, pending } = await pausedAt([mixed]);
    const read = vi.fn(async () => ({ ok: true }));
    const credited = vi.fn(async () => ({ credited: true }));
    const controller = new AbortController();
    controller.abort();

    const { input, client } = loopInput([resolveTurn("credited")], {
      messages,
      registry: testRegistry({ handler: read, creditHandler: credited }),
      resumeDecisions: [
        { toolUseId: pending.toolUseId, approved: true, reason: null },
      ],
      signal: controller.signal,
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(read).not.toHaveBeenCalled();
    expect(credited).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read",
          content: "Not run: the caller interrupted.",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_credit",
          content: "Not run: the caller interrupted.",
          is_error: true,
        },
      ],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Tool execution                                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — tool execution", () => {
  /**
   * Parallel tool use is on by default: one assistant turn can carry several
   * tool_use blocks, and every matching tool_result has to come back in a
   * *single* user message. Splitting them across messages is accepted by the
   * API but quietly trains the model out of calling tools in parallel.
   */
  it("returns all tool results for one turn in a single user message", async () => {
    const { input, client } = loopInput([
      turn([
        toolUse("get_account_overview", { q: "KF-1007" }, "toolu_a"),
        toolUse("search_knowledge_base", { q: "credits" }, "toolu_b"),
      ]),
      resolveTurn(),
    ]);

    await runAgentLoop(input);

    const second = client.calls[1];
    const appended = second.messages.slice(1);
    const userTurns = appended.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);

    const blocks = userTurns[0].content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual([
      "toolu_a",
      "toolu_b",
    ]);
  });

  /**
   * Tool names arrive as model output, so an unregistered
   * name is an input the loop must survive rather than a programmer error.
   * `requiresApproval` throws on unknown names by design; the loop has to
   * catch that and answer the model instead of crashing the run.
   */
  it("answers an unknown tool name with an error result and keeps going", async () => {
    const { input, client } = loopInput([
      turn([toolUse("delete_everything", { q: "x" }, "toolu_x")]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    const blocks = client.calls[1].messages.at(-1)!.content as ContentBlock[];
    expect(blocks[0]).toMatchObject({ tool_use_id: "toolu_x", is_error: true });
  });

  /**
   * The `apply_bill_credit` handler rejects out-of-policy calls with `is_error`, and
   * the agent is expected to adapt (typically by escalating). That contract
   * only holds if a throwing handler becomes a tool_result the model can read,
   * rather than an exception that kills the run.
   */
  it("turns a throwing handler into an is_error tool result", async () => {
    const handler = vi.fn(async () => {
      throw new Error("credit exceeds the policy limit");
    });
    const { input, client } = loopInput(
      [
        turn([toolUse("get_account_overview", { q: "KF-1007" }, "toolu_c")]),
        resolveTurn(),
      ],
      { registry: testRegistry({ handler }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    const blocks = client.calls[1].messages.at(-1)!.content as ContentBlock[];
    expect(blocks[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(blocks[0])).toMatch(/policy limit/);
  });

  /**
   * The wire schema is stripped of numeric and string constraints so the model
   * is told less than the code enforces; Zod is what actually guards the
   * handler. A malformed argument must therefore be rejected at parse time and
   * reported back, never handed to the handler.
   */
  /**
   * verify_identity's attempt limit reads the call's failed attempts, checks
   * them, then records one more. Two calls in one turn running concurrently
   * could both read the same count and spend one attempt between them. The
   * limit holds because the loop runs a turn's calls one at a time, in order,
   * so this pins that: `a` waits longer than `b`, and still finishes first.
   */
  it("runs a turn's tool calls one at a time, in order", async () => {
    const markers: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      markers.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      markers.push(`${name}:end`);
      return { ok: name };
    };
    const { input } = loopInput(
      [
        turn([toolUse("a", { q: "first" }), toolUse("b", { q: "second" })]),
        resolveTurn(),
      ],
      {
        registry: buildRegistry([
          tool("a", { handler: slow("a", 20) }),
          tool("b", { handler: slow("b", 1) }),
          endCallTool(),
        ]),
      },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(markers).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("rejects arguments that fail the Zod schema before the handler sees them", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const { input } = loopInput(
      [
        turn([toolUse("get_account_overview", { q: 42 }, "toolu_bad")]),
        resolveTurn(),
      ],
      { registry: testRegistry({ handler }) },
    );

    const result = await runAgentLoop(input);

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });
});

/* -------------------------------------------------------------------------- */
/* Spans and cost                                                             */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — trace and cost", () => {
  it("emits an llm_call span per model turn and a tool_exec span per tool call", async () => {
    const { input, spans } = loopInput([
      turn([toolUse("get_account_overview", { q: "KF-1007" })]),
      resolveTurn(),
    ]);

    await runAgentLoop(input);

    const byType = spans.reduce<Record<string, number>>((acc, s) => {
      acc[s.type] = (acc[s.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType.llm_call).toBe(2);
    expect(byType.tool_exec).toBe(2); // get_account_overview + end_call
  });

  /**
   * OpsPilot's `run_spans` has a unique index on (run_id, seq). A repeated or missing seq
   * is a constraint violation at persist time, so the counter is part of the
   * loop's contract rather than an implementation detail.
   */
  it("numbers spans from zero with no gaps or repeats", async () => {
    const { input, spans } = loopInput([
      turn([toolUse("get_account_overview", { q: "KF-1007" })]),
      resolveTurn(),
    ]);

    await runAgentLoop(input);

    expect(spans.map((s) => s.seq)).toEqual(spans.map((_, i) => i));
  });

  it("prices each llm_call span and totals them onto the run", async () => {
    const { input, spans } = loopInput([
      turn([toolUse("get_account_overview", { q: "KF-1007" })]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);
    const llm = spans.filter((s) => s.type === "llm_call");

    expect(llm.every((s) => s.costNanos === TURN_NANOS)).toBe(true);
    expect(result.costNanos).toBe(2 * TURN_NANOS);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 20 });
  });

  /**
   * Cache reads are the saving the trace viewer's badge reports, and they are
   * billed as a distinct token class rather than as input — so a run that read
   * from cache must cost less than the same run that did not.
   */
  it("prices cache reads separately from uncached input", async () => {
    // The first turn calls a tool so the loop asks for a second one. It used
    // to be an empty end_turn, which reached the second turn only through
    // OpsPilot's "you have not finished" nudge (#5). An empty turn is now
    // answered with SILENT_TURN_NOTICE, which is not what this test is about.
    const { input } = loopInput([
      turn([toolUse("search_knowledge_base", { q: "cached" })], {
        usage: usage({ input_tokens: 0, cache_read_input_tokens: 100 }),
      }),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    // 100 cache-read tokens at 100 nanos each = 10_000, plus 10 output = 50_000
    expect(result.usage.cacheReadInputTokens).toBe(100);
    expect(result.costNanos).toBe(60_000 + TURN_NANOS);
  });

  it("marks the run estimated when the rate card is unverified", async () => {
    const { input } = loopInput([resolveTurn()], { rates: UNVERIFIED_RATES });

    const result = await runAgentLoop(input);

    expect(result.estimated).toBe(true);
  });

  /**
   * `now` is injected everywhere else in this codebase for determinism; the
   * loop needs a wall clock for latency and span timestamps, so it takes one
   * as an argument rather than reaching for Date.now(). That is what makes
   * these assertions possible at all.
   */
  it("takes its wall clock as an argument", async () => {
    const { input, spans } = loopInput([resolveTurn()], {
      clock: fakeClock(1_000_000, 7),
    });

    await runAgentLoop(input);

    expect(spans[0].latencyMs).toBe(7);
    expect(spans[0].startedAt.getTime()).toBe(1_000_007);
  });
});


/* -------------------------------------------------------------------------- */
/* Strict decoding                                                            */
/* -------------------------------------------------------------------------- */

describe("runAgentLoop — strict decoding", () => {
  /**
   * Measured in OpsPilot: Amazon Bedrock rejected a nine-tool registry with
   * `400 Compiled grammar size (329.9MB) exceeds maximum allowed size (300MB)`.
   * The loop therefore has to be able to send the tool block without asking for
   * constrained decoding. It defaults that way until the first-party limit for
   * Tala's tool set has been measured.
   *
   * This costs nothing that matters. The test directly below shows why: the
   * loop still parses every tool call with the tool own Zod schema, so the
   * wire schema constrains the model and Zod constrains reality — exactly as
   * it did when strict was on.
   */
  it("does not ask for strict decoding by default", async () => {
    const { input, client } = loopInput([resolveTurn()]);

    await runAgentLoop(input);

    for (const spec of client.calls[0].tools as { strict?: unknown }[]) {
      expect(spec).not.toHaveProperty("strict");
    }
  });

  it("asks for it when the caller says the provider can take it", async () => {
    const { input, client } = loopInput([resolveTurn()], { strictTools: true });

    await runAgentLoop(input);

    for (const spec of client.calls[0].tools as { strict?: unknown }[]) {
      expect(spec).toHaveProperty("strict", true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* An interruption                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The caller can talk over Tala at any point in her turn. The loop takes an
 * abort signal for that, and an interruption is not a failure: the loop keeps
 * what can stay in the conversation, answers every tool call it will not run,
 * books what was spent, and hands the turn back with status `interrupted`.
 *
 * How the streaming creator reports one is pinned in streaming.test.ts: it
 * resolves with what had streamed, marked `stop_reason: "interrupted"`. Here
 * the scripted creator returns that shape directly.
 */
describe("runAgentLoop — an interruption", () => {
  const NOT_RUN = "Not run: the caller interrupted.";
  const FIRST_USER: MessageParam = { role: "user", content: "Caller: where is my credit?" };

  const said = (text: string): ContentBlock => ({ type: "text", text });

  /** What the streaming creator returns when the caller cuts a turn short. */
  const cutShort = (
    content: ContentBlock[],
    over: Partial<AssistantTurn["usage"]> = {},
  ): AssistantTurn =>
    turn(content, {
      stop_reason: "interrupted",
      usage: usage({ input_tokens: 10, output_tokens: 1, ...over }),
    });

  const notRun = (toolUseId: string) => ({
    type: "tool_result",
    tool_use_id: toolUseId,
    content: NOT_RUN,
    is_error: true,
  });

  /**
   * A loop whose caller interrupts during its first model call: the signal
   * aborts before that call returns, as it would mid-stream. A complete turn
   * returned anyway is the abort landing just after the stream finished.
   */
  function interruptedDuringFirstCall(
    turns: AssistantTurn[],
    over: Partial<Parameters<typeof runAgentLoop>[0]> = {},
  ) {
    const controller = new AbortController();
    const built = loopInput(turns, { signal: controller.signal, ...over });
    const inner = built.input.createMessage;
    built.input.createMessage = async (params, options) => {
      if (built.client.calls.length === 0) controller.abort();
      return inner(params, options);
    };
    return built;
  }

  /** Read tools a, b and c, whose handlers a test can watch, and end_call. */
  function watchedRegistry(
    handlers: Partial<Record<"a" | "b" | "c", ToolDefinition["handler"]>>,
  ) {
    return buildRegistry([
      tool("a", handlers.a ? { handler: handlers.a } : {}),
      tool("b", handlers.b ? { handler: handlers.b } : {}),
      tool("c", handlers.c ? { handler: handlers.c } : {}),
      endCallTool(),
    ]);
  }

  it("is one of the statuses the loop can end with", () => {
    expect(AGENT_LOOP_STATUSES).toContain("interrupted");
  });

  it("hands its signal and every text delta through to the model call", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const heard: string[] = [];
    const createMessage: MessageCreator = async (_params, options) => {
      signals.push(options?.signal);
      options?.onTextDelta?.("Opo, ");
      options?.onTextDelta?.("sandali lang po.");
      return turn([said("Opo, sandali lang po.")]);
    };
    const { input } = loopInput([], {
      createMessage,
      signal: controller.signal,
      onTextDelta: (text) => heard.push(text),
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("awaiting_caller");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(controller.signal);
    expect(heard).toEqual(["Opo, ", "sandali lang po."]);
  });

  it("keeps what Tala had said of an interrupted turn, and asks the model nothing more", async () => {
    const { input, client } = interruptedDuringFirstCall([
      cutShort([said("Opo, sandali")]),
      resolveTurn(),
    ]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(result.outcome).toBeNull();
    expect(result.messages).toEqual([
      FIRST_USER,
      { role: "assistant", content: [said("Opo, sandali")] },
    ]);
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no content", []],
    [
      "only a signed thinking block",
      [{ type: "thinking", thinking: "Check first.", signature: "sig_abc" }],
    ],
    ["only blank text", [{ type: "text", text: "  " }]],
  ])(
    "appends nothing when the interrupted turn has %s",
    async (_label, content: ContentBlock[]) => {
      const { input, client } = interruptedDuringFirstCall([cutShort(content), resolveTurn()]);

      const result = await runAgentLoop(input);

      expect(result.status).toBe("interrupted");
      expect(result.messages).toEqual([FIRST_USER]);
      expect(client.create).toHaveBeenCalledTimes(1);
    },
  );

  it("answers every tool call of an interrupted turn with 'Not run', and runs none", async () => {
    const a = vi.fn(async () => ({ ok: "a" }));
    const b = vi.fn(async () => ({ ok: "b" }));
    const content = [
      said("Sige po, iche-check ko."),
      toolUse("a", { q: "outage" }, "toolu_a"),
      toolUse("b", { q: "account" }, "toolu_b"),
    ];
    const { input, client, spans } = interruptedDuringFirstCall(
      [cutShort(content), resolveTurn()],
      { registry: watchedRegistry({ a, b }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(result.messages).toEqual([
      FIRST_USER,
      { role: "assistant", content },
      { role: "user", content: [notRun("toolu_a"), notRun("toolu_b")] },
    ]);
    expect(client.create).toHaveBeenCalledTimes(1);
    // The trace shows each answer, as it does for any other refused call.
    expect(
      spans
        .filter((s) => s.type === "tool_exec")
        .map((s) => [s.name, s.isError, s.output]),
    ).toEqual([
      ["a", true, { error: NOT_RUN }],
      ["b", true, { error: NOT_RUN }],
    ]);
  });

  it("does not end the run on an end_call the interruption cut into", async () => {
    const endCall = toolUse(
      "end_call",
      { action: "answered", credit_minor: 0, reply: "Salamat po.", confidence: "high" },
      "toolu_end",
    );
    const { input } = interruptedDuringFirstCall([cutShort([endCall])]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(result.outcome).toBeNull();
    expect(result.messages).toEqual([
      FIRST_USER,
      { role: "assistant", content: [endCall] },
      { role: "user", content: [notRun("toolu_end")] },
    ]);
  });

  /**
   * The usage of a cut-short turn is what had streamed when it stopped, so
   * it undercounts output. The pre-flight estimate is the floor, and the
   * figure is marked estimated either way. Rates: 1000 nanos per input
   * token, 5000 per output token; the estimate is 60_000.
   */
  it.each([
    ["below the estimate", { input_tokens: 10, output_tokens: 1 }, 60_000],
    ["above the estimate", { input_tokens: 100, output_tokens: 10 }, 150_000],
  ])(
    "books an interrupted call whose usage prices %s at no less than the estimate",
    async (_label, counts, bookedNanos) => {
      const { input, spans } = interruptedDuringFirstCall([cutShort([said("Opo")], counts)]);

      const result = await runAgentLoop(input);

      expect(result.costNanos).toBe(bookedNanos);
      expect(result.estimated).toBe(true);
      expect(result.usage).toEqual({
        inputTokens: counts.input_tokens,
        outputTokens: counts.output_tokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
      const llm = spans.filter((s) => s.type === "llm_call");
      expect(llm).toHaveLength(1);
      expect(llm[0]).toMatchObject({
        isError: false,
        costNanos: bookedNanos,
        estimated: true,
        output: { stop_reason: "interrupted" },
      });
    },
  );

  it("lets the running tool finish, and answers the calls after it with 'Not run'", async () => {
    const controller = new AbortController();
    const a = vi.fn(async () => {
      controller.abort();
      return { ok: "a" };
    });
    const b = vi.fn(async () => ({ ok: "b" }));
    const c = vi.fn(async () => ({ ok: "c" }));
    const { input, client } = loopInput(
      [
        turn([
          toolUse("a", { q: "1" }, "toolu_a"),
          toolUse("b", { q: "2" }, "toolu_b"),
          toolUse("c", { q: "3" }, "toolu_c"),
        ]),
        resolveTurn(),
      ],
      { signal: controller.signal, registry: watchedRegistry({ a, b, c }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: '{"ok":"a"}' },
        notRun("toolu_b"),
        notRun("toolu_c"),
      ],
    });
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it("makes no further model call when the caller interrupts during the last tool of a turn", async () => {
    const controller = new AbortController();
    const a = vi.fn(async () => {
      controller.abort();
      return { ok: "a" };
    });
    const { input, client } = loopInput(
      [turn([toolUse("a", { q: "1" }, "toolu_a")]), resolveTurn()],
      { signal: controller.signal, registry: watchedRegistry({ a }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_a", content: '{"ok":"a"}' }],
    });
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  /**
   * The abort can land after the stream finished but before the loop looked
   * at the turn. Nothing in it runs, and nothing waits for a human: the
   * caller is already talking.
   */
  it("runs nothing and pauses for nothing when the abort lands just after the model call returned", async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const content = [
      said("Sige po."),
      toolUse("get_account_overview", { q: "KF-1007" }, "toolu_read"),
      toolUse(
        "apply_bill_credit",
        { account_number: "KF-1002", amount_minor: 4900 },
        "toolu_credit",
      ),
    ];
    const { input } = interruptedDuringFirstCall(
      [turn(content, { usage: usage({ input_tokens: 10, output_tokens: 1 }) }), resolveTurn()],
      { registry: testRegistry({ handler: read }) },
    );

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(read).not.toHaveBeenCalled();
    expect(result.messages).toEqual([
      FIRST_USER,
      { role: "assistant", content },
      { role: "user", content: [notRun("toolu_read"), notRun("toolu_credit")] },
    ]);
    // The turn completed, so its usage is the bill: 10*1000 + 1*5000.
    expect(result.costNanos).toBe(15_000);
    expect(result.estimated).toBe(false);
  });

  it("ends as interrupted, not awaiting the caller, when the caller cut into a reply that had arrived", async () => {
    const { input } = interruptedDuringFirstCall([turn([said("Ano po ang account number ninyo?")])]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(result.messages).toEqual([
      FIRST_USER,
      { role: "assistant", content: [said("Ano po ang account number ninyo?")] },
    ]);
  });

  it("drops a silent turn the caller interrupted, without asking the model again", async () => {
    const { input, client } = interruptedDuringFirstCall([turn([]), resolveTurn()]);

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(result.messages).toEqual([FIRST_USER]);
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it("never calls the model when the caller interrupted before the turn began", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, client, spans } = loopInput([resolveTurn()], { signal: controller.signal });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("interrupted");
    expect(client.create).not.toHaveBeenCalled();
    expect(result.messages).toEqual([FIRST_USER]);
    expect(result.costNanos).toBe(0);
    expect(spans).toEqual([]);
  });

  /**
   * end_call stands alone in its turn, so once it is running there is nothing
   * left to skip. The disposition is decided: an interruption arriving while
   * it ran does not reopen the call.
   */
  it("still completes when the caller interrupts while end_call itself is running", async () => {
    const controller = new AbortController();
    const { input } = loopInput([resolveTurn("answered")], {
      signal: controller.signal,
      registry: buildRegistry([
        {
          ...endCallTool(),
          handler: async (callInput: unknown) => {
            controller.abort();
            return callInput;
          },
        },
      ]),
    });

    const result = await runAgentLoop(input);

    expect(result.status).toBe("completed");
    expect(result.outcome).toMatchObject({ action: "answered" });
  });
});
