/**
 * `end_call`: the required final tool.
 *
 * Its input is the disposition (`../call/disposition`). The agent loop returns
 * that input as the run's outcome once this handler succeeds, and the call
 * session ends the call with it. The handler has nothing to decide.
 */
import { dispositionSchema } from "../call/disposition";

import { defineTalaTool } from "./context";

export const endCall = defineTalaTool({
  name: "end_call",
  description:
    "Ends the call. The call ends as soon as it runs, so call it exactly once, in the same " +
    "reply as your short closing words, when the caller's concern is handled or they say " +
    "goodbye. Never call it while the caller still has an open question. Its input is the " +
    "disposition for the supervisor: the outcome, the topic, and a one or two sentence " +
    "summary with no account or phone numbers. Returns ended true.",
  input: dispositionSchema,
  safetyClass: "auto_write",
  idempotent: true,
  terminal: true,
  handler: () => Promise.resolve({ ended: true }),
});
