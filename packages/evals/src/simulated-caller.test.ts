import { describe, expect, it } from "vitest";

import {
  anthropicProvider,
  loadPack,
  type AssistantTurn,
  type CallEvent,
  type CallSessionOptions,
  type ContentBlock,
  type MessageCreateParams,
  type MessageCreator,
  type PackSource,
  type SeedWorld,
} from "@tala/core";

import { observeCall } from "./observe";
import { runSimulatedCall, type SimulatedCallOptions } from "./simulated-caller";

/**
 * The simulated caller plays a case's caller against Tala, through the call
 * session only: the session's opening, then caller line, Tala's turn, next
 * caller line, until Tala's end_call or the case's turn cap.
 *
 * Both sides are scripted here through the same MessageCreator seam the live
 * suite uses, so nothing needs a key: one scripted Claude plays Tala, another
 * plays the caller.
 */

/* -------------------------------------------------------------------------- */
/* A small company pack and scripted turns                                    */
/* -------------------------------------------------------------------------- */

const WORLD: SeedWorld = {
  barangays: [{ id: "batasan-hills", name: "Batasan Hills", city: "Quezon City" }],
  accounts: [
    {
      accountNumber: "8012345601",
      holderName: "Maria Santos",
      registeredMobile: "+639175550101",
      status: "active",
      planName: "Kidlat 300",
      barangayId: "batasan-hills",
    },
  ],
  outages: [
    {
      reference: "OUT-2026-0412",
      cause: "a fiber cable cut along Batasan Road",
      barangayIds: ["batasan-hills"],
      startedMinutesBeforeCall: 150,
      restorationMinutesAfterCall: 240,
    },
  ],
  balances: [],
  bills: [],
  payments: [],
  modems: [],
  technicianSlots: [],
};

const OPENING = "Hello po! I'm Tala, an AI assistant, and this call is recorded.";

const SOURCE: PackSource = {
  id: "test-isp",
  sop: { version: "v1", body: "You are the assistant on Test ISP's support line.\n" },
  company: { name: "Test ISP", timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
  persona: {
    openingLine: OPENING,
    fallbackLine: "Sorry po, our system is having a problem. Please call again later.",
    fillerLine: "Sandali lang po.",
    closingLine: "Salamat po sa pagtawag!",
  },
  policy: { identity: { maxFailedAttempts: 3 } },
  plans: [{ id: "kidlat-300", name: "Kidlat 300", downloadMbps: 300, monthlyPriceMinor: 169_900 }],
  world: WORLD,
};

const BRIEF =
  "You are Maria Santos, account 8012345601, mobile ending 0101, in Batasan Hills. " +
  "Your internet has been down since this morning. You are satisfied once you know " +
  "the cause and when service returns.";

function usage(input = 10, output = 10) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function turn(content: ContentBlock[], over: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_details: null,
    usage: usage(),
    ...over,
  };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });

let toolUses = 0;
function toolUse(name: string, input: unknown): ContentBlock {
  toolUses += 1;
  return { type: "tool_use", id: `toolu_${toolUses}`, name, input };
}

const DISPOSITION = {
  outcome: "resolved",
  topic: "outage",
  summary: "Caller had no internet; told her about the fiber cut and when service returns.",
} as const;

