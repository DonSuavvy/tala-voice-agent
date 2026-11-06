import { describe, expect, it } from "vitest";

import { dispositionSchema } from "./disposition";

function withSummary(summary: string) {
  return dispositionSchema.safeParse({ outcome: "resolved", topic: "outage", summary });
}

describe("dispositionSchema summary", () => {
  it.each([
    "Maria, account 8012345601, mobile +639175550101, told about the outage.",
    "Caller gave account 8012345601 and was told about the outage.",
    "Caller gave account 801-234-5601 and was told about the outage.",
    "Caller can be reached on +63 917 555 0101 about the outage.",
    "Caller can be reached on 09175550101 about the outage.",
    "Caller can be reached on 0917.555.0101 about the outage.",
  ])("rejects a summary carrying an account or phone number: %s", (summary) => {
    const result = withSummary(summary);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      "summary must not contain an account or phone number",
    ]);
  });

  it.each([
    "Told about outage OUT-2026-0412 in Batasan Hills, back by 5:00 PM.",
    "Caller on the Kidlat 300 plan asked about the outage.",
    "Caller was told service is back by 5:00 PM today.",
  ])("accepts a summary with only short numbers: %s", (summary) => {
    expect(withSummary(summary).success).toBe(true);
  });
});

describe("dispositionSchema topic", () => {
  /** #16: a general how-to question answered from the help articles. */
  it("takes help, for a call answered from the help articles", () => {
    const result = dispositionSchema.safeParse({
      outcome: "resolved",
      topic: "help",
      summary: "Caller asked what a red light on the modem means; read them the help article.",
    });

    expect(result.success).toBe(true);
  });
});
