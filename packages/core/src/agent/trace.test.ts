import { describe, expect, it } from "vitest";

import type { SpanEvent } from "./loop";
import {
  encodeSseEvent,
  MAX_SPAN_COST_USD,
  spanToRow,
  stripNuls,
} from "./trace";

/**
 * The boundary between a run in flight and the two things that consume it: the
 * OpsPilot's `run_spans` table and the SSE trace stream.
 *
 * Both consumers are unforgiving in ways that are invisible until production.
 * `cost_usd` is `numeric(12,6)` behind a CHECK, `input`/`output` are `jsonb`
 * (which rejects a NUL escape outright), and SSE frames are newline-delimited,
 * so a single raw newline inside a payload silently splits one event into two
 * malformed ones. All three failures happen at the edge, on real ticket text,
 * long after the loop has been declared working — so they get pinned here.
 */

function span(over: Partial<SpanEvent> = {}): SpanEvent {
  return {
    seq: 0,
    type: "llm_call",
    name: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    input: { messages: 2 },
    output: { stop_reason: "tool_use" },
    isError: false,
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900,
    },
    costNanos: 60_000,
    estimated: false,
    latencyMs: 812,
    startedAt: new Date("2026-08-13T10:00:00.000Z"),
    endedAt: new Date("2026-08-13T10:00:00.812Z"),
    ...over,
  };
}

const IDS = { workspaceId: "ws_demo", runId: "run_1" };

/* -------------------------------------------------------------------------- */
/* Cost, at the storage boundary                                              */
/* -------------------------------------------------------------------------- */

