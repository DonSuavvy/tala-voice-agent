import { describe, expect, it, vi } from "vitest";

import type {
  AssistantTurn,
  ContentBlock,
  MessageCreateParams,
  MessageCreator,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
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

type CallOptions = { source?: PackSource; onEvent?: (event: CallEvent) => void };

function callWith(create: MessageCreator, options: CallOptions) {
  const events: CallEvent[] = [];
  const pack = loadPack(options.source ?? testPackSource());
  const session = createCallSession({
    pack,
    model: "haiku",
    provider: anthropicProvider,
    createMessage: create,
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
  return { session, events, pack };
}

function newCall(turns: AssistantTurn[], options: CallOptions = {}) {
  const claude = scriptedClaude(turns);
  return { ...callWith(claude.create, options), claude };
}

/* -------------------------------------------------------------------------- */
/* A streaming Claude                                                         */
/* -------------------------------------------------------------------------- */

/** A text block that streams as these deltas, in order. */
class Say {
  constructor(readonly deltas: string[]) {}
}
const say = (...deltas: string[]) => new Say(deltas);

interface StreamedTurn {
  /** In order. Text streams delta by delta; every other block arrives whole. */
  parts: (Say | ContentBlock)[];
  stop_reason?: string;
  stop_details?: AssistantTurn["stop_details"];
  usage?: AssistantTurn["usage"];
  /**
   * How many more steps, deltas or blocks, still arrive after the abort, as
   * they did live: an abort takes a moment to land. `Infinity` lets the
   * stream finish, as when the abort lands just after its last event.
   */
  lag?: number;
}

/** What a cut-short stream reports: the input, and barely any output. */
const CUT_USAGE = {
  input_tokens: 10,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * A scripted Claude that streams the way the production creator does: each
 * text delta goes to `onTextDelta` as it arrives, and an aborted signal ends
 * the stream with what had arrived, marked `stop_reason: "interrupted"` and
 * cleaned of empty text (streaming.test.ts pins the real one). It records
 * every request it is sent and every turn it returns.
 */
function streamingClaude(turns: StreamedTurn[]) {
  const requests: MessageCreateParams[] = [];
  const returned: AssistantTurn[] = [];

  const create: MessageCreator = async (params, options) => {
    requests.push(structuredClone(params));
    const next = turns.shift();
    if (!next) throw new Error("scripted Claude ran out of turns");

    let lag = next.lag ?? 0;
    const stopped = () => {
      if (options?.signal?.aborted !== true) return false;
      if (lag > 0) {
        lag -= 1;
        return false;
      }
      return true;
    };

    const content: ContentBlock[] = [];
    let cut = false;
    stream: for (const part of next.parts) {
      if (part instanceof Say) {
        const block: TextBlock = { type: "text", text: "" };
        content.push(block);
        for (const delta of part.deltas) {
          if (stopped()) {
            cut = true;
            break stream;
          }
          block.text += delta;
          options?.onTextDelta?.(delta);
          await Promise.resolve();
        }
      } else {
        if (stopped()) {
          cut = true;
          break;
        }
        content.push(part);
      }
    }

    const turn: AssistantTurn = cut
      ? {
          content: content.filter((b) => b.type !== "text" || String(b.text).trim() !== ""),
          stop_reason: "interrupted",
          stop_details: null,
          usage: CUT_USAGE,
        }
      : {
          content,
          stop_reason:
            next.stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
          stop_details: next.stop_details ?? null,
          usage: next.usage ?? usage,
        };
    returned.push(structuredClone(turn));
    return turn;
  };

  return { create, requests, returned };
}

function newStreamedCall(turns: StreamedTurn[], options: CallOptions = {}) {
  const claude = streamingClaude(turns);
  return { ...callWith(claude.create, options), claude };
}

/**
 * A streamed call whose caller talks over Tala the first time `when` matches
 * an event, reporting `heard` (or leaving the default).
 */
function interruptWhen(
  turns: StreamedTurn[],
  when: (event: CallEvent) => boolean,
  heard?: string,
) {
  let interrupting: Promise<void> | null = null;
  const call = newStreamedCall(turns, {
    onEvent: (event) => {
      if (interrupting === null && when(event)) {
        interrupting = call.session.interrupt(heard);
        // Handled here, so a rejection is the test's to inspect rather than
        // an unhandled one.
        void interrupting.catch(() => {});
      }
    },
  });
  return { ...call, interrupting: () => interrupting };
}

/** Matches Tala's nth speech_delta of the caller turn now running. */
function nthDelta(n: number) {
  let inTurn = false;
  let seen = 0;
  return (event: CallEvent) => {
    // The opening line is spoken as a delta too; count from the caller's words.
    if (event.type === "caller_said") {
      inTurn = true;
      seen = 0;
    }
    return inTurn && event.type === "speech_delta" && ++seen === n;
  };
}

/**
 * What "valid for the next API call" means, checked across every request a
 * call sent:
 *
 * - the conversation opens with a user message;
 * - no assistant message is empty or carries blank text;
 * - every tool_use is answered in the user message straight after it;
 * - every thinking block is one the model returned, unmodified and in order;
 * - every request repeats the one before it byte for byte, then appends.
 */
function expectValidConversation(claude: {
  requests: MessageCreateParams[];
  returned: AssistantTurn[];
}) {
  const thinking = claude.returned.flatMap((t) =>
    t.content.filter((b) => b.type === "thinking").map((b) => JSON.stringify(b)),
  );

  claude.requests.forEach((request, r) => {
    const { messages } = request;
    expect(messages[0]?.role, `request ${r}: first message`).toBe("user");

    let lastThinking = -1;
    messages.forEach((message, m) => {
      if (message.role !== "assistant") return;
      const where = `request ${r}, message ${m}`;
      const blocks: ContentBlock[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content;
      expect(blocks.length, `${where}: empty assistant message`).toBeGreaterThan(0);

      for (const block of blocks) {
        if (block.type === "text") {
          expect(String(block.text).trim(), `${where}: blank text`).not.toBe("");
        }
        if (block.type === "thinking") {
          const at = thinking.indexOf(JSON.stringify(block), lastThinking + 1);
          expect(at, `${where}: a thinking block modified or out of order`).toBeGreaterThan(
            lastThinking,
          );
          lastThinking = at;
        }
      }

      const ids = blocks.flatMap((b) => (b.type === "tool_use" ? [String(b.id)] : []));
      if (ids.length > 0) {
        const next = messages[m + 1];
        const answered =
          next?.role === "user" && Array.isArray(next.content)
            ? next.content.flatMap((b) => (b.type === "tool_result" ? [String(b.tool_use_id)] : []))
            : [];
        expect(answered, `${where}: a tool_use without its tool_result`).toEqual(
          expect.arrayContaining(ids),
        );
      }
    });

    if (r > 0) {
      const before = claude.requests[r - 1];
      expect(
        JSON.stringify(messages.slice(0, before.messages.length)),
        `request ${r}: an earlier message changed`,
      ).toBe(JSON.stringify(before.messages));
      expect(JSON.stringify(request.system), `request ${r}: the system prompt changed`).toBe(
        JSON.stringify(before.system),
      );
      expect(JSON.stringify(request.tools), `request ${r}: the tools changed`).toBe(
        JSON.stringify(before.tools),
      );
    }
  });
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

    // As every line Tala says: the whole line as one delta, then its speech.
    expect(types(events)).toEqual(["call_started", "speech_delta", "speech", "awaiting_caller"]);
    expect(events[1]).toEqual({ type: "speech_delta", text: pack.persona.openingLine });
    expect(events[2]).toEqual({ type: "speech", text: pack.persona.openingLine });
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

  it("says the fallback line as one speech_delta, then its speech, before the call ends", async () => {
    // No scripted turns: the model call fails, and the call ends badly.
    const { session, events, pack } = newCall([]);
    session.start();
    events.length = 0;

    await session.callerSaid("Hello?");

    expect(types(events)).toEqual(["caller_said", "span", "speech_delta", "speech", "call_ended"]);
    expect(events[2]).toEqual({ type: "speech_delta", text: pack.persona.fallbackLine });
    expect(events[3]).toEqual({ type: "speech", text: pack.persona.fallbackLine });
  });
});

/* -------------------------------------------------------------------------- */
/* Streaming speech                                                           */
/* -------------------------------------------------------------------------- */

describe("a call session — streaming speech", () => {
  it("emits each text delta as speech_delta, in order, before the turn's speech and awaiting_caller", async () => {
    const { session, events } = newStreamedCall([
      { parts: [say("Ano po ", "ang account number ", "ninyo?")] },
    ]);
    session.start();
    events.length = 0;

    const ended = await session.callerSaid("Wala po kaming internet.");

    expect(ended).toBe("awaiting_caller");
    expect(types(events)).toEqual([
      "caller_said",
      "speech_delta",
      "speech_delta",
      "speech_delta",
      "speech",
      "span",
      "awaiting_caller",
    ]);
    expect(events.filter((e) => e.type === "speech_delta")).toEqual([
      { type: "speech_delta", text: "Ano po " },
      { type: "speech_delta", text: "ang account number " },
      { type: "speech_delta", text: "ninyo?" },
    ]);
    expect(events[4]).toEqual({ type: "speech", text: "Ano po ang account number ninyo?" });
  });

  /**
   * The eval suite's speaksBeforeEveryToolCall check reads this order: what a
   * model turn says comes before its llm_call span, and so before any tool
   * that turn runs.
   */
  it("says each model turn before its llm_call span, in a tool turn and a text-only one", async () => {
    const { session, events } = newStreamedCall([
      { parts: [say("Sige po, ", "iche-check ko."), verify(MARIA)] },
      { parts: [say("Verified na po kayo.")] },
    ]);
    session.start();
    events.length = 0;

    await session.callerSaid(`${MARIA.accountNumber}, ${MARIA.mobileLast4}`);

    const order = events.flatMap((e) =>
      e.type === "speech"
        ? [`speech: ${e.text}`]
        : e.type === "span"
          ? [`${e.span.type}: ${e.span.name}`]
          : [],
    );
    expect(order).toEqual([
      "speech: Sige po, iche-check ko.",
      "llm_call: claude-haiku-5-5",
      "tool_exec: verify_identity",
      "speech: Verified na po kayo.",
      "llm_call: claude-haiku-5-5",
    ]);
  });

  it("books a streamed turn's usage on its llm_call span exactly as the model reported it", async () => {
    const { session, events } = newStreamedCall([
      {
        parts: [say("Opo, ", "may outage po.")],
        usage: {
          input_tokens: 2400,
          output_tokens: 87,
          cache_creation_input_tokens: 512,
          cache_read_input_tokens: 6100,
        },
      },
    ]);
    session.start();

    await session.callerSaid("May outage po ba?");

    const llm = events.flatMap((e) => (e.type === "span" && e.span.type === "llm_call" ? [e.span] : []));
    expect(llm).toHaveLength(1);
    expect(llm[0].usage).toEqual({
      inputTokens: 2400,
      outputTokens: 87,
      cacheCreationInputTokens: 512,
      cacheReadInputTokens: 6100,
    });
  });

  /**
   * A refusal is only known once the turn is complete, and by then its
   * deltas have streamed: they were heard. The turn's speech event, which
   * says what Tala stands behind, is still never emitted for it.
   */
  it("streams a refused turn's deltas but never speaks it as speech", async () => {
    const { session, events, pack } = newStreamedCall([
      {
        parts: [say("Ito po ", "ang sagot")],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null },
      },
    ]);
    session.start();
    events.length = 0;

    const ended = await session.callerSaid("Hello?");

    expect(ended).toBe("ended");
    // The refused words were heard as they streamed; the apology follows.
    expect(events.filter((e) => e.type === "speech_delta")).toEqual([
      { type: "speech_delta", text: "Ito po " },
      { type: "speech_delta", text: "ang sagot" },
      { type: "speech_delta", text: pack.persona.fallbackLine },
    ]);
    expect(events.filter((e) => e.type === "speech")).toEqual([
      { type: "speech", text: pack.persona.fallbackLine },
    ]);
  });

  /**
   * One rule for every consumer: a voice that speaks only speech_delta hears
   * every line Tala says, the fixed lines included, and each speech event
   * records an utterance whose words have already gone out as deltas.
   */
  it("lets a consumer that speaks only speech_delta hear every line Tala says", async () => {
    const { session, events, pack } = newStreamedCall([
      { parts: [say("Sige po, ", "iche-check ko."), verify(MARIA)] },
      { parts: [say("Verified na po ", "kayo.")] },
      // Nothing scripted after this, so the next caller turn fails and the
      // call ends with the fallback line.
    ]);

    session.start();
    await session.callerSaid(`${MARIA.accountNumber}, ${MARIA.mobileLast4}`);
    await session.callerSaid("May outage po ba?");

    let deltas = "";
    let spoken = "";
    for (const event of events) {
      if (event.type === "speech_delta") deltas += event.text;
      if (event.type === "speech") {
        spoken += event.text;
        expect(deltas.startsWith(spoken), `speech before its deltas: ${event.text}`).toBe(true);
      }
    }
    expect(deltas).toBe(spoken);
    expect(spoken).toBe(
      pack.persona.openingLine +
        "Sige po, iche-check ko." +
        "Verified na po kayo." +
        pack.persona.fallbackLine,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* An interruption                                                            */
/* -------------------------------------------------------------------------- */

describe("a call session — an interruption", () => {
  const NOT_RUN = "Not run: the caller interrupted.";

  it("stops Tala mid-sentence, says so, and keeps what the caller heard", async () => {
    const call = interruptWhen(
      [
        { parts: [say("Opo, ", "sandali lang po, ", "iche-check ko.")] },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(2),
    );
    call.session.start();
    call.events.length = 0;

    const ended = await call.session.callerSaid("Wala po kaming internet.");
    await call.interrupting();

    expect(ended).toBe("interrupted");
    expect(types(call.events)).toEqual([
      "caller_said",
      "speech_delta",
      "speech_delta",
      "speech",
      "span",
      "interrupted",
    ]);
    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "Opo, sandali lang po, " });

    await call.session.callerSaid("Ha? Hindi ko po narinig.");

    expect(call.claude.requests[1].messages.slice(-3)).toEqual([
      { role: "user", content: "Wala po kaming internet." },
      { role: "assistant", content: [{ type: "text", text: "Opo, sandali lang po, " }] },
      { role: "user", content: "Ha? Hindi ko po narinig." },
    ]);
    expectValidConversation(call.claude);
  });

  /**
   * Live, a delta or two still arrived after the abort. The caller never
   * heard them, so they are not spoken and not kept.
   */
  it("says nothing more after interrupt(), though the stream ran on a little", async () => {
    const call = interruptWhen(
      [
        { parts: [say("Opo, ", "sandali lang po, ", "iche-check ko ", "ang outage.")], lag: 1 },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(2),
    );
    call.session.start();
    call.events.length = 0;

    await call.session.callerSaid("Wala po kaming internet.");

    expect(
      call.events.flatMap((e) => (e.type === "speech_delta" ? [e.text] : [])),
    ).toEqual(["Opo, ", "sandali lang po, "]);
    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "Opo, sandali lang po, " });

    await call.session.callerSaid("Ha?");

    expect(call.claude.requests[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Opo, sandali lang po," }],
    });
    expectValidConversation(call.claude);
  });

  it("keeps only the heard prefix the transport reports, surrounding whitespace aside", async () => {
    const call = interruptWhen(
      [
        { parts: [say("Opo, ", "sandali lang po, ", "iche-check ko.")] },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(3),
      "  Opo, sandali ",
    );
    call.session.start();

    const ended = await call.session.callerSaid("Wala po kaming internet.");

    expect(ended).toBe("interrupted");
    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "  Opo, sandali " });

    await call.session.callerSaid("Ha?");

    expect(call.claude.requests[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Opo, sandali" }],
    });
    expectValidConversation(call.claude);
  });

  it("refuses a heard text that is not a prefix of what Tala said, and lets her turn run on", async () => {
    const call = interruptWhen(
      [{ parts: [say("Opo, ", "sandali lang po.")] }],
      nthDelta(1),
      "Hello po",
    );
    call.session.start();

    const ended = await call.session.callerSaid("Wala po kaming internet.");

    const interrupting = call.interrupting();
    expect(interrupting, "interrupt() was called on the first delta").not.toBeNull();
    await expect(interrupting!).rejects.toThrow(
      /heard "Hello po" is not a prefix of what Tala has said/,
    );
    expect(ended).toBe("awaiting_caller");
    expect(call.events.filter((e) => e.type === "speech")).toContainEqual({
      type: "speech",
      text: "Opo, sandali lang po.",
    });
  });

  /**
   * A tool call Tala never got to announce is dropped with the words the
   * caller did not hear, so it is neither run nor answered. A signed thinking
   * block must never follow text that was cut, so everything after the cut
   * goes.
   */
  it("drops the tool call after a sentence the caller cut short", async () => {
    const outage = checkOutage(MARIA.accountNumber);
    const call = interruptWhen(
      [
        { parts: [say("Sige po, ", "iche-check ko ", "ang outage."), outage], lag: Infinity },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(3),
      "Sige po,",
    );
    call.session.start();

    const ended = await call.session.callerSaid("May outage po ba?");

    expect(ended).toBe("interrupted");
    expect(call.events.some((e) => e.type === "span" && e.span.type === "tool_exec")).toBe(false);

    await call.session.callerSaid("Ha?");

    expect(call.claude.requests[1].messages.slice(-3)).toEqual([
      { role: "user", content: "May outage po ba?" },
      { role: "assistant", content: [{ type: "text", text: "Sige po," }] },
      { role: "user", content: "Ha?" },
    ]);
    expectValidConversation(call.claude);
  });

  it("answers a finished tool call 'Not run' when the caller heard everything before it", async () => {
    const outage = checkOutage(MARIA.accountNumber) as ToolUseBlock;
    const call = interruptWhen(
      [
        { parts: [say("Sige po, ", "iche-check ko."), outage], lag: Infinity },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(2),
    );
    call.session.start();

    const ended = await call.session.callerSaid("May outage po ba?");

    expect(ended).toBe("interrupted");
    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "Sige po, iche-check ko." });

    await call.session.callerSaid("Ha?");

    expect(call.claude.requests[1].messages.slice(-3)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Sige po, iche-check ko." }, outage] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: outage.id, content: NOT_RUN, is_error: true }],
      },
      { role: "user", content: "Ha?" },
    ]);
    expectValidConversation(call.claude);
  });

  it("keeps a running tool's real result and answers the rest 'Not run' when the caller talks during tools", async () => {
    const verifying = verify(MARIA) as ToolUseBlock;
    const outage = checkOutage(MARIA.accountNumber) as ToolUseBlock;
    const call = interruptWhen(
      [
        { parts: [say("Sige po, ", "iche-check ko."), verifying, outage] },
        { parts: [say("Verified na po kayo.")] },
      ],
      (e) => e.type === "span" && e.span.name === "verify_identity",
    );
    call.session.start();

    const ended = await call.session.callerSaid(
      `${MARIA.accountNumber}, ${MARIA.mobileLast4}. May outage po ba?`,
    );

    expect(ended).toBe("interrupted");
    // The model turn had streamed in full before its tools ran.
    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "Sige po, iche-check ko." });

    await call.session.callerSaid("Ay, sige po, tuloy lang.");

    const [verified, notRun] = toolResultsIn({
      ...call.claude.requests[1],
      messages: call.claude.requests[1].messages.slice(0, -1),
    });
    expect(verified.tool_use_id).toBe(verifying.id);
    expect(verified.is_error).toBeUndefined();
    expect(JSON.parse(verified.content)).toMatchObject({ verified: true });
    expect(notRun).toEqual({
      type: "tool_result",
      tool_use_id: outage.id,
      content: NOT_RUN,
      is_error: true,
    });
    expectValidConversation(call.claude);
  });

  /**
   * A turn already handed to its tools is in the conversation as the model
   * wrote it, and its tools may have run. A shorter heard text is reported,
   * but the turn is not cut: cutting it would mean dropping a tool call that
   * already acted.
   */
  it("reports a shorter heard text during tools without cutting a turn whose tools have run", async () => {
    const call = interruptWhen(
      [
        { parts: [say("Sige po, ", "iche-check ko."), verify(MARIA)] },
        { parts: [say("Verified na po kayo.")] },
      ],
      (e) => e.type === "span" && e.span.name === "verify_identity",
      "Sige po,",
    );
    call.session.start();

    await call.session.callerSaid(`${MARIA.accountNumber}, ${MARIA.mobileLast4}`);

    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "Sige po," });

    await call.session.callerSaid("Ay, sige po.");

    const assistantTurn = call.claude.requests[1].messages.at(-3);
    expect(assistantTurn?.role).toBe("assistant");
    expect((assistantTurn?.content as ContentBlock[])[0]).toEqual({
      type: "text",
      text: "Sige po, iche-check ko.",
    });
    expectValidConversation(call.claude);
  });

  it("keeps a signed thinking block that came before the words the caller heard", async () => {
    const thought = { type: "thinking", thinking: "Check the outage.", signature: "sig_abc" };
    const call = interruptWhen(
      [
        { parts: [thought, say("Opo, ", "may outage po ", "sa Batasan Hills.")] },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(2),
    );
    call.session.start();

    await call.session.callerSaid("May outage po ba?");
    await call.session.callerSaid("Ha?");

    expect(call.claude.requests[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: [thought, { type: "text", text: "Opo, may outage po " }],
    });
    expectValidConversation(call.claude);
  });

  it("never leaves a signed thinking block after words the cut shortened", async () => {
    const thought = { type: "thinking", thinking: "Now the outage.", signature: "sig_def" };
    const call = interruptWhen(
      [
        {
          parts: [say("Opo, ", "sandali."), thought, say("Iche-check ko po.")],
          lag: Infinity,
        },
        { parts: [say("Ano po ulit?")] },
      ],
      nthDelta(2),
      "Opo,",
    );
    call.session.start();

    await call.session.callerSaid("May outage po ba?");
    await call.session.callerSaid("Ha?");

    expect(call.claude.requests[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Opo," }],
    });
    expectValidConversation(call.claude);
  });

  it("appends nothing of Tala's when the caller interrupts before she said a word", async () => {
    const call = interruptWhen(
      [{ parts: [say("Opo?")] }],
      (e) => e.type === "caller_said",
    );
    call.session.start();

    const ended = await call.session.callerSaid("Wala po kaming internet.");

    expect(ended).toBe("interrupted");
    expect(call.events.at(-1)).toEqual({ type: "interrupted", heard: "" });
    expect(call.claude.requests).toHaveLength(0);

    await call.session.callerSaid("Hello po?");

    expect(call.claude.requests[0].messages.slice(-2)).toEqual([
      { role: "user", content: "Wala po kaming internet." },
      { role: "user", content: "Hello po?" },
    ]);
    expectValidConversation(call.claude);
  });

  it("resolves interrupt() once the turn has settled, so the next caller turn is taken at once", async () => {
    const call = interruptWhen(
      [{ parts: [say("Opo, ", "sandali lang po.")] }, { parts: [say("Ano po ulit?")] }],
      nthDelta(1),
    );
    call.session.start();

    const first = call.session.callerSaid("Wala po kaming internet.");
    await vi.waitFor(() => expect(call.interrupting()).not.toBeNull());
    await call.interrupting();

    const second = call.session.callerSaid("Ha?");

    await expect(first).resolves.toBe("interrupted");
    await expect(second).resolves.toBe("awaiting_caller");
  });

  it("does nothing when no turn is running", async () => {
    const { session, events, claude } = newStreamedCall([{ parts: [say("Opo?")] }]);
    session.start();
    events.length = 0;

    await session.interrupt();
    await session.interrupt("anything at all");

    expect(events).toEqual([]);
    await expect(session.callerSaid("Hello po?")).resolves.toBe("awaiting_caller");
    expect(claude.requests).toHaveLength(1);
  });

  it("still refuses a caller turn while Tala is talking: interrupt() comes first", async () => {
    const { session } = newStreamedCall([{ parts: [say("Opo, ", "sandali lang po.")] }]);
    session.start();

    const first = session.callerSaid("Wala po kaming internet.");

    await expect(session.callerSaid("Hello?")).rejects.toThrow(/still running/);
    await first;
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

  /**
   * Deltas are delivered from inside the model call, where a throw would
   * fail a stream that was paid for. The session's one wrapper holds the
   * error until the turn is booked, as it does for every other event.
   */
  it("finishes and books a streamed turn whose speech_delta subscriber throws, then reports the error", async () => {
    let armed = false;
    const { session, events } = newStreamedCall(
      [{ parts: [say("Ano po ", "ang account number ninyo?")] }],
      {
        onEvent: (event) => {
          if (armed && event.type === "speech_delta") throw boom;
        },
      },
    );
    session.start();
    events.length = 0;
    armed = true;

    await expect(session.callerSaid("Hello po.")).rejects.toBe(boom);

    expect(events.filter((e) => e.type === "speech_delta")).toHaveLength(2);
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
