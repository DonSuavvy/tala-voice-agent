import { describe, expect, expectTypeOf, it } from "vitest";

import { DISPOSITION_OUTCOMES, DISPOSITION_TOPICS, type CallEndReason } from "@tala/core";

import { expectationsSchema, type Expectations } from "./case";

/**
 * A case's expectations, in Tala's vocabulary: how the call ended, the tools,
 * the guardrails, the disposition, what Tala said, and the voice checks.
 *
 * The schema is closed. Zod strips unknown keys by default, so without
 * `.strict()` a typo such as `toolsCaled` would become a case that asserts
 * nothing and reports green forever.
 */

function issuesOf(input: unknown) {
  const parsed = expectationsSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues;
}

/** Where each problem is, so a test cannot pass on an unrelated unknown-key issue. */
const rejectedAt = (input: unknown) => issuesOf(input).map((i) => i.path.join("."));

describe("expectationsSchema: closed", () => {
  it("rejects a misspelled key, and the issue names it", () => {
    const issues = issuesOf({ toolsCaled: ["verify_identity"] });

    expect(issues).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["toolsCaled"], path: [] }),
    ]);
  });

  it("lists every problem at once", () => {
    const issues = issuesOf({ toolsCaled: [], endedBy: "completed", maxModelCalls: 0 });

    expect(issues.map((i) => i.path.join(".") || i.code)).toEqual([
      "endedBy",
      "maxModelCalls",
      "unrecognized_keys",
    ]);
  });

  /**
   * Beacon's keys read a loop's result: its status, its iterations and the
   * terminal tool's `action` and `reply` fields. A call has none of those, so
   * a case still written with them must fail to parse, not pass silently.
   */
  it.each(["status", "action", "replyMentions", "maxIterations"])(
    "rejects the removed Beacon key %s",
    (key) => {
      const issues = issuesOf({ [key]: key === "maxIterations" ? 3 : "completed" });

      expect(issues).toEqual([
        expect.objectContaining({ code: "unrecognized_keys", keys: [key] }),
      ]);
    },
  );

  it("closes the disposition object too", () => {
    const issues = issuesOf({ disposition: { outcome: "resolved", topc: "outage" } });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["topc"],
        path: ["disposition"],
      }),
    ]);
  });
});

describe("expectationsSchema: endedBy", () => {
  it.each(["end_call", "refused", "failed", "budget_refused", "not_ended"])(
    "accepts %s",
    (endedBy) => {
      expect(issuesOf({ endedBy })).toEqual([]);
    },
  );

  /** A loop status, not a way a call ends. */
  it("rejects completed", () => {
    expect(rejectedAt({ endedBy: "completed" })).toEqual(["endedBy"]);
  });

  /**
   * Type-level, in both directions: `npm run typecheck` fails if core's
   * `CallEndReason` gains or loses a value and the schema does not follow.
   * `satisfies T[]` would only prove membership (Tala FAILURES entry 6).
   */
  it("is exactly the call session's end reasons plus not_ended", () => {
    expectTypeOf<NonNullable<Expectations["endedBy"]>>().toEqualTypeOf<
      CallEndReason | "not_ended"
    >();
  });
});

describe("expectationsSchema: disposition", () => {
  it("accepts every outcome and topic end_call can record", () => {
    const rejected = [
      ...DISPOSITION_OUTCOMES.map((outcome) => ({ outcome })),
      ...DISPOSITION_TOPICS.map((topic) => ({ topic })),
    ].filter((disposition) => issuesOf({ disposition }).length > 0);

    expect(rejected).toEqual([]);
  });

  it("rejects an outcome end_call cannot record", () => {
    expect(rejectedAt({ disposition: { outcome: "fixed" } })).toEqual(["disposition.outcome"]);
  });

  it("rejects a topic end_call cannot record", () => {
    expect(rejectedAt({ disposition: { topic: "internet" } })).toEqual(["disposition.topic"]);
  });
});

describe("expectationsSchema: values that would assert nothing", () => {
  /** `false` reads like a check and checks nothing; leave the key out instead. */
  it.each(["noAccountDataBeforeVerification", "speaksBeforeEveryToolCall"])(
    "accepts %s only as true",
    (key) => {
      expect(issuesOf({ [key]: true })).toEqual([]);
      expect(rejectedAt({ [key]: false })).toEqual([key]);
    },
  );

  /** Every text contains the empty string, and no tool is named "". */
  it.each(["saidMentions", "toolsNever", "toolsCalled", "guardrailOn"])(
    "rejects an empty name in %s",
    (key) => {
      expect(rejectedAt({ [key]: [""] })).toEqual([`${key}.0`]);
    },
  );

  it("rejects a model-call cap that is not a positive whole number", () => {
    expect(rejectedAt({ maxModelCalls: 0 })).toEqual(["maxModelCalls"]);
    expect(rejectedAt({ maxModelCalls: 2.5 })).toEqual(["maxModelCalls"]);
    expect(issuesOf({ maxModelCalls: 6 })).toEqual([]);
  });
});