/** A scripted Claude that records what it was asked. Each step is a turn or a failure. */
function scripted(steps: (AssistantTurn | Error)[]) {
  const requests: MessageCreateParams[] = [];
  const create: MessageCreator = (params) => {
    requests.push(structuredClone(params));
    const next = steps.shift();
    if (next === undefined) return Promise.reject(new Error("script ran out"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { create, requests };
}

/** Scenario 1 for Tala, one entry per model call. */
const scenarioOneTala = () => [
  turn([text("Sige po. May I have your account number and the last four of your mobile?")]),
  turn([
    text("Thank you po. Sandali lang, let me verify."),
    toolUse("verify_identity", { account_number: "8012345601", mobile_last4: "0101" }),
  ]),
  turn([
    text("Verified na po. Let me check your area."),
    toolUse("check_area_outage", { account_number: "8012345601" }),
  ]),
  turn([text("May fiber cut po along Batasan Road. Service should be back later today.")]),
  turn([text("Salamat po, ingat!"), toolUse("end_call", DISPOSITION)]),
];

const CALLER_LINES = [
  "Hello po, wala po kaming internet since this morning.",
  "8012345601 po, tapos 0101.",
  "Ah okay po, salamat. Bye po.",
];

function sessionOptions(tala: MessageCreator): Omit<CallSessionOptions, "onEvent"> {
  let t = new Date("2026-11-06T05:00:00Z").getTime();
  return {
    pack: loadPack(SOURCE),
    model: "sonnet",
    provider: anthropicProvider,
    createMessage: tala,
    callId: "call_eval",
    clock: () => new Date((t += 1000)),
    budget: {
      config: { dailyCapNanos: 1_000_000_000, killSwitch: false, runsPerMinute: 10 },
      spentTodayNanos: 0,
    },
  };
}

function simulate(
  tala: (AssistantTurn | Error)[],
  caller: (AssistantTurn | Error)[],
  over: Partial<SimulatedCallOptions> = {},
) {
  const talaClaude = scripted(tala);
  const callerClaude = scripted(caller);
  const run = runSimulatedCall({
    caller: { brief: BRIEF, maxTurns: 6 },
    session: sessionOptions(talaClaude.create),
    callerCreateMessage: callerClaude.create,
    ...over,
  });
  return { run, callerRequests: callerClaude.requests };
}

const saidByCaller = (events: CallEvent[]) =>
  events.flatMap((e) => (e.type === "caller_said" ? [e.text] : []));

/* -------------------------------------------------------------------------- */

describe("runSimulatedCall: a call to its end", () => {
  it("plays the caller's lines to Tala until her end_call", async () => {
    const { run } = simulate(scenarioOneTala(), CALLER_LINES.map((line) => turn([text(line)])));
    const result = await run;

    expect(result.stoppedBy).toBe("call_ended");
    expect(result.callerError).toBeNull();
    expect(result.callerTurns).toBe(3);
    expect(saidByCaller(result.events)).toEqual(CALLER_LINES);
    expect(observeCall(result.events, WORLD).endedBy).toBe("end_call");
  });

  /**
   * The caller hears Tala: her words are the user turns and its own lines the
   * assistant turns. Everything Tala said in one turn reaches it as one turn.
   */
  it("shows the caller Tala's words as user turns and its own lines as assistant turns", async () => {
    const { run, callerRequests } = simulate(
      scenarioOneTala(),
      CALLER_LINES.map((line) => turn([text(line)])),
    );
    await run;

    expect(callerRequests.map((r) => r.messages)).toEqual([
      [{ role: "user", content: OPENING }],
      [
        { role: "user", content: OPENING },
        { role: "assistant", content: [text(CALLER_LINES[0])] },
        {
          role: "user",
          content: "Sige po. May I have your account number and the last four of your mobile?",
        },
      ],
      [
        { role: "user", content: OPENING },
        { role: "assistant", content: [text(CALLER_LINES[0])] },
        {
          role: "user",
          content: "Sige po. May I have your account number and the last four of your mobile?",
        },
        { role: "assistant", content: [text(CALLER_LINES[1])] },
        {
          role: "user",
          content:
            "Thank you po. Sandali lang, let me verify. Verified na po. Let me check your area. " +
            "May fiber cut po along Batasan Road. Service should be back later today.",
        },
      ],
    ]);
  });

  /**
   * Append-only, like Tala's own conversation: the 5.5 models bind thinking
   * blocks to the conversation that produced them, so the caller's turns go
   * back exactly as they came. Only the words reach Tala.
   */
  it("keeps the caller's own turns as they came back, thinking included, and says only the words", async () => {
    const thinking: ContentBlock = { type: "thinking", thinking: "", signature: "sig_1" };
    const { run, callerRequests } = simulate(scenarioOneTala(), [
      turn([thinking, text("  Hello po, wala po kaming internet.  ")]),
      turn([text(CALLER_LINES[1])]),
      turn([text(CALLER_LINES[2])]),
    ]);
    const result = await run;

    expect(callerRequests[1].messages[1]).toEqual({
      role: "assistant",
      content: [thinking, text("  Hello po, wala po kaming internet.  ")],
    });
    expect(saidByCaller(result.events)[0]).toBe("Hello po, wala po kaming internet.");
  });

  it("stops asking the caller once Tala has ended the call", async () => {
    const { run, callerRequests } = simulate(
      [turn([text("Salamat po, ingat!"), toolUse("end_call", DISPOSITION)])],
      CALLER_LINES.map((line) => turn([text(line)])),
    );
    const result = await run;

    expect(result.stoppedBy).toBe("call_ended");
    expect(callerRequests).toHaveLength(1);
  });

  it("hands every session event to onEvent as it happens", async () => {
    const seen: CallEvent[] = [];
    const { run } = simulate(scenarioOneTala(), CALLER_LINES.map((line) => turn([text(line)])), {
      onEvent: (event) => seen.push(event),
    });
    const result = await run;

    expect(seen).toEqual(result.events);
  });
});

describe("runSimulatedCall: the caller's brief and model", () => {
  it("briefs the caller with the case's brief, gives it no tools, and uses Sonnet by default", async () => {
    const { run, callerRequests } = simulate(
      [turn([text("Salamat po!"), toolUse("end_call", DISPOSITION)])],
      [turn([text("Hello po.")])],
    );
    await run;

    const [request] = callerRequests;
    expect(request.system).toContain(BRIEF);
    expect(request.system).toMatch(/aloud/);
    expect(request.system).toMatch(/cannot (hang up|end the call)/);
    expect(request.tools).toEqual([]);
    expect(request.model).toBe(anthropicProvider.modelId("sonnet"));
  });

  it("uses the caller model it is given", async () => {
    const { run, callerRequests } = simulate(
      [turn([text("Salamat po!"), toolUse("end_call", DISPOSITION)])],
      [turn([text("Hello po.")])],
      { callerModel: "haiku" },
    );
    await run;

    expect(callerRequests[0].model).toBe(anthropicProvider.modelId("haiku"));
  });
});

describe("runSimulatedCall: the turn cap", () => {
  /** Only Tala's end_call ends a call; a caller who runs out of turns leaves it open. */
  it("stops after maxTurns caller turns and leaves the call not_ended", async () => {
    const { run, callerRequests } = simulate(
      [turn([text("Ano po ang account number ninyo?")]), turn([text("Pakiulit po?")])],
      [turn([text("Hello po.")]), turn([text("Hello po?")]), turn([text("Hello?")])],
      { caller: { brief: BRIEF, maxTurns: 2 } },
    );
    const result = await run;

    expect(result.stoppedBy).toBe("turn_cap");
    expect(result.callerTurns).toBe(2);
    expect(callerRequests).toHaveLength(2);
    expect(saidByCaller(result.events)).toEqual(["Hello po.", "Hello po?"]);
    expect(observeCall(result.events, WORLD).endedBy).toBe("not_ended");
  });
});

describe("runSimulatedCall: when the caller cannot go on", () => {
  /** What Tala already spent is real; the events are kept so the run can count it. */
  it("stops on a failed caller model call, says why, and keeps the call so far", async () => {
    const { run } = simulate(scenarioOneTala(), [
      turn([text(CALLER_LINES[0])]),
      new Error("overloaded"),
    ]);
    const result = await run;

    expect(result.stoppedBy).toBe("caller_failed");
    expect(result.callerError).toBe("the simulated caller's model call failed: overloaded");
    expect(result.callerTurns).toBe(1);
    expect(result.events.filter((e) => e.type === "span")).toHaveLength(1);
    expect(result.callerCalls.map((c) => c.isError)).toEqual([false, true]);
    expect(result.callerCalls[1]).toMatchObject({ usage: null, costNanos: 0 });
  });

  it("stops on a refused caller turn and says none of it to Tala", async () => {
    const { run } = simulate(scenarioOneTala(), [
      turn([text("I will not.")], { stop_reason: "refusal" }),
    ]);
    const result = await run;

    expect(result.stoppedBy).toBe("caller_failed");
    expect(result.callerError).toBe("the simulated caller's model refused");
    expect(saidByCaller(result.events)).toEqual([]);
  });

  it("stops on a caller turn with no words in it", async () => {
    const { run } = simulate(scenarioOneTala(), [
      turn([{ type: "thinking", thinking: "", signature: "s" }, text("   ")]),
    ]);
    const result = await run;

    expect(result.stoppedBy).toBe("caller_failed");
    expect(result.callerError).toBe("the simulated caller said nothing");
    expect(saidByCaller(result.events)).toEqual([]);
  });
});

describe("runSimulatedCall: what the caller cost", () => {
  /**
   * Priced with the caller model's own rate card. Sonnet 5.5 is $2 / $10 per
   * million tokens and Haiku 5.5 $0.10 / $0.50 (the pricing page), so 1,000
   * input and 200 output tokens are $0.004 and $0.0002.
   */
  it.each([
    ["sonnet", 4_000_000],
    ["haiku", 200_000],
  ] as const)("prices each %s caller call from its real usage", async (callerModel, nanos) => {
    const { run } = simulate(
      [turn([text("Salamat po!"), toolUse("end_call", DISPOSITION)])],
      [turn([text("Hello po.")], { usage: usage(1000, 200) })],
      { callerModel },
    );
    const result = await run;

    expect(result.callerCalls).toEqual([
      {
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        costNanos: nanos,
        estimated: false,
        isError: false,
      },
    ]);
  });

  /** A refused turn was generated and billed, so it is counted like any other. */
  it("counts a refused caller call's usage", async () => {
    const { run } = simulate(scenarioOneTala(), [
      turn([], { stop_reason: "refusal", usage: usage(1000, 200) }),
    ]);
    const result = await run;

    expect(result.callerCalls).toEqual([
      expect.objectContaining({ costNanos: 4_000_000, isError: false }),
    ]);
  });
});
