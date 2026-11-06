import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { AssistantTurn, MessageCreateParams } from "./loop";
import { anthropicProvider } from "./provider";
import { streamingMessageCreator } from "./streaming";

/**
 * The production `MessageCreator`, driven through the real SDK.
 *
 * The client here is a real `Anthropic` client; only its `fetch` is fake. So
 * what these tests exercise is the SDK's own `MessageStream`: how it
 * accumulates events into a snapshot, how it fires text deltas, how an
 * aborted signal surfaces. A hand-written stand-in for the stream would test
 * our idea of the SDK, and drift from it silently on the next upgrade.
 *
 * The fake transport answers with server-sent events scripted from the SDK's
 * own event types, and honours the abort signal the way a real `fetch` does:
 * the response body errors with an `AbortError`. Nothing leaves the process
 * and no real key is involved.
 */

/* -------------------------------------------------------------------------- */
/* A scripted transport                                                       */
/* -------------------------------------------------------------------------- */

type StreamEvent = Anthropic.RawMessageStreamEvent;
/** The beta stream's events: what a server-side fallback adds is typed only here. */
type BetaStreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

/**
 * A point in the script where the transport has delivered everything before
 * it and waits. A test can look at what arrived, then resume or abort.
 */
const PAUSE = Symbol("pause");
type Step = StreamEvent | BetaStreamEvent | typeof PAUSE;

function scriptedTransport(script: Step[]) {
  const requests: unknown[] = [];
  const headers: Headers[] = [];
  let markPaused: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  let resume: () => void = () => {};
  const encoder = new TextEncoder();

  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // The SDK sends the request body as a JSON string.
    const sent = init?.body;
    requests.push(typeof sent === "string" ? JSON.parse(sent) : sent);
    headers.push(new Headers(init?.headers));
    const steps = [...script];
    const signal = init?.signal;

    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          // What a real fetch does when its request is aborted mid-body.
          const abort = () =>
            controller.error(new DOMException("This operation was aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        },
        // One event per read, so a pause means every earlier event has been
        // read and handled by the SDK. After a pause the same pull carries
        // on: a stream does not pull again for a read that was already
        // waiting when this pull began.
        async pull(controller) {
          for (;;) {
            const step = steps.shift();
            if (step === undefined) {
              controller.close();
              return;
            }
            if (step === PAUSE) {
              markPaused();
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
              continue;
            }
            controller.enqueue(
              encoder.encode(`event: ${step.type}\ndata: ${JSON.stringify(step)}\n\n`),
            );
            return;
          }
        },
      },
      { highWaterMark: 0 },
    );

    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  return { fetch, requests, headers, paused, resume: () => resume() };
}

function clientOver(transport: { fetch: ReturnType<typeof scriptedTransport>["fetch"] }) {
  return new Anthropic({
    apiKey: "test-key-not-real",
    baseURL: "http://anthropic.fake.test",
    fetch: transport.fetch,
    maxRetries: 0,
  });
}

/**
 * The turn must settle promptly once the signal aborts. Without this a
 * creator that ignores the signal would hang until the test timeout, and the
 * failure would not say why.
 */
async function settlesSoon<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the turn did not settle within 1s of the abort: the stream kept running")),
      1000,
    );
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Events, shaped as the API sends them                                       */
/* -------------------------------------------------------------------------- */

/** What message_start reports: input and cache counts are final, output is not. */
const START_USAGE: Anthropic.Usage = {
  input_tokens: 2400,
  output_tokens: 3,
  cache_creation_input_tokens: 512,
  cache_read_input_tokens: 6100,
  cache_creation: null,
  inference_geo: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: "standard",
  speed: null,
};

const messageStart = (): StreamEvent => ({
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [],
    container: null,
    diagnostics: null,
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: { ...START_USAGE },
  },
});

const startText = (index: number): StreamEvent => ({
  type: "content_block_start",
  index,
  content_block: { type: "text", text: "", citations: null },
});

const textDelta = (index: number, text: string): StreamEvent => ({
  type: "content_block_delta",
  index,
  delta: { type: "text_delta", text },
});

