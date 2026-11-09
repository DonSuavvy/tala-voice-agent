import { describe, expect, it } from "vitest";

import { maskDeep, maskNumbers } from "./masking";

/**
 * Masking (#10, Q21): an account or phone number is a run of 10 or more digits
 * once spaces, dots, hyphens and plus signs between digits are removed. It is
 * replaced by asterisks for all its digits but the last 4. Expected strings
 * here are literals, not recomputed with the rule.
 */
describe("maskNumbers", () => {
  it("masks a 10-digit account number down to its last four", () => {
    expect(maskNumbers("8012345601")).toBe("******5601");
  });

  it("masks a mobile in every common spacing and drops the separators", () => {
    expect(maskNumbers("+639175550101")).toBe("********0101");
    expect(maskNumbers("+63 917 555 0101")).toBe("********0101");
    expect(maskNumbers("0917 555 0101")).toBe("*******0101");
    expect(maskNumbers("0917-555-0101")).toBe("*******0101");
    expect(maskNumbers("0917.555.0101")).toBe("*******0101");
  });

  /** Tala reads digits in groups, and callers and models use every dash and bracket. */
  it("masks numbers in comma groups, brackets, dashes, slashes and line breaks", () => {
    expect(maskNumbers("801, 234, 5602")).toBe("******5602");
    expect(maskNumbers("(0917) 555 0101")).toBe("*******0101");
    expect(maskNumbers("0917\u2013555\u20130101")).toBe("*******0101");
    expect(maskNumbers("0917\u2014555\u20140101")).toBe("*******0101");
    expect(maskNumbers("0917/555/0101")).toBe("*******0101");
    expect(maskNumbers("0917\t555\t0101")).toBe("*******0101");
    expect(maskNumbers("0917\n555\n0101")).toBe("*******0101");
    expect(maskNumbers("(+63) 917 555 0101")).toBe("********0101");
    expect(maskNumbers("8 0 1 2 3 4 5 6 0 1")).toBe("******5601");
    expect(maskNumbers("8012 - 345 - 601")).toBe("******5601");
  });

  it("masks a number inside a sentence and leaves the words alone", () => {
    expect(maskNumbers("Account 8012345601, po, at 0917 555 0101.")).toBe(
      "Account ******5601, po, at *******0101.",
    );
  });

  it("masks longer digit runs too", () => {
    expect(maskNumbers("ref 2026110612345")).toBe("ref *********2345");
  });

  it("leaves short numbers readable", () => {
    expect(maskNumbers("last four 0101")).toBe("last four 0101");
    expect(maskNumbers("PHP 1,299.00 due 2026-11-06")).toBe("PHP 1,299.00 due 2026-11-06");
    expect(maskNumbers("OUT-2026-0412")).toBe("OUT-2026-0412");
    expect(maskNumbers("123456789")).toBe("123456789");
    expect(maskNumbers("\u20b11,299.00")).toBe("\u20b11,299.00");
    expect(maskNumbers("Nov 6, 2026, 10:30 PM")).toBe("Nov 6, 2026, 10:30 PM");
  });

  it("is a no-op on text it already masked", () => {
    expect(maskNumbers("******5601 and *******0101")).toBe("******5601 and *******0101");
  });
});

describe("maskDeep", () => {
  it("masks every string in nested objects and arrays, in a new value", () => {
    const input = {
      account_number: "8012345601",
      nested: { phones: ["0917 555 0101", "none"], note: "PHP 1,299.00" },
      count: 3,
      ok: true,
      gone: null,
    };

    expect(maskDeep(input)).toEqual({
      account_number: "******5601",
      nested: { phones: ["*******0101", "none"], note: "PHP 1,299.00" },
      count: 3,
      ok: true,
      gone: null,
    });
    // Never mutates.
    expect(input.account_number).toBe("8012345601");
    expect(input.nested.phones[0]).toBe("0917 555 0101");
  });

  it("masks a bare string and leaves other values alone", () => {
    expect(maskDeep("8012345601")).toBe("******5601");
    expect(maskDeep(42)).toBe(42);
    expect(maskDeep(undefined)).toBeUndefined();
  });

  it("masks object keys' values only, and keeps Dates as they are", () => {
    const at = new Date("2026-11-06T10:00:00.000Z");
    expect(maskDeep({ at })).toEqual({ at });
  });
});
