import { describe, expect, it } from "vitest";

import { JOSE, JOSE_GCASH_REFERENCE, MARIA, testSystems, testToolContext } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { verifyIdentity } from "./verify-identity";
import { verifyPayment } from "./verify-payment";

/**
 * `verify_payment`, driven through its public definition against a real
 * in-memory world and the real account gate. Nothing is mocked.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. Jose's 1,299-peso GCash
 * payment was made the day before and has not posted; Maria's 1,699-peso Maya
 * payment from two weeks ago has.
 */

function newContext(): TalaToolContext {
  return testToolContext(testSystems());
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function verify(ctx: TalaToolContext, reference: string) {
  return verifyPayment.handler(verifyPayment.input.parse({ reference }), ctx);
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("verify_payment — the account gate", () => {
  it("refuses before the caller is verified", async () => {
    await expect(verify(newContext(), JOSE_GCASH_REFERENCE)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const ctx = newContext();
    const wrong = { accountNumber: JOSE.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(verify(ctx, JOSE_GCASH_REFERENCE)).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
  });
});

describe("verify_payment — the verified caller's payments", () => {
  it("finds Jose's GCash payment, with its amount and time as they are spoken, not yet posted", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    expect(await verify(ctx, JOSE_GCASH_REFERENCE)).toEqual({
      found: true,
      channel: "gcash",
      amount: "₱1,299.00",
      paid_at: "Thu, Nov 5, 1:00 PM",
      posted: false,
    });
  });

  it("reports a payment that has posted", async () => {
    const ctx = newContext();
    await verifyAs(ctx, MARIA);

    expect(await verify(ctx, "MAYA7K2Q9")).toEqual({
      found: true,
      channel: "maya",
      amount: "₱1,699.00",
      paid_at: "Fri, Oct 23, 1:00 PM",
      posted: true,
    });
  });

  // Speech-to-text writes a long reference with spaces, hyphens or en dashes,
  // and a spelled-out one in lower case.
  it.each(["1234 5678 90123", "1234-567-890-123", "1234\u2013567890123", " 1234567890123\t"])(
    "finds the payment when the reference is said as %j",
    async (said) => {
      const ctx = newContext();
      await verifyAs(ctx, JOSE);

      expect(await verify(ctx, said)).toMatchObject({ found: true, channel: "gcash" });
    },
  );

  it("finds a reference with letters said in lower case", async () => {
    const ctx = newContext();
    await verifyAs(ctx, MARIA);

    expect(await verify(ctx, "maya 7k2q9")).toMatchObject({ found: true, channel: "maya" });
  });

  it("answers not found for a reference no payment has", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    expect(await verify(ctx, "9999999999999")).toEqual({ found: false });
  });

  it("answers not found, and nothing more, for a payment made to another account", async () => {
    const asJose = newContext();
    await verifyAs(asJose, JOSE);
    const asMaria = newContext();
    await verifyAs(asMaria, MARIA);

    expect(await verify(asJose, "MAYA7K2Q9")).toEqual({ found: false });
    expect(await verify(asMaria, JOSE_GCASH_REFERENCE)).toEqual({ found: false });
  });
});

describe("verify_payment — its input", () => {
  it("takes a reference and nothing else: no account number to point it elsewhere", () => {
    expect(verifyPayment.input.safeParse({ reference: "" }).success).toBe(false);
    expect(
      verifyPayment.input.safeParse({
        reference: JOSE_GCASH_REFERENCE,
        account_number: MARIA.accountNumber,
      }).success,
    ).toBe(false);
  });

  it("is a read", () => {
    expect(verifyPayment.safetyClass).toBe("read");
  });
});