describe("spanToRow — cost", () => {
  /**
   * Nanos are the accounting unit; micro-dollars are the storage unit, because
   * `cost_usd` is `numeric(12,6)`. The conversion happens exactly once, here.
   */
  it("converts nano-dollars to a six-decimal micro-dollar string", () => {
    const row = spanToRow(IDS, span({ costNanos: 60_000 }));
    expect(row.costUsd).toBe("0.000060");
  });

  it("writes an exact zero for a span that genuinely cost nothing", () => {
    const row = spanToRow(IDS, span({ type: "tool_exec", costNanos: 0 }));
    expect(row.costUsd).toBe("0.000000");
  });

  /**
   * A real but sub-micro cost rounds *up* to the smallest representable
   * amount. Recording it as zero would make a cheap span indistinguishable
   * from a free one, and "cost per resolved ticket" is the headline KPI.
   */
  it("floors a real sub-micro cost at one micro-dollar rather than zero", () => {
    const row = spanToRow(IDS, span({ costNanos: 4 }));
    expect(row.costUsd).toBe("0.000001");
  });

  /**
   * The column's CHECK is `>= 0 AND <= 10000`. Postgres would reject an
   * out-of-range write, but as an opaque constraint violation three layers
   * below the arithmetic that caused it. Failing here names the span.
   */
  it("refuses a cost above the column's ceiling instead of letting Postgres do it", () => {
    const overCeiling = (MAX_SPAN_COST_USD + 1) * 1_000_000_000;
    expect(() => spanToRow(IDS, span({ costNanos: overCeiling }))).toThrow(
      /cost/i,
    );
  });

  /**
   * `nanosToMicros` already rejects a negative, so this guard is redundant for
   * *validity* — mutation testing proved it, by deleting the check and finding
   * every assertion still green. What it is not redundant for is diagnosis:
   * the cost module can only say "nanos must be non-negative", while this
   * layer knows which span of which run produced it. So the assertion is on
   * the span being named, which is the only thing the guard actually buys.
   */
  it("names the offending span when it refuses a negative cost", () => {
    expect(() => spanToRow(IDS, span({ seq: 4, costNanos: -1 }))).toThrow(
      /span 4/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Column mapping                                                             */
/* -------------------------------------------------------------------------- */

describe("spanToRow — columns", () => {
  it("maps the four token classes onto their own columns", () => {
    const row = spanToRow(IDS, span());
    expect(row).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 340,
      cacheWriteTokens: 0,
      cacheReadTokens: 900,
    });
  });

  /**
   * Tool and guardrail spans carry no usage at all. Zero is the honest value
   * for "this span consumed no tokens" — null would make `SUM` over the column
   * behave differently from every other row.
   */
  it("writes zeros rather than nulls for a span with no token usage", () => {
    const row = spanToRow(IDS, span({ type: "tool_exec", usage: null }));
    expect(row).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("carries the identifiers, sequence, type and timings through", () => {
    const row = spanToRow(IDS, span({ seq: 7, isError: true }));
    expect(row).toMatchObject({
      workspaceId: "ws_demo",
      runId: "run_1",
      seq: 7,
      type: "llm_call",
      isError: true,
      latencyMs: 812,
    });
    expect(row.startedAt.toISOString()).toBe("2026-08-13T10:00:00.000Z");
  });

  /**
   * OpsPilot's `run_spans.input`/`output` are `jsonb`, and Postgres rejects NUL
   * outright — the error is `unsupported Unicode escape sequence`, raised on
   * insert. A ticket body pasted out of a binary file is enough to produce
   * one, so it is stripped here. (OpsPilot's `agent_runs.serialized_messages` is the
   * opposite case and stays `text`: replaying a paused turn needs the payload
   * byte-identical, so it must not be edited.)
   */
  it("strips NUL from jsonb payloads, which Postgres cannot store", () => {
    const row = spanToRow(
      IDS,
      span({ input: { body: "hello\u0000world" }, output: ["a\u0000b"] }),
    );
    expect(JSON.stringify(row.input)).not.toContain("\\u0000");
    expect(JSON.stringify(row.output)).not.toContain("\\u0000");
    expect((row.input as { body: string }).body).toBe("helloworld");
  });

  it("leaves ordinary payloads untouched", () => {
    const value = { nested: { list: [1, "two", null], flag: true } };
    expect(stripNuls(value)).toEqual(value);
  });

  /**
   * Guarding the near-miss rather than the bug. A literal NUL in source is
   * invisible on screen and identical to a space, so a stripper written with
   * one is a stripper that could just as easily be deleting spaces — and every
   * assertion above would still pass, because the fixtures would be mangled
   * the same way. This is the assertion the two cannot both satisfy.
   */
  it("does not strip spaces, which a raw-NUL source literal makes easy to do", () => {
    expect(stripNuls("hello world")).toBe("hello world");
    expect(stripNuls({ body: "a b c" })).toEqual({ body: "a b c" });
  });
});

/* -------------------------------------------------------------------------- */
/* SSE framing                                                                */
/* -------------------------------------------------------------------------- */

describe("encodeSseEvent", () => {
  it("emits a named event terminated by a blank line", () => {
    const frame = encodeSseEvent("span", { seq: 0 });
    expect(frame).toBe('event: span\ndata: {"seq":0}\n\n');
  });

  /**
   * The failure this exists to prevent. SSE is newline-delimited: a raw `\n`
   * inside `data:` ends the field, so a payload containing one is delivered as
   * two malformed events and the trace viewer silently drops the run. Ticket
   * bodies are multi-line by nature, and they reach spans as tool input.
   *
   * `JSON.stringify` escapes newlines as `\n` — two characters — which is what
   * makes a single-line frame possible at all. Asserted rather than assumed,
   * because the whole guarantee rests on it.
   */
  it("keeps a multi-line payload on one data line", () => {
    const frame = encodeSseEvent("span", {
      body: "Hello,\nI'd like a refund.\n\nThanks",
    });

    const lines = frame.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^data: /);
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("round-trips the payload a client would parse back out", () => {
    const payload = { seq: 3, name: "get_customer", note: "multi\nline" };
    const frame = encodeSseEvent("span", payload);
    const data = frame.split("\n")[1].slice("data: ".length);
    expect(JSON.parse(data)).toEqual(payload);
  });

  /**
   * The client needs an unambiguous end marker: a stream that just stops is
   * indistinguishable from a dropped connection, and the demo's whole point is
   * that the trace is legible.
   */
  it("names the event so a client can distinguish a span from the run's end", () => {
    expect(encodeSseEvent("done", { status: "completed" })).toMatch(
      /^event: done\n/,
    );
  });
});
