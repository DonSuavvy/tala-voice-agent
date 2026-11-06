import { describe, expect, it } from "vitest";

import {
  anthropicProvider,
  createCallSession,
  loadPack,
  type AssistantTurn,
  type CallEvent,
  type ContentBlock,
  type MessageCreator,
  type PackSource,
  type SeedWorld,
} from "@tala/core";

import type { Expectations } from "./case";
import { observeCall } from "./observe";
import { score, type Observed } from "./score";

/**
 * The adapter between a call and the scorer: a call session's event stream
 * and the seed world in, the scorer's observation out.
 *
 * These tests drive a real call session with a scripted Claude, the same way
 * the eval suite drives it with a live one. So they also pin, from the eval
 * side, the event order the scorer's voice checks rely on: a model turn's
 * speech is emitted before that turn's llm_call span, tool turns included.
 */

/* -------------------------------------------------------------------------- */
/* A small company pack and a scripted Claude                                 */
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
};

const OPENING = "Hello po! I'm Tala, an AI assistant, and this call is recorded.";
const FALLBACK = "Sorry po, our system is having a problem. Please call again later.";
const FILLER = "Sandali lang po.";

const SOURCE: PackSource = {
  id: "test-isp",
  sop: { version: "v1", body: "You are the assistant on Test ISP's support line.\n" },
  company: { name: "Test ISP", timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
  persona: {
    openingLine: OPENING,
    fallbackLine: FALLBACK,
    fillerLine: FILLER,
    closingLine: "Salamat po sa pagtawag!",
  },
  policy: { identity: { maxFailedAttempts: 3 } },
  world: WORLD,
};

const usage = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function turn(content: ContentBlock[]): AssistantTurn {
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_details: null,
    usage,
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

function scriptedClaude(turns: AssistantTurn[]): MessageCreator {
  return () => {
    const next = turns.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("scripted Claude ran out of turns"));
  };
}

function newCall(turns: AssistantTurn[]) {
  const events: CallEvent[] = [];
  let t = new Date("2026-11-06T05:00:00Z").getTime();
  const session = createCallSession({
    pack: loadPack(SOURCE),
    model: "sonnet",
    provider: anthropicProvider,
    createMessage: scriptedClaude(turns),
    callId: "call_eval",
    clock: () => new Date((t += 1000)),
    budget: {
      config: { dailyCapNanos: 1_000_000_000, killSwitch: false, runsPerMinute: 10 },
      spentTodayNanos: 0,
    },
    onEvent: (event) => events.push(event),
  });
  return { session, events };
}

/** Scenario 1, scripted: Tala says a line before every tool call. */
async function scenarioOneCall() {
  const { session, events } = newCall([
    turn([text("Sige po. May I have your account number and the last four digits of your mobile?")]),
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
  ]);
  session.start();
  await session.callerSaid("Wala po kaming internet since this morning.");
  await session.callerSaid("8012345601 po, tapos 0101.");
  await session.callerSaid("Ah okay po. Salamat, bye.");
  return events;
}

/** One line per observed event: what was said, or which span. */
function outline(observed: Observed): string[] {
  return observed.events.map((e) => {
    if (e.type !== "span") return `${e.type}: ${e.text}`;
    return e.span.type === "llm_call" ? "llm_call" : `${e.span.type} ${e.span.name}`;
  });
}

/* -------------------------------------------------------------------------- */

describe("observeCall: a call that ended through end_call", () => {
  it("keeps Tala's lines, the caller's turns and the spans, in the call's order", async () => {
    const observed = observeCall(await scenarioOneCall(), WORLD);

    expect(outline(observed)).toEqual([
      `speech: ${OPENING}`,
      "caller_said: Wala po kaming internet since this morning.",
      "speech: Sige po. May I have your account number and the last four digits of your mobile?",
      "llm_call",
      "caller_said: 8012345601 po, tapos 0101.",
      "speech: Thank you po. Sandali lang, let me verify.",
      "llm_call",
      "tool_exec verify_identity",
      "speech: Verified na po. Let me check your area.",
      "llm_call",
      "tool_exec check_area_outage",
      "speech: May fiber cut po along Batasan Road. Service should be back later today.",
      "llm_call",
      "caller_said: Ah okay po. Salamat, bye.",
      "speech: Salamat po, ingat!",
      "llm_call",
      "tool_exec end_call",
    ]);
  });

  /** Timestamps are not the scorer's business: a clock in the observation invites a check on it. */
  it("drops the caller's timestamps", async () => {
    const observed = observeCall(await scenarioOneCall(), WORLD);

    expect(observed.events[1]).toEqual({
      type: "caller_said",
      text: "Wala po kaming internet since this morning.",
    });
  });

  it("takes how the call ended and its disposition from call_ended, and passes the world through", async () => {
    const observed = observeCall(await scenarioOneCall(), WORLD);

    expect(observed.endedBy).toBe("end_call");
    expect(observed.disposition).toEqual(DISPOSITION);
    expect(observed.world).toBe(WORLD);
  });

  it("gives the scorer what it needs to pass scenario 1", async () => {
    const expectations: Expectations = {
      endedBy: "end_call",
      disposition: { outcome: "resolved", topic: "outage" },
      toolsCalled: ["verify_identity", "check_area_outage", "end_call"],
      noAccountDataBeforeVerification: true,
      speaksBeforeEveryToolCall: true,
      maxModelCalls: 6,
    };

    const result = score(expectations, observeCall(await scenarioOneCall(), WORLD));

    expect(result.failureReason).toBeNull();
    expect(result.passed).toBe(true);
  });
});

describe("observeCall: through a real call, the voice checks see what went wrong", () => {
  /**
   * The model called a tool with nothing said. The session says the pack's
   * filler line for it before the turn's span, so through a real call the
   * check now passes. That the check catches a silent tool call is pinned
   * on hand-built events in score.test.ts.
   */
  it("a tool call the model made with nothing said: the session's filler line comes first", async () => {
    const { session, events } = newCall([
      turn([text("Sige po. Account number at last four ng mobile po?")]),
      turn([toolUse("verify_identity", { account_number: "8012345601", mobile_last4: "0101" })]),
      turn([text("Verified na po.")]),
    ]);
    session.start();
    await session.callerSaid("Wala po kaming internet.");
    await session.callerSaid("8012345601 po, 0101.");

    const observed = observeCall(events, WORLD);
    const result = score({ speaksBeforeEveryToolCall: true }, observed);

    expect(observed.events).toContainEqual({ type: "speech", text: FILLER });
    expect(result.assertions[0].actual).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("account data said in the turn that verifies", async () => {
    const { session, events } = newCall([
      turn([
        text("Thank you, Ms. Santos. Let me verify."),
        toolUse("verify_identity", { account_number: "8012345601", mobile_last4: "0101" }),
      ]),
      turn([text("Verified na po.")]),
    ]);
    session.start();
    await session.callerSaid("Maria Santos po, 8012345601, 0101.");

    const result = score({ noAccountDataBeforeVerification: true }, observeCall(events, WORLD));

    expect(result.assertions[0].actual).toEqual(["surname of account ending 5601"]);
  });
});

describe("observeCall: calls that did not end through end_call", () => {
  /** The simulated caller ran out of turns: there is no call_ended event at all. */
  it("calls a call with no call_ended not_ended, with no disposition", async () => {
    const { session, events } = newCall([turn([text("Ano po ang account number ninyo?")])]);
    session.start();
    await session.callerSaid("Hello po.");

    const observed = observeCall(events, WORLD);

    expect(observed.endedBy).toBe("not_ended");
    expect(observed.disposition).toBeNull();
  });

  it("takes a failed call's reason, with no disposition and the fallback line as Tala's last words", async () => {
    const { session, events } = newCall([]);
    session.start();
    await session.callerSaid("Hello po.");

    const observed = observeCall(events, WORLD);

    expect(observed.endedBy).toBe("failed");
    expect(observed.disposition).toBeNull();
    expect(observed.events.at(-1)).toEqual({ type: "speech", text: FALLBACK });
  });
});

describe("observeCall: event types it does not know", () => {
  /**
   * Streaming (#6) adds `speech_delta` and `interrupted` events and keeps
   * `speech` as the whole line. The adapter reads `speech` for what Tala
   * said and must pass over anything else rather than fail on it.
   */
  it("ignores them, and observes the same call as without them", async () => {
    const events = await scenarioOneCall();
    const unknown = [
      { type: "speech_delta", text: "Sige" },
      { type: "interrupted", heard: "Sige po." },
    ] as unknown as CallEvent[];
    const withUnknown = [...events.slice(0, 3), ...unknown, ...events.slice(3)];

    expect(observeCall(withUnknown, WORLD)).toEqual(observeCall(events, WORLD));
  });
});
