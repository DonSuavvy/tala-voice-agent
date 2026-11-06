import { describe, expect, it } from "vitest";

import {
  attemptsRemaining,
  checkAccountAccess,
  checkVerificationAttempt,
  initialIdentityState,
  mobileLast4Matches,
  normalizeAccountNumber,
  recordVerification,
} from "./identity";

const POLICY_3 = { identity: { maxFailedAttempts: 3 } };

/**
 * The account gate and identity verification, as pure decisions. A caller
 * proves who they are with an account number and the last 4 digits of the
 * registered mobile; until then no account tool may run, and afterwards only
 * for that one account. The tool handlers call these; the model never decides.
 *
 * Expected values are literals. Account numbers are compared after
 * normalization on both sides, so a caller that forgets to normalize cannot
 * slip past a comparison.
 */

describe("initialIdentityState", () => {
  it("starts unverified with no failures, as a fresh object each call", () => {
    const first = initialIdentityState();
    const second = initialIdentityState();

    expect(first).toEqual({ verifiedAccount: null, failedAttempts: 0 });
    expect(second).toEqual({ verifiedAccount: null, failedAttempts: 0 });
    expect(first).not.toBe(second);
  });
});

describe("normalizeAccountNumber", () => {
  it("removes spaces and dashes, and leaves every other character alone", () => {
    expect(normalizeAccountNumber("801-234 5678")).toBe("8012345678");
    // It does not validate: what is not a separator stays, so a lookup misses.
    expect(normalizeAccountNumber("KF/801_234")).toBe("KF/801_234");
  });

  it("removes dots", () => {
    expect(normalizeAccountNumber("801.234.5678")).toBe("8012345678");
  });
});

describe("mobileLast4Matches", () => {
  const MOBILE = "+639175550101";

  it("matches the last 4 digits of the registered mobile, and nothing else", () => {
    expect(mobileLast4Matches(MOBILE, "0101")).toBe(true);
    expect(mobileLast4Matches(MOBILE, "0102")).toBe(false);
  });

  // Each of these is a suffix of the mobile or empty, so a plain "ends with"
  // would let a caller verify by saying less than the secret.
  it("refuses anything that is not exactly 4 digits", () => {
    expect(mobileLast4Matches(MOBILE, "")).toBe(false);
    expect(mobileLast4Matches(MOBILE, "101")).toBe(false);
    expect(mobileLast4Matches(MOBILE, "50101")).toBe(false);
    expect(mobileLast4Matches("+6391755abcd", "abcd")).toBe(false);
  });

  it("ignores spaces in the digits the caller gave", () => {
    expect(mobileLast4Matches(MOBILE, "01 01")).toBe(true);
    expect(mobileLast4Matches(MOBILE, " 0 1 0 1 ")).toBe(true);
  });

  it("reads the last 4 digits of a registered mobile stored with separators", () => {
    expect(mobileLast4Matches("0917 555 01 01", "0101")).toBe(true);
    expect(mobileLast4Matches("0917-555-01-01", "0101")).toBe(true);
  });
});

describe("checkVerificationAttempt", () => {
  it("lets a fresh call attempt verification", () => {
    expect(checkVerificationAttempt(initialIdentityState(), "8012345678", POLICY_3)).toEqual({
      allowed: true,
      alreadyVerified: false,
    });
  });

  it("reports the account already verified in this call as already verified", () => {
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };
    expect(checkVerificationAttempt(verified, "8012345678", POLICY_3)).toEqual({
      allowed: true,
      alreadyVerified: true,
    });
  });

  it("normalizes the requested account before comparing", () => {
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };
    expect(checkVerificationAttempt(verified, "801-234 5678", POLICY_3)).toEqual({
      allowed: true,
      alreadyVerified: true,
    });
  });

  it("normalizes the verified account too, in case a caller stored it raw", () => {
    const storedRaw = { verifiedAccount: "801.234.5678", failedAttempts: 0 };
    expect(checkVerificationAttempt(storedRaw, "8012345678", POLICY_3)).toEqual({
      allowed: true,
      alreadyVerified: true,
    });
  });

  it("refuses a second account once one is verified: one account per call", () => {
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };
    expect(checkVerificationAttempt(verified, "8019999999", POLICY_3)).toEqual({
      allowed: false,
      reason: "other_account_verified",
    });
  });

  it("locks once failed attempts reach the policy's max", () => {
    const twoFailures = { verifiedAccount: null, failedAttempts: 2 };
    const threeFailures = { verifiedAccount: null, failedAttempts: 3 };

    expect(checkVerificationAttempt(twoFailures, "8012345678", POLICY_3)).toEqual({
      allowed: true,
      alreadyVerified: false,
    });
    expect(checkVerificationAttempt(threeFailures, "8012345678", POLICY_3)).toEqual({
      allowed: false,
      reason: "locked",
    });
    expect(
      checkVerificationAttempt(threeFailures, "8012345678", { identity: { maxFailedAttempts: 5 } }),
    ).toEqual({ allowed: true, alreadyVerified: false });
  });

  it("answers from the verified account before the lock", () => {
    const verifiedAtMax = { verifiedAccount: "8012345678", failedAttempts: 3 };

    expect(checkVerificationAttempt(verifiedAtMax, "8012345678", POLICY_3)).toEqual({
      allowed: true,
      alreadyVerified: true,
    });
    expect(checkVerificationAttempt(verifiedAtMax, "8019999999", POLICY_3)).toEqual({
      allowed: false,
      reason: "other_account_verified",
    });
  });

  // Parsed at the point of decision. A cast would read 50 as a limit and let a
  // caller guess the 4 digits fifty times (ADR 0001; OpsPilot FAILURES #9).
  it("throws on a malformed policy instead of failing open, on every path", () => {
    const fresh = initialIdentityState();
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };

    expect(() =>
      checkVerificationAttempt(fresh, "8012345678", { identity: { maxFailedAttempts: 50 } }),
    ).toThrow(/maxFailedAttempts/);
    expect(() => checkVerificationAttempt(verified, "8012345678", undefined)).toThrow();
  });
});

