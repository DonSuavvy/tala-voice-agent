import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import { CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { getAccountOverview } from "./get-account-overview";
import { verifyIdentity } from "./verify-identity";

/**
 * `get_account_overview`, driven through its public definition against a real
 * in-memory world and the real account gate. Nothing is mocked.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. Jose owes his October bill,
 * due Tue, Oct 27, with a disconnection scheduled for Sat, Nov 7. Maria owes
 * nothing.
 */

function newContext(world: SeedWorld = testWorld()): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems: createInMemorySystems(world, CALL_STARTED_AT, "Asia/Manila"),
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function overview(ctx: TalaToolContext, accountNumber: string) {
  return getAccountOverview.handler(
    getAccountOverview.input.parse({ account_number: accountNumber }),
    ctx,
  );
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("get_account_overview — the account gate", () => {
  it("refuses before the caller is verified", async () => {
    await expect(overview(newContext(), JOSE.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  // Scenario 5: "my neighbor's balance" reaches the code and is refused there.
  it("refuses any account but the one verified on this call", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    await expect(overview(ctx, MARIA.accountNumber)).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const ctx = newContext();
    const wrong = { accountNumber: JOSE.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(overview(ctx, JOSE.accountNumber)).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
  });
});

describe("get_account_overview — the verified account", () => {
  it("gives Jose's plan, status, balance, due date and scheduled disconnection, as they are spoken", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    expect(await overview(ctx, "801-234-5602")).toEqual({
      plan: "Kidlat 100",
      account_status: "active",
      balance_due: "₱1,299.00",
      due_date: "Tue, Oct 27",
      past_due: true,
      disconnection_date: "Sat, Nov 7",
    });
  });

  it("gives nulls and no past due for an account that owes nothing", async () => {
    const ctx = newContext();
    await verifyAs(ctx, MARIA);

    expect(await overview(ctx, MARIA.accountNumber)).toEqual({
      plan: "Kidlat 300",
      account_status: "active",
      balance_due: "₱0.00",
      due_date: null,
      past_due: false,
      disconnection_date: null,
    });
  });

  it("says plainly when the verified account has no balance on record", async () => {
    const world = testWorld();
    world.balances = world.balances.filter((b) => b.accountNumber !== JOSE.accountNumber);
    const ctx = newContext(world);
    await verifyAs(ctx, JOSE);

    await expect(overview(ctx, JOSE.accountNumber)).rejects.toThrow(
      "no balance is on record for the account verified on this call",
    );
  });
});

describe("get_account_overview — its input", () => {
  it("takes the account number and nothing else", () => {
    expect(getAccountOverview.input.safeParse({ account_number: "" }).success).toBe(false);
    expect(
      getAccountOverview.input.safeParse({ account_number: JOSE.accountNumber, extra: 1 }).success,
    ).toBe(false);
  });

  it("is a read", () => {
    expect(getAccountOverview.safetyClass).toBe("read");
    expect(getAccountOverview.idempotent).toBe(true);
  });
});
