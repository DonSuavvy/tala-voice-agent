import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import { CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { verifyIdentity } from "./verify-identity";

/**
 * `verify_identity`, driven through its public definition: the input schema
 * the agent loop parses with, then the handler, against a real in-memory world
 * and the real identity policy. Nothing is mocked.
 *
 * The handler is where the limits live in code: the model may call it as
 * often as it likes, and the policy decides what each call is worth.
 */

function newContext(): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems: createInMemorySystems(testWorld(), CALL_STARTED_AT),
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH" },
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function verify(ctx: TalaToolContext, input: { account_number: string; mobile_last4: string }) {
  return verifyIdentity.handler(verifyIdentity.input.parse(input), ctx);
}

describe("verify_identity — the description the model reads", () => {
  // A repeat for the verified account is answered from the call's state, so
  // the model must not read it as a second check of the digits.
  it("says a repeat for the verified account spends no attempt and does not recheck the digits", () => {
    expect(verifyIdentity.description).toContain(
      "Calling it again for the account already verified spends no attempt, does not " +
        "recheck the digits, and returns already_verified true.",
    );
  });
});

describe("verify_identity — the input schema", () => {
  it("rejects a last 4 that is not four digits, so a mis-heard digit never spends an attempt", () => {
    // The loop answers a schema failure with is_error and never runs the
    // handler, so nothing here can reach the attempt counter.
    for (const misheard of ["101", "10101", "01a1", ""]) {
      const parsed = verifyIdentity.input.safeParse({
        account_number: MARIA.accountNumber,
        mobile_last4: misheard,
      });
      expect(parsed.success, misheard).toBe(false);
    }
  });

  it("accepts four digits said with spaces, and they verify like any other four", async () => {
    const said = { account_number: "801 234 5601", mobile_last4: "01 01" };
    expect(verifyIdentity.input.safeParse(said).success).toBe(true);

    const ctx = newContext();
    expect(await verify(ctx, said)).toMatchObject({ verified: true });
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345601", failedAttempts: 0 });
  });

  // The schema's `\s` lets a tab through; the policy must read it the same way,
  // or Maria's right digits would spend one of her attempts.
  it("verifies four digits with a tab between them, spending no attempt", async () => {
    const ctx = newContext();

    const result = await verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: "01\t01" });

    expect(result).toMatchObject({ verified: true, already_verified: false });
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345601", failedAttempts: 0 });
  });
});

describe("verify_identity — a match", () => {
  it("verifies the caller, records the account on the call and says only what the caller may hear", async () => {
    const ctx = newContext();

    const result = await verify(ctx, {
      account_number: MARIA.accountNumber,
      mobile_last4: MARIA.mobileLast4,
    });

    expect(result).toEqual({
      verified: true,
      already_verified: false,
      holder_first_name: "Maria",
      service_area: "Batasan Hills, Quezon City",
      account_status: "active",
    });
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345601", failedAttempts: 0 });
  });

  it("answers a repeat for the verified account from the call's state, spending no attempt", async () => {
    const ctx = newContext();
    await verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: MARIA.mobileLast4 });

    const again = await verify(ctx, { account_number: "801-234 5601", mobile_last4: MARIA.mobileLast4 });
    // The gate answers before any digits are compared, so a mis-heard repeat
    // cannot spend an attempt or undo a verification already made.
    const misheard = await verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: "9999" });

    const alreadyVerified = {
      verified: true,
      already_verified: true,
      holder_first_name: "Maria",
      service_area: "Batasan Hills, Quezon City",
      account_status: "active",
    };
    expect(again).toEqual(alreadyVerified);
    expect(misheard).toEqual(alreadyVerified);
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345601", failedAttempts: 0 });
  });
});

describe("verify_identity — one account per call", () => {
  it("refuses to verify a second account once one is verified, even with that account's right numbers", async () => {
    const ctx = newContext();
    await verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: MARIA.mobileLast4 });

    await expect(
      verify(ctx, { account_number: JOSE.accountNumber, mobile_last4: JOSE.mobileLast4 }),
    ).rejects.toThrow(/different account/);
    await expect(
      verify(ctx, { account_number: JOSE.accountNumber, mobile_last4: JOSE.mobileLast4 }),
    ).rejects.toThrow(
      "This call is already verified for a different account. " +
        "Only that account can be served on this call.",
    );
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345601", failedAttempts: 0 });
  });
});

