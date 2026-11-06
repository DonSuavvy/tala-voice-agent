/**
 * The adapter between a call and the scorer (#9): a call session's event
 * stream and the seed world it started from in, the scorer's observation out.
 *
 * The scorer stays pure because this is the only place that knows what a call
 * session emits. It keeps what scoring reads, in order: Tala's lines (each
 * `speech` event is one whole line), the caller's turns and the spans. It
 * drops timestamps and the pin, which no check may depend on.
 *
 * **Unknown event types are passed over, not rejected.** The stream grows:
 * streaming (#6) adds `speech_delta` and `interrupted`, and later tickets add
 * more. A new event is a reason to teach the scorer something, never a reason
 * for a run that was about to produce good results to fail. That is why this
 * picks the types it knows instead of switching exhaustively over all of them.
 */
import type { CallEvent, SeedWorld } from "@tala/core";

import type { Observed, ObservedEvent } from "./score";

/**
 * A call with no `call_ended` is `not_ended`: the simulated caller ran out of
 * turns before Tala called `end_call`, so the call has no disposition either.
 * `world` and `plans` are the seed world and the plan catalog the call's
 * company pack started it with.
 */
export function observeCall(
  events: readonly CallEvent[],
  world: Pick<SeedWorld, "accounts">,
  plans: Observed["plans"],
): Observed {
  const observed: ObservedEvent[] = [];
  let ended: Extract<CallEvent, { type: "call_ended" }> | null = null;

  for (const event of events) {
    if (event.type === "speech") observed.push({ type: "speech", text: event.text });
    else if (event.type === "caller_said") observed.push({ type: "caller_said", text: event.text });
    else if (event.type === "span") observed.push({ type: "span", span: event.span });
    else if (event.type === "call_ended") ended ??= event;
  }

  return {
    endedBy: ended?.reason ?? "not_ended",
    disposition: ended?.disposition ?? null,
    events: observed,
    world,
    plans,
  };
}
