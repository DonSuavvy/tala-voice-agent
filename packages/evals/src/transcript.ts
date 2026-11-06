/**
 * What was said on a call, in order: Tala's lines and the caller's turns.
 *
 * Read from `speech` (the whole utterance) and `caller_said` events only.
 * Every other event type, including ones added later such as streaming's
 * partial speech (#6), is passed over.
 */
import type { CallEvent } from "@tala/core";

export interface TranscriptLine {
  speaker: "tala" | "caller";
  text: string;
}

export function transcriptOf(events: readonly CallEvent[]): TranscriptLine[] {
  return events.flatMap((event): TranscriptLine[] => {
    if (event.type === "speech") return [{ speaker: "tala", text: event.text }];
    if (event.type === "caller_said") return [{ speaker: "caller", text: event.text }];
    return [];
  });
}
