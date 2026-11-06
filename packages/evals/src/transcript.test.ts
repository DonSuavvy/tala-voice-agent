import { describe, expect, it } from "vitest";

import type { CallEvent, SpanEvent } from "@tala/core";

import { transcriptOf } from "./transcript";

/**
 * The transcript is what was said on the call, in order: Tala's lines (the
 * whole utterance each `speech` event carries) and the caller's turns. The
 * advisory grader reads it, and the report keeps it.
 */

const AT = new Date("2026-11-06T05:00:00Z");

const span = { type: "llm_call", name: "m" } as SpanEvent;

describe("transcriptOf", () => {
  it("keeps who said what, in order, and nothing else", () => {
    const events: CallEvent[] = [
      { type: "speech", text: "Hello po! I'm Tala, an AI assistant." },
      { type: "awaiting_caller" },
      { type: "caller_said", text: "Wala po kaming internet.", at: AT },
      { type: "speech", text: "Sandali lang po, let me check." },
      { type: "span", span },
      { type: "speech", text: "May fiber cut po." },
    ];

    expect(transcriptOf(events)).toEqual([
      { speaker: "tala", text: "Hello po! I'm Tala, an AI assistant." },
      { speaker: "caller", text: "Wala po kaming internet." },
      { speaker: "tala", text: "Sandali lang po, let me check." },
      { speaker: "tala", text: "May fiber cut po." },
    ]);
  });

  /** Streaming (#6) adds partial-speech events; the whole utterance is still `speech`. */
  it("passes over event types it does not know", () => {
    const events = [
      { type: "speech_delta", text: "Sand" },
      { type: "speech", text: "Sandali lang po." },
      { type: "interrupted", heard: "Sandali" },
    ] as unknown as CallEvent[];

    expect(transcriptOf(events)).toEqual([{ speaker: "tala", text: "Sandali lang po." }]);
  });
});