const startThinking = (index: number): StreamEvent => ({
  type: "content_block_start",
  index,
  content_block: { type: "thinking", thinking: "", signature: "" },
});

const thinkingDelta = (index: number, thinking: string): StreamEvent => ({
  type: "content_block_delta",
  index,
  delta: { type: "thinking_delta", thinking },
});

const signatureDelta = (index: number, signature: string): StreamEvent => ({
  type: "content_block_delta",
  index,
  delta: { type: "signature_delta", signature },
});

const startToolUse = (index: number, id: string, name: string): StreamEvent => ({
  type: "content_block_start",
  index,
  content_block: { type: "tool_use", id, name, input: {}, caller: { type: "direct" } },
});

const inputJson = (index: number, partial_json: string): StreamEvent => ({
  type: "content_block_delta",
  index,
  delta: { type: "input_json_delta", partial_json },
});

const stopBlock = (index: number): StreamEvent => ({ type: "content_block_stop", index });

/** The final counts. Output is only known here; the rest repeat message_start. */
const messageDelta = (
  stop_reason: "end_turn" | "tool_use",
  output_tokens: number,
): StreamEvent => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null, stop_details: null, container: null },
  usage: {
    input_tokens: 2400,
    output_tokens,
    cache_creation_input_tokens: 512,
    cache_read_input_tokens: 6100,
    output_tokens_details: null,
    server_tool_use: null,
  },
});

const messageStop = (): StreamEvent => ({ type: "message_stop" });

const PARAMS: MessageCreateParams = {
  model: "claude-haiku-5-5",
  max_tokens: 1024,
  system: "You are Tala.",
  messages: [{ role: "user", content: "Wala po kaming internet." }],
  tools: [],
};