describe("verify_identity — a miss", () => {
  it("refuses a wrong last 4, spends one attempt and says how many are left", async () => {
    const ctx = newContext();

    const result = await verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: "9999" });

    expect(result).toEqual({ verified: false, attempts_remaining: 2, locked: false });
    expect(ctx.data.identity).toEqual({ verifiedAccount: null, failedAttempts: 1 });
  });

  it("answers an unknown account exactly as it answers a wrong last 4, so no account can be probed", async () => {
    const unknownCtx = newContext();
    const wrongLast4Ctx = newContext();

    const unknown = await verify(unknownCtx, { account_number: "8000000000", mobile_last4: "0101" });
    const wrongLast4 = await verify(wrongLast4Ctx, {
      account_number: MARIA.accountNumber,
      mobile_last4: "9999",
    });

    expect(unknown).toEqual(wrongLast4);
    expect(unknownCtx.data.identity).toEqual(wrongLast4Ctx.data.identity);
  });

  it("locks after 3 failed attempts, and refuses a 4th even with the right numbers", async () => {
    const ctx = newContext();
    const wrong = { account_number: MARIA.accountNumber, mobile_last4: "9999" };

    expect(await verify(ctx, wrong)).toEqual({ verified: false, attempts_remaining: 2, locked: false });
    expect(await verify(ctx, wrong)).toEqual({ verified: false, attempts_remaining: 1, locked: false });
    expect(await verify(ctx, wrong)).toEqual({ verified: false, attempts_remaining: 0, locked: true });

    // Even the right numbers are refused now: the lock is for the call.
    await expect(
      verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: MARIA.mobileLast4 }),
    ).rejects.toThrow(
      "Verification is locked for this call after 3 failed attempts. Do not try again; " +
        "tell the caller you cannot access the account on this call.",
    );
    expect(ctx.data.identity).toEqual({ verifiedAccount: null, failedAttempts: 3 });
  });
});

/**
 * The call session dispatches tools one at a time today, but the handler must
 * hold the limits without relying on that: every call below passes the first
 * gate before any account lookup resolves.
 */
describe("verify_identity — concurrent calls", () => {
  it("with one attempt left, five concurrent wrong guesses spend exactly that one", async () => {
    const ctx = newContext();
    ctx.data.identity = { verifiedAccount: null, failedAttempts: 2 };
    const wrong = { account_number: MARIA.accountNumber, mobile_last4: "9999" };

    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => verify(ctx, wrong)));

    expect(ctx.data.identity).toEqual({ verifiedAccount: null, failedAttempts: 3 });
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toEqual([
      { status: "fulfilled", value: { verified: false, attempts_remaining: 0, locked: true } },
    ]);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(String(r.reason)).toMatch(/locked/);
  });

  it("a wrong guess that resolves after the right one is answered as already verified, spending nothing", async () => {
    const ctx = newContext();

    const [right, wrong] = await Promise.all([
      verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: MARIA.mobileLast4 }),
      verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: "9999" }),
    ]);

    expect(right).toMatchObject({ verified: true, already_verified: false });
    expect(wrong).toMatchObject({ verified: true, already_verified: true });
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345601", failedAttempts: 0 });
  });

  it("a second account that resolves after the first is verified is refused: one account per call", async () => {
    const ctx = newContext();

    const [jose, maria] = await Promise.allSettled([
      verify(ctx, { account_number: JOSE.accountNumber, mobile_last4: JOSE.mobileLast4 }),
      verify(ctx, { account_number: MARIA.accountNumber, mobile_last4: MARIA.mobileLast4 }),
    ]);

    expect(jose).toMatchObject({ status: "fulfilled", value: { verified: true } });
    expect(maria.status).toBe("rejected");
    expect(String((maria as PromiseRejectedResult).reason)).toMatch(/different account/);
    expect(ctx.data.identity).toEqual({ verifiedAccount: "8012345602", failedAttempts: 0 });
  });
});