describe("recordVerification", () => {
  // The call session keeps the old state for its trace; a transition that
  // edited it in place would rewrite history.
  it("never mutates the state it is given, and returns a new one", () => {
    const before = Object.freeze({ verifiedAccount: null, failedAttempts: 1 });

    const afterMatch = recordVerification(before, "8012345678", true);
    const afterMiss = recordVerification(before, "8012345678", false);

    expect(before).toEqual({ verifiedAccount: null, failedAttempts: 1 });
    expect(afterMatch).not.toBe(before);
    expect(afterMiss).not.toBe(before);
  });

  it("on a match, records the normalized account and keeps the failure count", () => {
    const oneFailure = { verifiedAccount: null, failedAttempts: 1 };
    expect(recordVerification(oneFailure, "801-234 5678", true)).toEqual({
      verifiedAccount: "8012345678",
      failedAttempts: 1,
    });
  });

  it("on a miss, counts one more failure and verifies nothing", () => {
    const oneFailure = { verifiedAccount: null, failedAttempts: 1 };
    expect(recordVerification(oneFailure, "8012345678", false)).toEqual({
      verifiedAccount: null,
      failedAttempts: 2,
    });
  });
});

describe("attemptsRemaining", () => {
  it("is the policy's max less the failures so far", () => {
    expect(attemptsRemaining(initialIdentityState(), POLICY_3)).toBe(3);
    expect(attemptsRemaining({ verifiedAccount: null, failedAttempts: 1 }, POLICY_3)).toBe(2);
  });

  it("never goes below zero", () => {
    expect(attemptsRemaining({ verifiedAccount: null, failedAttempts: 3 }, POLICY_3)).toBe(0);
    expect(attemptsRemaining({ verifiedAccount: null, failedAttempts: 4 }, POLICY_3)).toBe(0);
  });

  // `"3" - 0` is 3 in JavaScript, so an unparsed policy would answer anyway.
  it("throws on a malformed policy", () => {
    expect(() =>
      attemptsRemaining(initialIdentityState(), { identity: { maxFailedAttempts: "3" } }),
    ).toThrow(/maxFailedAttempts/);
  });
});

describe("checkAccountAccess", () => {
  it("refuses every account before verification", () => {
    expect(checkAccountAccess(initialIdentityState(), "8012345678")).toEqual({
      allowed: false,
      reason: "not_verified",
    });
  });

  it("allows the account this call verified", () => {
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };
    expect(checkAccountAccess(verified, "8012345678")).toEqual({ allowed: true });
  });

  it("refuses any other account once one is verified", () => {
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };
    expect(checkAccountAccess(verified, "8019999999")).toEqual({
      allowed: false,
      reason: "other_account",
    });
  });

  it("normalizes the requested account before comparing", () => {
    const verified = { verifiedAccount: "8012345678", failedAttempts: 0 };
    expect(checkAccountAccess(verified, "801-234 5678")).toEqual({ allowed: true });
  });

  it("normalizes the verified account too, in case a caller stored it raw", () => {
    const storedRaw = { verifiedAccount: "801.234.5678", failedAttempts: 0 };
    expect(checkAccountAccess(storedRaw, "8012345678")).toEqual({ allowed: true });
  });
});
