import { describe, expect, it } from "vitest";

import type {
  AssistantTurn,
  ContentBlock,
  MessageCreateParams,
  MessageCreator,
  ToolResultBlock,
} from "../agent/loop";
import { anthropicProvider } from "../agent/provider";
import { loadPack, type PackSource } from "../pack/load-pack";
import {
  CALL_STARTED_AT,
  JOSE,
  MARIA,
  testPackSource,
} from "../testing/fixtures";

import { promptVersion } from "./pin";
import { createCallSession, type CallEvent } from "./session";

/**
 * The call session is Tala's main seam (spec #1, Q39). Unit tests, the
 * terminal chat, the eval suite and both voice paths drive Tala through it,
 * so these tests drive it the same way: caller turns in, events out.
 *
 * Behind it are only the fakes OpsPilot already used: a scripted Claude, the
 * in-memory world built from a seed, and an injected clock. Nothing here
 * needs a database or an API key.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const usage = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function turn(content: ContentBlock[], over: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_details: null,
    usage,
    ...over,
  };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });

let toolUseCount = 0;
function toolUse(name: string, input: unknown): ContentBlock {
  toolUseCount += 1;
  return { type: "tool_use", id: `toolu_${toolUseCount}`, name, input };
}

const verify = (who: { accountNumber: string; mobileLast4: string }) =>
  toolUse("verify_identity", {
    account_number: who.accountNumber,
    mobile_last4: who.mobileLast4,
  });

const checkOutage = (accountNumber: string) =>
  toolUse("check_area_outage", { account_number: accountNumber });

const DISPOSITION = {
  outcome: "resolved",
  topic: "outage",
  summary: "Caller asked about an outage; told them about the fiber cut and its restoration time.",
} as const;

/** A scripted Claude that records every request it is sent. */
function scriptedClaude(turns: AssistantTurn[]) {
  const requests: MessageCreateParams[] = [];
  const create: MessageCreator = (params) => {
    requests.push(structuredClone(params));
    const next = turns.shift();
    if (!next) return Promise.reject(new Error("scripted Claude ran out of turns"));
    return Promise.resolve(next);
  };
  return { create, requests };
}

/** One second per reading, from the call's start. */
function clockFrom(start: Date) {
  let t = start.getTime() - 1000;
  return () => new Date((t += 1000));
}

function newCall(
  turns: AssistantTurn[],
  options: { source?: PackSource; onEvent?: (event: CallEvent) => void } = {},
) {
  const claude = scriptedClaude(turns);
  const events: CallEvent[] = [];
  const pack = loadPack(options.source ?? testPackSource());
  const session = createCallSession({
    pack,
    model: "haiku",
    provider: anthropicProvider,
    createMessage: claude.create,
    callId: "call_1",
    clock: clockFrom(CALL_STARTED_AT),
    budget: {
      config: { dailyCapNanos: 1_000_000_000, killSwitch: false, runsPerMinute: 10 },
      spentTodayNanos: 0,
    },
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  return { session, events, claude, pack };
}

/** The tool results Claude was sent in a given request, by tool_use id. */
function toolResultsIn(request: MessageCreateParams): ToolResultBlock[] {
  const last = request.messages[request.messages.length - 1];
  if (!Array.isArray(last.content)) return [];
  return last.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

const types = (events: CallEvent[]) => events.map((e) => e.type);

/* -------------------------------------------------------------------------- */
/* The opening                                                                */
/* -------------------------------------------------------------------------- */

describe("a call session — the opening", () => {
  it("says the AI and recording disclosure before anything else, without calling Claude", () => {
    const { session, events, claude, pack } = newCall([]);

    session.start();

    expect(types(events)).toEqual(["call_started", "speech", "awaiting_caller"]);
    expect(events[1]).toEqual({ type: "speech", text: pack.persona.openingLine });
    expect(claude.requests).toHaveLength(0);
  });

  it("pins the call to its pack, SOP version, prompt, policy and model", () => {
    const { session, events } = newCall([]);

    session.start();

    expect(events[0]).toEqual({
      type: "call_started",
      callId: "call_1",
      at: CALL_STARTED_AT,
      pin: {
        packId: "test-isp",
        sopVersion: "v7",
        promptVersion: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
        policyVersion: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
        model: "haiku",
        modelId: "claude-haiku-5-5",
      },
    });
  });

  it("labels the pin with the version of the exact prompt Claude is sent", async () => {
    const { session, claude } = newCall([turn([text("Sige po.")])]);

    session.start();
    await session.callerSaid("Hello?");

    expect(session.pin.promptVersion).toBe(promptVersion(claude.requests[0].system));
  });

  /**
   * Review round 1: the pin named only the pack, SOP version and model, so a
   * policy edit, which changes both the enforced limit and the compiled
   * prompt, left two different calls with identical pins.
   */
  it("tells apart two calls whose policies differ under the same SOP version", () => {
    const strict = testPackSource();
    strict.policy = { identity: { maxFailedAttempts: 2 } };

    const a = newCall([]).session.pin;
    const b = newCall([], { source: strict }).session.pin;

    expect(a.sopVersion).toBe(b.sopVersion);
    expect(a.promptVersion).not.toBe(b.promptVersion);
    expect(a.policyVersion).not.toBe(b.policyVersion);
  });

  it("puts the opening line in the conversation Claude sees, before the caller's words", async () => {
    const { session, claude, pack } = newCall([turn([text("Ano po ang account number ninyo?")])]);

    session.start();
    await session.callerSaid("Wala po kaming internet.");

    const messages = claude.requests[0].messages;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: pack.persona.openingLine }],
    });
    expect(messages[2]).toEqual({ role: "user", content: "Wala po kaming internet." });
  });

  it("briefs Claude with the SOP compiled from the pack's own policy", async () => {
    const { session, claude } = newCall([turn([text("Sige po.")])]);

    session.start();
    await session.callerSaid("Hello?");

    const system = JSON.stringify(claude.requests[0].system);
    expect(system).toContain("locked after 3 failed attempts");
    expect(system).not.toContain("{{");
  });
});

