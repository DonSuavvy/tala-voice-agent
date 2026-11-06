import { describe, expect, it } from "vitest";

import { AGENT_LOOP_STATUSES as LOOP_STATUSES } from "@tala/core";

import { expectationsSchema } from "./case";

/**
 * An eval case names the status it expects the loop to end with, so the case
 * schema must accept every status the loop can return.
 *
 * This used to be held by a mirror list in `case.ts`, guarded by a
 * `satisfies` that its comment said would fail `tsc` if the loop gained a
 * status. It would not: `satisfies readonly AgentLoopStatus[]` checks that
 * each listed status exists, never that each existing status is listed. Tala
 * FAILURES entry 6.
 */
describe("expectationsSchema — status", () => {
  it("accepts awaiting_caller, the status a call's turns end with", () => {
    const parsed = expectationsSchema.safeParse({ status: "awaiting_caller" });

    expect(parsed.success).toBe(true);
  });

  it("accepts every status the loop can return", () => {
    const rejected = LOOP_STATUSES.filter(
      (status) => !expectationsSchema.safeParse({ status }).success,
    );

    expect(rejected).toEqual([]);
  });

  it("still rejects a status the loop cannot return", () => {
    const parsed = expectationsSchema.safeParse({ status: "finished" });

    expect(parsed.success).toBe(false);
  });
});
