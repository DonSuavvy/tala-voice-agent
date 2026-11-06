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
 * **One request path, the beta namespace.** Every model goes through
 * `client.beta.messages`, because server-side refusal fallback is a beta.
 * Only the models `provider.ts` opts in send `fallbacks: "default"` and its
 * beta header; a Haiku request carries neither and is otherwise the same
 * request as before.
 *
 * **A turn a fallback took over goes back as the API asks.** A fallback
 * mid-output keeps the declined attempt's partial before a `fallback` block.
 * Of that partial, only its text stays, with every `fallback` block in
 * place; its thinking and tool calls are left out before anyone sees them.
 * The turn's `model` and `usage.iterations` pass through untouched: the loop
 * prices and records the turn from them.
 *
 * **No `thinking`, no `effort` yet.** On the 5.5 models, omitting `thinking`
 * runs adaptive thinking, which is the only setting Opus 5.5 accepts. Effort
 * per logical model is #20. Whatever thinking blocks come back round-trip
 * untouched, because the loop copies assistant content wholesale.
 */
import Anthropic from "@anthropic-ai/sdk";

import { isSpokenText, type AssistantTurn, type MessageCreator } from "./loop";
import { refusalFallbackFor } from "./provider";

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type StreamMessage = Anthropic.Beta.BetaMessage;

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
  snapshot: StreamMessage | undefined,
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
    // Who was writing, so the turn is priced at that model's card. After a
    // fallback block the SDK names the fallback model here.
    ...(snapshot ? { model: snapshot.model } : {}),
  };
  return turn as unknown as AssistantTurn;
}

/**
 * A turn as it can go back to the API after a server-side refusal fallback
 * took over mid-output.
 *
 * The claude-api skill, refusal section, "Echoing fallback turns back":
 * thinking, redacted_thinking and tool_use blocks, and any other
 * model-internal block, that came before the turn's final `fallback` block
 * are left out; text and everything from the boundary on go back as they
 * came. The SDK's `BetaFallbackBlockParam` adds that every `fallback` block
 * stays in its original position, and that no tool_result is sent for a
 * tool_use left out. Text before the boundary stays: the caller heard it,
 * and the fallback model continued from it. (The rule also keeps paired
 * server-tool blocks; Tala sends no server tools, so there are none.)
 *
 * Not an edit of the conversation: the turn has never been sent back.
 * Leaving the declined attempt out here, where it arrives, means nothing
 * downstream ever runs a tool call it never stood behind.
 */
function asItCanGoBack(turn: AssistantTurn): AssistantTurn {
  const boundary = turn.content.findLastIndex((block) => block.type === "fallback");
  if (boundary <= 0) return turn;
  const content = turn.content.filter(
    (block, index) => index >= boundary || block.type === "fallback" || isSpokenText(block),
  );
  return { ...turn, content };
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

    const stream = client.beta.messages.stream(
      {
        model: params.model,
        max_tokens: params.max_tokens,
        // Blocks when the prefix is marked cacheable, a bare string otherwise.
        // Passed through untouched: caching is a byte-level prefix match.
        system: params.system,
        messages: params.messages as StreamParams["messages"],
        tools: params.tools as StreamParams["tools"],
        // `fallbacks` and its beta header, on the models that take them.
        ...refusalFallbackFor(params.model),
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
      return asItCanGoBack(message as unknown as AssistantTurn);
    } catch (error) {
      // Only the caller's own abort is an interruption. Anything else is a
      // failure, and the loop books it as one.
      if (signal?.aborted !== true || !(error instanceof Anthropic.APIUserAbortError)) {
        throw error;
      }
      return asItCanGoBack(interruptedTurn(stream.currentMessage, finished));
    }
  };
}