/** An interrupted turn that carries no content and no usage. */
const NOTHING_HEARD: AssistantTurn = {
  content: [],
  stop_reason: "interrupted",
  stop_details: null,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

describe("streamingMessageCreator — text deltas", () => {
  it("hands each text delta to onTextDelta as it streams, before the turn resolves", async () => {
    const transport = scriptedTransport([
      messageStart(),
      startThinking(0),
      thinkingDelta(0, "The caller has no internet."),
      signatureDelta(0, "sig_abc"),
      stopBlock(0),
      startText(1),
      textDelta(1, "Opo, "),
      textDelta(1, "iche-check ko po."),
      PAUSE,
      stopBlock(1),
      messageDelta("end_turn", 87),
      messageStop(),
    ]);
    const create = streamingMessageCreator(clientOver(transport));
    const deltas: string[] = [];
    let settled = false;

    const pending = create(PARAMS, {
      signal: new AbortController().signal,
      onTextDelta: (text) => deltas.push(text),
    });
    void pending.then(() => {
      settled = true;
    });
    await transport.paused;

    // Thinking is never spoken; only text deltas arrive, in order.
    expect(deltas).toEqual(["Opo, ", "iche-check ko po."]);
    expect(settled).toBe(false);

    transport.resume();
    const turn = await pending;

    expect(deltas).toEqual(["Opo, ", "iche-check ko po."]);
    expect(turn.stop_reason).toBe("end_turn");
  });
});

describe("streamingMessageCreator — a turn that completes", () => {
  it("returns the SDK's final message, with the usage message_delta reported", async () => {
    const transport = scriptedTransport([
      messageStart(),
      startText(0),
      textDelta(0, "Opo, may outage po sa Batasan Hills."),
      stopBlock(0),
      messageDelta("end_turn", 87),
      messageStop(),
    ]);

    // No second argument: every existing caller keeps working unchanged.
    const turn = await streamingMessageCreator(clientOver(transport))(PARAMS);

    expect(turn).toMatchObject({
      content: [{ type: "text", text: "Opo, may outage po sa Batasan Hills." }],
      stop_reason: "end_turn",
    });
    // Output is the figure message_delta sent, not message_start's
    // provisional 3. The cache counts are carried, not zeroed.
    expect(turn.usage).toMatchObject({
      input_tokens: 2400,
      output_tokens: 87,
      cache_creation_input_tokens: 512,
      cache_read_input_tokens: 6100,
    });
    expect(transport.requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      stream: true,
    });
  });

  /**
   * Review round 2: the test above cannot tell final counts from early ones,
   * because its message_delta repeats message_start's figures. Here every
   * count message_delta reports differs from message_start's, and the turn's
   * usage must be exactly what the SDK's own finalMessage() assembles.
   */
  it("returns the usage finalMessage() assembles, exactly, when message_delta revises every count", async () => {
    const script: Step[] = [
      messageStart(),
      startText(0),
      textDelta(0, "Opo, may outage po."),
      stopBlock(0),
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null },
        usage: {
          input_tokens: 2450,
          output_tokens: 87,
          cache_creation_input_tokens: 640,
          cache_read_input_tokens: 6000,
          output_tokens_details: { thinking_tokens: 31 },
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 1 },
        },
      },
      messageStop(),
    ];

    const turn = await streamingMessageCreator(clientOver(scriptedTransport(script)))(PARAMS);
    const final = await clientOver(scriptedTransport(script))
      .messages.stream({
        model: PARAMS.model,
        max_tokens: PARAMS.max_tokens,
        messages: [{ role: "user", content: "Wala po kaming internet." }],
      })
      .finalMessage();

    expect(turn.usage).toEqual(final.usage);
    // Worked out by hand: message_delta's figures where it sends them,
    // message_start's for the rest.
    expect(turn.usage).toEqual({
      input_tokens: 2450,
      output_tokens: 87,
      cache_creation_input_tokens: 640,
      cache_read_input_tokens: 6000,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: { thinking_tokens: 31 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 1 },
      service_tier: "standard",
      speed: null,
    });
  });

  it("still throws a failure that is not an interruption", async () => {
    const fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    const create = streamingMessageCreator(clientOver({ fetch }));

    await expect(
      create(PARAMS, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

/* -------------------------------------------------------------------------- */
/* Server-side refusal fallback: the request                                  */
/* -------------------------------------------------------------------------- */

describe("streamingMessageCreator — asking for server-side refusal fallback", () => {
  const completes = (): Step[] => [
    messageStart(),
    startText(0),
    textDelta(0, "Opo."),
    stopBlock(0),
    messageDelta("end_turn", 5),
    messageStop(),
  ];

  it.each(["sonnet", "opus"] as const)(
    "sends fallbacks: \"default\" in the body and the beta in the header on %s",
    async (model) => {
      const transport = scriptedTransport(completes());

      await streamingMessageCreator(clientOver(transport))({
        ...PARAMS,
        model: anthropicProvider.modelId(model),
      });

      expect(transport.requests[0]).toMatchObject({ fallbacks: "default" });
      // The beta travels as a header, never in the body.
      expect(transport.requests[0]).not.toHaveProperty("betas");
      expect(transport.headers[0].get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    },
  );

  it("sends neither on haiku", async () => {
    const transport = scriptedTransport(completes());

    await streamingMessageCreator(clientOver(transport))({
      ...PARAMS,
      model: anthropicProvider.modelId("haiku"),
    });

    expect(transport.requests[0]).not.toHaveProperty("fallbacks");
    expect(transport.requests[0]).not.toHaveProperty("betas");
    expect(transport.headers[0].get("anthropic-beta")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Server-side refusal fallback: the response                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a fallback adds to a response, shaped as the beta stream sends it
 * (claude-api skill, refusal section; the SDK's beta types). A fallback
 * before any output is seamless: message_start already names the fallback
 * model, and a `fallback` block, an ordinary content block with no deltas,
 * comes first. A fallback mid-stream keeps the partial, marks the boundary
 * with the block and continues. `usage.iterations`, in message_delta, has
 * one entry per attempt, and the one that served is `fallback_message`.
 */
const REQUESTED = anthropicProvider.modelId("opus");
const FALLBACK_MODEL = "claude-opus-5";

const betaMessageStart = (model: string): BetaStreamEvent => ({
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [],
    container: null,
    context_management: null,
    diagnostics: null,
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: { ...START_USAGE, fallback_credit: null, iterations: null },
  },
});

const startFallback = (index: number, from: string, to: string): BetaStreamEvent => ({
  type: "content_block_start",
  index,
  content_block: {
    type: "fallback",
    from: { model: from },
    to: { model: to },
    trigger: { type: "refusal", category: "cyber" },
  },
});

type Iterations = NonNullable<Anthropic.Beta.BetaUsage["iterations"]>;

/** An attempt as `usage.iterations` reports it. */
const attempt = (
  type: "message" | "fallback_message",
  model: string,
  input_tokens: number,
  output_tokens: number,
): Iterations[number] =>
  ({
    type,
    model,
    input_tokens,
    output_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
  });

const betaMessageDelta = (
  stop_reason: "end_turn" | "tool_use" | "refusal",
  output_tokens: number,
  iterations: Iterations,
): BetaStreamEvent => ({
  type: "message_delta",
  context_management: null,
  delta: { stop_reason, stop_sequence: null, stop_details: null, container: null },
  usage: {
    input_tokens: 2400,
    output_tokens,
    cache_creation_input_tokens: 512,
    cache_read_input_tokens: 6100,
    output_tokens_details: null,
    server_tool_use: null,
    fallback_credit: null,
    iterations,
  },
});

describe("streamingMessageCreator — a turn a server-side fallback served", () => {
  it("returns the model that served the turn and the usage of every attempt", async () => {
    const iterations = [
      attempt("message", REQUESTED, 2400, 0),
      attempt("fallback_message", FALLBACK_MODEL, 2400, 87),
    ];
    const transport = scriptedTransport([
      betaMessageStart(FALLBACK_MODEL),
      startFallback(0, REQUESTED, FALLBACK_MODEL),
      stopBlock(0),
      startText(1),
      textDelta(1, "Opo, may outage po."),
      stopBlock(1),
      betaMessageDelta("end_turn", 87, iterations),
      messageStop(),
    ]);

    const turn = await streamingMessageCreator(clientOver(transport))({ ...PARAMS, model: REQUESTED });

    expect(turn.model).toBe(FALLBACK_MODEL);
    expect(turn.usage.iterations).toEqual(iterations);
    expect(turn.content).toEqual([
      {
        type: "fallback",
        from: { model: REQUESTED },
        to: { model: FALLBACK_MODEL },
        trigger: { type: "refusal", category: "cyber" },
      },
      { type: "text", text: "Opo, may outage po.", citations: null },
    ]);
  });

  it("says which model was writing when the caller interrupted a turn a fallback served", async () => {
    const transport = scriptedTransport([
      betaMessageStart(REQUESTED),
      startText(0),
      textDelta(0, "Sige po, "),
      stopBlock(0),
      startFallback(1, REQUESTED, FALLBACK_MODEL),
      stopBlock(1),
      startText(2),
      textDelta(2, "iche-check ko po"),
      PAUSE,
    ]);
    const controller = new AbortController();
    const pending = streamingMessageCreator(clientOver(transport))(
      { ...PARAMS, model: REQUESTED },
      { signal: controller.signal },
    );
    await transport.paused;
    controller.abort();

    const turn = await settlesSoon(pending);

    expect(turn.stop_reason).toBe("interrupted");
    expect(turn.model).toBe(FALLBACK_MODEL);
  });
});

/* -------------------------------------------------------------------------- */
/* Interruption                                                               */
/* -------------------------------------------------------------------------- */

describe("streamingMessageCreator — an interruption", () => {
  /** Runs the script to its pause, aborts there, and returns the turn. */
  async function interruptAtPause(script: Step[]) {
    const transport = scriptedTransport(script);
    const create = streamingMessageCreator(clientOver(transport));
    const controller = new AbortController();

    const pending = create(PARAMS, { signal: controller.signal });
    await transport.paused;
    controller.abort();

    return settlesSoon(pending);
  }

  it("stops the stream and resolves with what had arrived, marked interrupted", async () => {
    const turn = await interruptAtPause([
      messageStart(),
      startText(0),
      textDelta(0, "Opo, "),
      textDelta(0, "sandali lang po"),
      PAUSE,
      textDelta(0, " habang chine-check ko."),
      stopBlock(0),
      messageDelta("end_turn", 87),
      messageStop(),
    ]);

    expect(turn).toEqual({
      content: [{ type: "text", text: "Opo, sandali lang po", citations: null }],
      stop_reason: "interrupted",
      stop_details: null,
      // message_delta never came, so this is what message_start reported.
      usage: START_USAGE,
      // The model that was writing, so the turn is priced at its card.
      model: "claude-haiku-5-5",
    });
  });

  it("drops a thinking block the abort cut off before its signature", async () => {
    const turn = await interruptAtPause([
      messageStart(),
      startThinking(0),
      thinkingDelta(0, "The caller has"),
      PAUSE,
    ]);

    expect(turn.content).toEqual([]);
  });

  it("keeps a signed thinking block exactly as it streamed", async () => {
    const turn = await interruptAtPause([
      messageStart(),
      startThinking(0),
      thinkingDelta(0, "Check the outage first."),
      signatureDelta(0, "sig_abc"),
      stopBlock(0),
      startText(1),
      textDelta(1, "Opo"),
      PAUSE,
    ]);

    const signed = { type: "thinking", thinking: "Check the outage first.", signature: "sig_abc" };
    expect(turn.content).toEqual([signed, { type: "text", text: "Opo", citations: null }]);
    // Byte for byte, key order included: the API checks it on the next request.
    expect(JSON.stringify(turn.content[0])).toBe(JSON.stringify(signed));
  });

  it("drops a tool call whose input was still streaming, and keeps a finished one", async () => {
    const turn = await interruptAtPause([
      messageStart(),
      startText(0),
      textDelta(0, "Sige po, iche-check ko."),
      stopBlock(0),
      startToolUse(1, "toolu_verify", "verify_identity"),
      inputJson(1, '{"account_number": "8012345601", '),
      inputJson(1, '"mobile_last4": "0101"}'),
      stopBlock(1),
      startToolUse(2, "toolu_outage", "check_area_outage"),
      inputJson(2, '{"account_num'),
      PAUSE,
    ]);

    // Through JSON, as the next request will send it: the kept input is
    // plain data, not a getter over a half-parsed buffer.
    expect(JSON.parse(JSON.stringify(turn.content))).toEqual([
      { type: "text", text: "Sige po, iche-check ko.", citations: null },
      {
        type: "tool_use",
        id: "toolu_verify",
        name: "verify_identity",
        input: { account_number: "8012345601", mobile_last4: "0101" },
        caller: { type: "direct" },
      },
    ]);
  });

  it.each([
    ["empty", []],
    ["whitespace only", [textDelta(1, "\n\n")]],
  ])("drops a text block the abort left %s", async (_label, deltas: StreamEvent[]) => {
    const turn = await interruptAtPause([
      messageStart(),
      startText(0),
      textDelta(0, "Opo."),
      stopBlock(0),
      startText(1),
      ...deltas,
      PAUSE,
    ]);

    expect(turn.content).toEqual([{ type: "text", text: "Opo.", citations: null }]);
  });

  it("resolves with nothing heard when the abort comes before the first event", async () => {
    const turn = await interruptAtPause([PAUSE]);

    expect(turn).toEqual(NOTHING_HEARD);
  });

  it("makes no request at all when the signal had already aborted", async () => {
    const transport = scriptedTransport([]);
    const create = streamingMessageCreator(clientOver(transport));
    const controller = new AbortController();
    controller.abort();

    const turn = await settlesSoon(create(PARAMS, { signal: controller.signal }));

    expect(turn).toEqual(NOTHING_HEARD);
    expect(transport.requests).toHaveLength(0);
  });
});
