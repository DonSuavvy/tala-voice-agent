import { describe, expect, it } from "vitest";

import { spokenDigits } from "./spoken-digits";

describe("spokenDigits", () => {
  it("reads a grouped reference digit by digit, keeping its groups as pauses", () => {
    // Heard on 2026-11-09: Flash read "5012 345 678901" as "5T12 345 678 901".
    expect(spokenDigits("ang reference po ay 5012 345 678901. Tama po ba?")).toBe(
      "ang reference po ay 5-0-1-2, 3-4-5, 6-7-8-9-0-1. Tama po ba?",
    );
  });

  it("reads an account number digit by digit", () => {
    expect(spokenDigits("account 8012345601")).toBe("account 8-0-1-2-3-4-5-6-0-1");
  });

  it("reads the mobile's last four digit by digit", () => {
    expect(spokenDigits("ending in 0101 po")).toBe("ending in 0-1-0-1 po");
  });

  it("reads the digits of an outage reference, so 2026 is not twenty twenty-six", () => {
    expect(spokenDigits("reference OUT-2026-0412")).toBe("reference OUT-2-0-2-6, 0-4-1-2");
  });

  it("joins groups split by single hyphens the same way as spaces", () => {
    expect(spokenDigits("0917-123-4567")).toBe("0-9-1-7, 1-2-3, 4-5-6-7");
  });

  it("leaves short numbers and times alone", () => {
    const text = "around 10 PM tonight, Mon, Nov 9, 10:08 PM, in 2 to 3 days";
    expect(spokenDigits(text)).toBe(text);
  });

  it("leaves a run of short numbers alone when they total under four digits", () => {
    expect(spokenDigits("Nov 9 10 PM")).toBe("Nov 9 10 PM");
  });

  it("leaves peso amounts alone, with a sign, a code or the word pesos", () => {
    const text = "₱1699 a month, PHP 1699, P1699, 1699 pesos, ₱1,299.00";
    expect(spokenDigits(text)).toBe(text);
  });

  it("does not touch digits inside a word", () => {
    expect(spokenDigits("the ONU2000 modem")).toBe("the ONU2000 modem");
  });

  it("returns text with no digits unchanged", () => {
    expect(spokenDigits("Sandali lang po, let me check.")).toBe("Sandali lang po, let me check.");
  });
});