/* -------------------------------------------------------------------------- */
/* Turns                                                                      */
/* -------------------------------------------------------------------------- */

describe("a call session — turns", () => {
  it("speaks a text-only reply and ends the turn awaiting the caller", async () => {
    const { session, events } = newCall([turn([text("Ano po ang account number ninyo?")])]);
    session.start();
    events.length = 0;

    const ended = await session.callerSaid("Wala po kaming internet.");

    expect(ended).toBe("awaiting_caller");
    expect(types(events)).toEqual(["caller_said", "speech", "span", "awaiting_caller"]);
    expect(events[1]).toEqual({ type: "speech", text: "Ano po ang account number ninyo?" });
  });

  it("numbers spans continuously across the caller's turns", async () => {
    const { session, events } = newCall([
      turn([text("Ano po ang account number ninyo?")]),
      turn([verify(MARIA)]),
      turn([text("Salamat po, verified na kayo.")]),
    ]);
    session.start();

    await session.callerSaid("Hello po.");
    await session.callerSaid(`${MARIA.accountNumber}, ${MARIA.mobileLast4}`);

    const seqs = events.flatMap((e) => (e.type === "span" ? [e.span.seq] : []));
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it("refuses caller words before the call has started", async () => {
    const { session } = newCall([]);

    await expect(session.callerSaid("Hello?")).rejects.toThrow(/not started/);
  });
});

/* -------------------------------------------------------------------------- */
/* The account gate                                                           */
/* -------------------------------------------------------------------------- */

describe("a call session — the account gate", () => {
  it("refuses to check an outage before the caller is verified", async () => {
    const { session, claude, events } = newCall([
      turn([checkOutage(MARIA.accountNumber)]),
      turn([text("Kailangan ko po munang i-verify ang account ninyo.")]),
    ]);
    session.start();

    await session.callerSaid("May outage po ba sa amin?");

    const [result] = toolResultsIn(claude.requests[1]);
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/not been verified/);
    const outageSpan = events.find(
      (e) => e.type === "span" && e.span.name === "check_area_outage",
    );
    expect(outageSpan).toMatchObject({ span: { type: "tool_exec", isError: true } });
  });

  it("reaches only the account verified on this call", async () => {
    const { session, claude } = newCall([
      turn([verify(JOSE)]),
      turn([checkOutage(MARIA.accountNumber)]),
      turn([text("Pasensya na po, hindi ko po ma-check ang account na iyon.")]),
    ]);
    session.start();

    await session.callerSaid("Pa-check din po ng outage sa account ng kapitbahay ko.");

    const [result] = toolResultsIn(claude.requests[2]);
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/different account/);
  });
});

/* -------------------------------------------------------------------------- */
/* Scenario 1: the Batasan Hills outage                                       */
/* -------------------------------------------------------------------------- */

