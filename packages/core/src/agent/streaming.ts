/**
 * The production `MessageCreator`.
 *
 * This is the only place the loop's narrow wire types meet the SDK's, and the
 * only place the agent actually talks to a model. It exists so that everything
 * upstream — ordering, refusal handling, the spend pre-flight, tool dispatch —
 * is testable against scripted turns instead of a network.
 *
 * **Streamed, then assembled by the SDK.** `.stream()` avoids the HTTP timeouts
 * a long non-streaming turn invites, and `finalMessage()` hands back the
 * complete message with `usage` already reconciled. That second half is the
 * point: on the streaming path the four token counts arrive across several
 * event types, and reassembling them by hand is precisely how a run comes to
 * book zero cache cost without anyone noticing. Let the SDK do it.
 *
 * **Text as it streams.** Each text delta goes to `onTextDelta` the moment it
 * arrives, so a voice can start speaking before Claude has finished writing.
 * Thinking deltas are not speech and are never passed on. The SDK calls the
 * listener from inside its own event handling, so a listener that throws
 * fails the stream: a caller forwarding deltas to someone else's code must
 * catch there.
 *
 * **Interrupted is not failed.** When `signal` aborts, the SDK stops the
 * stream and `finalMessage()` rejects with `APIUserAbortError`. The creator
 * resolves instead, with what had arrived, taken from the SDK's own snapshot
 * and marked `stop_reason: "interrupted"`. Removed from it is whatever could
 * not go back to the API: a thinking block whose signature had not arrived, a
 * tool call whose input had not finished, and text with nothing to hear. A
 * signed thinking block is kept untouched. The usage is the snapshot's, which
 * is message_start's figures if message_delta never came, so it undercounts
 * output: for an interrupted turn it is a floor, not a bill.
 *
 * **No `thinking`, no `effort` yet.** On the 5.5 models, omitting `thinking`
 * runs adaptive thinking, which is the only setting Opus 5.5 accepts. Effort
 * per logical model is #20. Whatever thinking blocks come back round-trip
 * untouched, because the loop copies assistant content wholesale.
 */
import Anthropic from "@anthropic-ai/sdk";

import { isSpokenText, type AssistantTurn, type MessageCreator } from "./loop";

type StreamParams = Parameters<Anthropic["messages"]["stream"]>[0];

/** An abort before message_start: nothing was reported, so nothing is carried. */
const NO_USAGE: AssistantTurn["usage"] = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * What can go back to the API of a turn the abort cut off.
 *
 * `finished` holds the index of every block whose content_block_stop
 * arrived. A tool call's input is whole only then; before it, the SDK's
 * `input` is a best-effort parse of half the JSON.
 */
function interruptedTurn(
  snapshot: Anthropic.Message | undefined,
  finished: ReadonlySet<number>,
): AssistantTurn {
  const content = (snapshot?.content ?? []).filter((block, index) => {
    switch (block.type) {
      case "text":
        // Kept as far as it got: that is what the caller heard.
        return isSpokenText(block);
      case "thinking":
        // The signature arrives last. Without it the block cannot go back.
        return typeof block.signature === "string" && block.signature.length > 0;
      case "tool_use":
        return finished.has(index);
      default:
        return true;
    }
  });

  const turn = {
    content,
    stop_reason: "interrupted",
    stop_details: null,
    usage: snapshot ? { ...snapshot.usage } : { ...NO_USAGE },
  };
  return turn as unknown as AssistantTurn;
}

/**
 * The casts are contained here on purpose.
 *
 * The loop's `ContentBlock` is deliberately open-ended so thinking blocks and
 * whatever the API adds next round-trip untouched; the SDK's is a closed
 * discriminated union. They describe the same JSON, and this is the boundary
 * that says so once rather than at every call site.
 */
export function streamingMessageCreator(client: Anthropic): MessageCreator {
  return async (params, options = {}) => {
    const { signal, onTextDelta } = options;

    const stream = client.messages.stream(
      {
        model: params.model,
        max_tokens: params.max_tokens,
        // Blocks when the prefix is marked cacheable, a bare string otherwise.
        // Passed through untouched: caching is a byte-level prefix match.
        system: params.system,
        messages: params.messages as StreamParams["messages"],
        tools: params.tools as StreamParams["tools"],
      },
      signal ? { signal } : undefined,
    );

    const finished = new Set<number>();
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_stop") finished.add(event.index);
    });
    if (onTextDelta) stream.on("text", (delta) => onTextDelta(delta));

    try {
      const message = await stream.finalMessage();
      return message as unknown as AssistantTurn;
    } catch (error) {
      // Only the caller's own abort is an interruption. Anything else is a
      // failure, and the loop books it as one.
      if (signal?.aborted !== true || !(error instanceof Anthropic.APIUserAbortError)) {
        throw error;
      }
      return interruptedTurn(stream.currentMessage, finished);
    }
  };
}
