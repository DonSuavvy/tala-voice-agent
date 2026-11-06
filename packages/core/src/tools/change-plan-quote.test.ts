import { describe, expect, it } from "vitest";

import { toStrictJsonSchema } from "../agent/registry";
import type { InMemorySystems } from "../systems/in-memory";
import { ANA, CALL_STARTED_AT, JOSE, MARIA, testSystems, testToolContext } from "../testing/fixtures";

import { changePlanQuote } from "./change-plan-quote";
import type { TalaToolContext } from "./context";
import { verifyIdentity } from "./verify-identity";

/**
 * `change_plan_quote`, driven through its public definition against a real
 * in-memory world and the real account gate.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. Maria is on Kidlat 300,
 * and her latest bill was issued Mon, Oct 12 at 1:00 PM, so her billing cycle
 * runs to Thu, Nov 12 at 1:00 PM: 31 days, 6 of them left. Ana has no bill on
 * record. Every amount is worked out by hand in its comment.
 */

function newCall(now?: Date): { ctx: TalaToolContext; systems: InMemorySystems } {
  const systems = testSystems();
  return { ctx: testToolContext(systems, { now }), systems };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function quote(ctx: TalaToolContext, input: unknown) {
  return changePlanQuote.handler(changePlanQuote.input.parse(input), ctx);
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("change_plan_quote — the account gate", () => {
  it("refuses before the caller is verified, and keeps no quote", async () => {
    const { ctx, systems } = newCall();

    await expect(
      quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-500" }),
    ).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
    expect(await systems.plans.findQuote(MARIA.accountNumber, "QTE-2026-00001")).toBeNull();
  });

  it("refuses any account but the one verified on this call", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    await expect(
      quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-500" }),
    ).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
    expect(await systems.plans.findQuote(MARIA.accountNumber, "QTE-2026-00001")).toBeNull();
  });
});

describe("change_plan_quote — an upgrade", () => {
  /** 300 to 500 is 400 pesos a month more: 40,000 x 6 / 31 = 7,741.94, so 7,742. */
  it("prices Maria's move to Kidlat 500: the new monthly price, the prorated amount, from today", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);

    expect(await quote(ctx, { account_number: "801-234-5601", plan_id: "kidlat-500" })).toEqual({
      quote_id: "QTE-2026-00001",
      current_plan: "Kidlat 300",
      new_plan: "Kidlat 500",
      new_monthly_price: "₱2,099.00",
      prorated_amount: "₱77.42",
      effective_date: "Fri, Nov 6",
      kind: "upgrade",
    });
  });

  it("keeps the quote, with when it was made, and changes no plan", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);
    await quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-500" });

    expect(await systems.plans.findQuote(MARIA.accountNumber, "QTE-2026-00001")).toEqual({
      reference: "QTE-2026-00001",
      accountNumber: MARIA.accountNumber,
      currentPlanName: "Kidlat 300",
      newPlanName: "Kidlat 500",
      newMonthlyPriceMinor: 209_900,
      proratedAmountMinor: 7_742,
      effectiveAt: CALL_STARTED_AT,
      quotedAt: CALL_STARTED_AT,
      used: false,
    });
    expect((await systems.accounts.findAccount(MARIA.accountNumber))?.planName).toBe("Kidlat 300");
  });

  /** Three days later, at 1:00 PM on Mon, Nov 9, 3 days are left: 40,000 x 3 / 31 = 3,870.97. */
  it("prorates from the moment it is asked", async () => {
    const { ctx } = newCall(new Date("2026-11-09T05:00:00Z"));
    await verifyAs(ctx, MARIA);

    expect(await quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-500" })).toMatchObject({
      prorated_amount: "₱38.71",
      effective_date: "Mon, Nov 9",
    });
  });
});

describe("change_plan_quote — a downgrade", () => {
  it("prices Maria's move to Kidlat 100 from the next cycle, with nothing prorated", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);

    expect(await quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-100" })).toEqual({
      quote_id: "QTE-2026-00001",
      current_plan: "Kidlat 300",
      new_plan: "Kidlat 100",
      new_monthly_price: "₱1,299.00",
      prorated_amount: "₱0.00",
      effective_date: "Thu, Nov 12",
      kind: "downgrade",
    });
  });
});

describe("change_plan_quote — refusals", () => {
  it("refuses the plan the caller is already on, and keeps no quote", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);

    await expect(
      quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-300" }),
    ).rejects.toThrow("Refused: the caller is already on that plan.");
    expect(await systems.plans.findQuote(MARIA.accountNumber, "QTE-2026-00001")).toBeNull();
  });

  it("refuses a plan id that is not in the catalog, and keeps no quote", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);

    await expect(
      quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-2000" }),
    ).rejects.toThrow(
      "Refused: no plan has that id. Use a plan id from the plan list in your instructions.",
    );
    expect(await systems.plans.findQuote(MARIA.accountNumber, "QTE-2026-00001")).toBeNull();
  });

  const NO_CYCLE =
    "Refused: the account has no current billing cycle to price the change against, so its " +
    "plan cannot be changed on this call.";

  it("refuses an account with no bill on record, so no cycle to prorate against", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, ANA);

    await expect(
      quote(ctx, { account_number: ANA.accountNumber, plan_id: "kidlat-300" }),
    ).rejects.toThrow(NO_CYCLE);
    expect(await systems.plans.findQuote(ANA.accountNumber, "QTE-2026-00001")).toBeNull();
  });

  /** Maria's cycle ended at 1:00 PM on Thu, Nov 12, and no later bill is on record. */
  it("refuses once the latest bill's cycle has ended", async () => {
    const { ctx } = newCall(new Date("2026-11-12T05:00:00Z"));
    await verifyAs(ctx, MARIA);

    await expect(
      quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-500" }),
    ).rejects.toThrow(NO_CYCLE);
  });
});

describe("change_plan_quote — what it gives and takes", () => {
  it("never carries the account number or the mobile number", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);
    const result = JSON.stringify(
      await quote(ctx, { account_number: MARIA.accountNumber, plan_id: "kidlat-500" }),
    );

    expect(result).not.toContain(MARIA.accountNumber);
    expect(result).not.toContain("9175550101");
  });

  const valid = { account_number: MARIA.accountNumber, plan_id: "kidlat-500" };
  const parses = (input: unknown) => changePlanQuote.input.safeParse(input).success;

  it("takes the account number and a plan id, each required, and nothing else", () => {
    expect(parses(valid)).toBe(true);
    for (const field of Object.keys(valid)) {
      expect(parses({ ...valid, [field]: "" }), field).toBe(false);
    }
    expect(parses({ ...valid, extra: 1 })).toBe(false);
    expect(Object.keys(toStrictJsonSchema(changePlanQuote.input).properties)).toEqual([
      "account_number",
      "plan_id",
    ]);
  });

  /** It changes nothing about the account: the quote it keeps changes a plan only through change_plan. */
  it("is a read that is not safe to replay blindly: a replay keeps a second quote", () => {
    expect(changePlanQuote.safetyClass).toBe("read");
    expect(changePlanQuote.idempotent).toBe(false);
  });
});
