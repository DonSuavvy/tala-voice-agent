import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import { CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { getBillingHistory } from "./get-billing-history";
import { verifyIdentity } from "./verify-identity";

/**
 * `get_billing_history`, driven through its public definition against a real
 * in-memory world and the real account gate. Nothing is mocked.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. The shared world gives
 * Jose his October bill and yesterday's unposted GCash payment; the world
 * below adds his August and September bills, each paid by GCash and posted,
 * and a July bill, so there are seven entries and the oldest must drop off.
 */

function joseWithMonthsOfHistory(): SeedWorld {
  const world = testWorld();
  const jose = JOSE.accountNumber;
  world.bills.push(
    { reference: "SOA-2607-5602", accountNumber: jose, amountMinor: 129_900, issuedMinutesBeforeCall: 168_480 },
    { reference: "SOA-2608-5602", accountNumber: jose, amountMinor: 129_900, issuedMinutesBeforeCall: 123_840 },
    { reference: "SOA-2609-5602", accountNumber: jose, amountMinor: 129_900, issuedMinutesBeforeCall: 79_200 },
  );
  world.payments.push(
    {
      reference: "5647382910564",
      accountNumber: jose,
      channel: "gcash",
      amountMinor: 129_900,
      paidMinutesBeforeCall: 105_120,
      posted: true,
    },
    {
      reference: "1029384756102",
      accountNumber: jose,
      channel: "gcash",
      amountMinor: 129_900,
      paidMinutesBeforeCall: 60_480,
      posted: true,
    },
  );
  return world;
}

function newContext(world: SeedWorld = testWorld()): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems: createInMemorySystems(world, CALL_STARTED_AT),
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function history(ctx: TalaToolContext, accountNumber: string) {
  return getBillingHistory.handler(
    getBillingHistory.input.parse({ account_number: accountNumber }),
    ctx,
  );
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("get_billing_history — the account gate", () => {
  it("refuses before the caller is verified", async () => {
    await expect(history(newContext(), JOSE.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  it("refuses any account but the one verified on this call", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    await expect(history(ctx, MARIA.accountNumber)).rejects.toThrow(/different account/);
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const ctx = newContext();
    const wrong = { accountNumber: JOSE.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(history(ctx, JOSE.accountNumber)).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
  });
});

describe("get_billing_history — the verified account", () => {
  it("lists bills and payments together, newest first, at most six, as they are spoken", async () => {
    const ctx = newContext(joseWithMonthsOfHistory());
    await verifyAs(ctx, JOSE);

    expect(await history(ctx, JOSE.accountNumber)).toEqual({
      entries: [
        { kind: "payment", date: "Thu, Nov 5", amount: "₱1,299.00", channel: "gcash", posted: false },
        { kind: "bill", date: "Mon, Oct 12", amount: "₱1,299.00" },
        { kind: "payment", date: "Fri, Sep 25", amount: "₱1,299.00", channel: "gcash", posted: true },
        { kind: "bill", date: "Sat, Sep 12", amount: "₱1,299.00" },
        { kind: "payment", date: "Tue, Aug 25", amount: "₱1,299.00", channel: "gcash", posted: true },
        { kind: "bill", date: "Wed, Aug 12", amount: "₱1,299.00" },
      ],
    });
  });

  it("lists only the verified account's own entries", async () => {
    const ctx = newContext(joseWithMonthsOfHistory());
    await verifyAs(ctx, MARIA);

    expect(await history(ctx, MARIA.accountNumber)).toEqual({
      entries: [
        { kind: "payment", date: "Fri, Oct 23", amount: "₱1,699.00", channel: "maya", posted: true },
        { kind: "bill", date: "Mon, Oct 12", amount: "₱1,699.00" },
      ],
    });
  });

  it("gives an empty list for an account with no bills or payments", async () => {
    const world = testWorld();
    world.bills = [];
    world.payments = [];
    const ctx = newContext(world);
    await verifyAs(ctx, JOSE);

    expect(await history(ctx, JOSE.accountNumber)).toEqual({ entries: [] });
  });
});

describe("get_billing_history — its input", () => {
  it("takes the account number and nothing else", () => {
    expect(getBillingHistory.input.safeParse({ account_number: "" }).success).toBe(false);
    expect(
      getBillingHistory.input.safeParse({ account_number: JOSE.accountNumber, limit: 20 }).success,
    ).toBe(false);
  });

  it("is a read", () => {
    expect(getBillingHistory.safetyClass).toBe("read");
    expect(getBillingHistory.idempotent).toBe(true);
  });
});
