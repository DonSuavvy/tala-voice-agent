import { describe, expect, it } from "vitest";

import { dispositionSchema } from "../call/disposition";
import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import { CALL_STARTED_AT, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { endCall } from "./end-call";

/**
 * `end_call` is the required final tool. Its input is the disposition, and
 * the agent loop hands that input to the call session once the handler runs.
 * The handler itself only acknowledges.
 */

function newContext(): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems: createInMemorySystems(testWorld(), CALL_STARTED_AT, "Asia/Manila"),
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
      wait: () => Promise.resolve(),
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

const DISPOSITION = {
  outcome: "resolved",
  topic: "outage",
  summary: "Caller asked about an outage; told them about the fiber cut and its restoration time.",
} as const;

describe("end_call", () => {
  it("is the terminal tool, and takes the disposition schema itself as its input", () => {
    expect(endCall.terminal).toBe(true);
    expect(endCall.input).toBe(dispositionSchema);
  });

  it("refuses a disposition outside the schema", () => {
    expect(endCall.input.safeParse({ ...DISPOSITION, outcome: "escalated" }).success).toBe(false);
  });

  it("acknowledges a valid disposition", async () => {
    const result = await endCall.handler(endCall.input.parse(DISPOSITION), newContext());

    expect(result).toEqual({ ended: true });
  });
});