describe("a call session — scenario 1", () => {
  it("tells a verified Batasan Hills caller the cause and the restoration time", async () => {
    const { session, claude } = newCall([
      turn([verify(MARIA), checkOutage(MARIA.accountNumber)]),
      turn([text("May fiber cut po sa Batasan Road; babalik po mga alas-singko.")]),
    ]);
    session.start();

    await session.callerSaid(
      `Wala po kaming internet. Account ${MARIA.accountNumber}, last four ${MARIA.mobileLast4}.`,
    );

    const [verified, outage] = toolResultsIn(claude.requests[1]);
    expect(verified.is_error).toBeUndefined();
    expect(JSON.parse(verified.content)).toMatchObject({ verified: true });
    expect(outage.is_error).toBeUndefined();
    expect(outage.content).toContain("fiber cable cut along Batasan Road");
    // The fixture's outage is back 240 minutes after a 1:00 PM Manila start.
    expect(outage.content).toContain("5:00 PM");
  });
});

/* -------------------------------------------------------------------------- */
/* Ending                                                                     */
/* -------------------------------------------------------------------------- */

describe("a call session — ending", () => {
  it("ends the call only through end_call, carrying its disposition and the code's own facts", async () => {
    const { session, events } = newCall([
      turn([verify(MARIA)]),
      turn([text("Salamat po sa pagtawag!"), toolUse("end_call", DISPOSITION)]),
    ]);
    session.start();

    const ended = await session.callerSaid(`${MARIA.accountNumber}, ${MARIA.mobileLast4}. Yun lang po.`);

    expect(ended).toBe("ended");
    expect(events.filter((e) => e.type === "speech").at(-1)).toEqual({
      type: "speech",
      text: "Salamat po sa pagtawag!",
    });
    expect(events.at(-1)).toMatchObject({
      type: "call_ended",
      reason: "end_call",
      disposition: DISPOSITION,
      verifiedAccount: MARIA.accountNumber,
      pin: { packId: "test-isp", sopVersion: "v7", model: "haiku" },
      error: null,
    });
  });

  it("refuses caller words after the call has ended", async () => {
    const { session } = newCall([turn([toolUse("end_call", DISPOSITION)])]);
    session.start();
    await session.callerSaid("Salamat, bye.");

    await expect(session.callerSaid("Hello?")).rejects.toThrow(/ended/);
  });

  it("says the fallback line and ends the call when Claude refuses", async () => {
    const { session, events, pack } = newCall([
      turn([text("partial")], {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null },
      }),
    ]);
    session.start();
    events.length = 0;

    const ended = await session.callerSaid("Hello?");

    expect(ended).toBe("ended");
    // A refused turn's own text is never spoken.
    expect(events.filter((e) => e.type === "speech")).toEqual([
      { type: "speech", text: pack.persona.fallbackLine },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "call_ended",
      reason: "refused",
      disposition: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Subscribers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Review round 1: speech was delivered from inside the model call, so a
 * subscriber that threw (a console whose socket closed) was booked as a model
 * failure. The turn Claude was paid for cost $0 in the trace, and the call
 * never emitted call_ended.
 */
describe("a call session — a subscriber that throws", () => {
  const boom = new Error("console socket closed");

  function llmSpans(events: CallEvent[]) {
    return events.flatMap((e) => (e.type === "span" && e.span.type === "llm_call" ? [e.span] : []));
  }

  it("still delivers the rest of the turn and books its cost, then reports the error", async () => {
    let armed = false;
    const { session, events } = newCall([turn([text("Ano po ang account number ninyo?")])], {
      onEvent: (event) => {
        if (armed && event.type === "speech") throw boom;
      },
    });
    session.start();
    armed = true;

    await expect(session.callerSaid("Hello po.")).rejects.toBe(boom);

    const [llm] = llmSpans(events);
    expect(llm.isError).toBe(false);
    expect(llm.costNanos).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: "awaiting_caller" });
    expect(session.state).toBe("in_progress");
  });

  it("still ends the call when the turn that ends it meets a throwing subscriber", async () => {
    let armed = false;
    const { session, events } = newCall(
      [turn([text("Salamat po!"), toolUse("end_call", DISPOSITION)])],
      {
        onEvent: (event) => {
          if (armed && event.type === "speech") throw boom;
        },
      },
    );
    session.start();
    armed = true;

    await expect(session.callerSaid("Bye po.")).rejects.toBe(boom);

    expect(events.at(-1)).toMatchObject({ type: "call_ended", reason: "end_call" });
    expect(session.state).toBe("ended");
  });
});
