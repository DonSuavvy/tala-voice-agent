import { describe, expect, it } from "vitest";

import { toStrictJsonSchema } from "../agent/registry";
import type { InMemorySystems } from "../systems/in-memory";
import { CALL_STARTED_AT, JOSE, MARIA, testSystems, testToolContext } from "../testing/fixtures";

import { changePlan } from "./change-plan";
import { changePlanQuote } from "./change-plan-quote";
import type { TalaToolContext } from "./context";
import { getAccountOverview } from "./get-account-overview";
import { verifyIdentity } from "./verify-identity";

/**
 * `change_plan`, driven through its public definition against a real
 * in-memory world and the real account gate. What the plan is afterwards is
 * read the way Tala reads it, with `get_account_overview`.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. Maria is on Kidlat 300;
 * her billing cycle runs to Thu, Nov 12.
 */

function newCall(): { ctx: TalaToolContext; systems: InMemorySystems } {
  const systems = testSystems();
  return { ctx: testToolContext(systems), systems };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function change(ctx: TalaToolContext, input: unknown) {
  return changePlan.handler(changePlan.input.parse(input), ctx);
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

/** Quotes a move to `planId` on the verified account, as Tala would; returns the quote_id. */
async function quoteFor(ctx: TalaToolContext, accountNumber: string, planId: string): Promise<string> {
  const quoted = await changePlanQuote.handler(
    changePlanQuote.input.parse({ account_number: accountNumber, plan_id: planId }),
    ctx,
  );
  return (quoted as { quote_id: string }).quote_id;
}

/** The plan as Tala would read it back. */
async function planOf(ctx: TalaToolContext, accountNumber: string): Promise<string> {
  const overview = await getAccountOverview.handler(
    getAccountOverview.input.parse({ account_number: accountNumber }),
    ctx,
  );
  return (overview as { plan: string }).plan;
}

const NO_QUOTE =
  "Refused: a plan is changed only with a quote made for this account on this call, once, " +
  "while the account is still on the plan the quote priced, and that quote_id is not one. " +
  "Price the change with change_plan_quote, read the price back, and change the plan with " +
  "the quote_id it returns only after the caller says yes.";

describe("change_plan — the account gate", () => {
  it("refuses before the caller is verified, and changes nothing", async () => {
    const { ctx, systems } = newCall();

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: "QTE-2026-00001", customer_confirmed: true }),
    ).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
    expect((await systems.accounts.findAccount(MARIA.accountNumber))?.planName).toBe("Kidlat 300");
  });

  it("refuses any account but the one verified on this call, and changes nothing", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: "QTE-2026-00001", customer_confirmed: true }),
    ).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
    expect((await systems.accounts.findAccount(MARIA.accountNumber))?.planName).toBe("Kidlat 300");
  });
});

describe("change_plan — a change the caller confirmed", () => {
  it("moves Maria to Kidlat 500 from today, and the overview reads the new plan", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);
    const quoteId = await quoteFor(ctx, MARIA.accountNumber, "kidlat-500");

    expect(
      await change(ctx, { account_number: "801 234 5601", quote_id: quoteId, customer_confirmed: true }),
    ).toEqual({ changed: true, plan: "Kidlat 500", effective_date: "Fri, Nov 6" });
    expect(await planOf(ctx, MARIA.accountNumber)).toBe("Kidlat 500");
  });

  it("gives a downgrade's date as the next billing cycle's start", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);
    const quoteId = await quoteFor(ctx, MARIA.accountNumber, "kidlat-100");

    expect(
      await change(ctx, { account_number: MARIA.accountNumber, quote_id: quoteId, customer_confirmed: true }),
    ).toEqual({ changed: true, plan: "Kidlat 100", effective_date: "Thu, Nov 12" });
  });

  it("marks the quote used", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);
    const quoteId = await quoteFor(ctx, MARIA.accountNumber, "kidlat-500");
    await change(ctx, { account_number: MARIA.accountNumber, quote_id: quoteId, customer_confirmed: true });

    expect(await systems.plans.findQuote(MARIA.accountNumber, quoteId)).toMatchObject({ used: true });
  });
});

describe("change_plan — without the caller's confirmation", () => {
  const parses = (input: unknown) => changePlan.input.safeParse(input).success;
  const confirmed = { account_number: MARIA.accountNumber, quote_id: "QTE-2026-00001", customer_confirmed: true };

  /** The loop parses every call with the tool's schema, so the handler never runs on these. */
  it.each([
    ["false", false],
    ["the text true", "true"],
    ["1", 1],
    ["null", null],
  ])("refuses customer_confirmed %s", (_what, value) => {
    expect(parses(confirmed)).toBe(true);
    expect(parses({ ...confirmed, customer_confirmed: value })).toBe(false);
  });

  it("refuses a change with no customer_confirmed at all", () => {
    const { customer_confirmed: _confirmed, ...unconfirmed } = confirmed;
    expect(parses(unconfirmed)).toBe(false);
  });

  it("tells the model the field must be true", () => {
    expect(toStrictJsonSchema(changePlan.input).properties.customer_confirmed).toMatchObject({
      const: true,
    });
  });
});

describe("change_plan — without a matching quote", () => {
  it("refuses a quote_id no quote has, and the plan stays the same", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: "QTE-2026-00001", customer_confirmed: true }),
    ).rejects.toThrow(NO_QUOTE);
    expect(await planOf(ctx, MARIA.accountNumber)).toBe("Kidlat 300");
  });

  it("refuses another account's quote, and the plan stays the same", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);
    const { reference } = await systems.plans.createQuote(
      {
        accountNumber: JOSE.accountNumber,
        currentPlanName: "Kidlat 300",
        newPlanName: "Kidlat 500",
        newMonthlyPriceMinor: 209_900,
        proratedAmountMinor: 7_742,
        effectiveAt: CALL_STARTED_AT,
      },
      CALL_STARTED_AT,
    );

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: reference, customer_confirmed: true }),
    ).rejects.toThrow(NO_QUOTE);
    expect(await planOf(ctx, MARIA.accountNumber)).toBe("Kidlat 300");
  });

  /**
   * "Made on this call" is checked against when the quote was made, so it
   * holds for a system that also keeps quotes from earlier calls.
   */
  it("refuses a quote made before the call started, and the plan stays the same", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, MARIA);
    const { reference } = await systems.plans.createQuote(
      {
        accountNumber: MARIA.accountNumber,
        currentPlanName: "Kidlat 300",
        newPlanName: "Kidlat 500",
        newMonthlyPriceMinor: 209_900,
        proratedAmountMinor: 7_742,
        effectiveAt: CALL_STARTED_AT,
      },
      new Date(CALL_STARTED_AT.getTime() - 60_000),
    );

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: reference, customer_confirmed: true }),
    ).rejects.toThrow(NO_QUOTE);
    expect(await planOf(ctx, MARIA.accountNumber)).toBe("Kidlat 300");
  });

  it("refuses a quote already used, so one quote changes a plan once", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);
    const up = await quoteFor(ctx, MARIA.accountNumber, "kidlat-500");
    await change(ctx, { account_number: MARIA.accountNumber, quote_id: up, customer_confirmed: true });
    const down = await quoteFor(ctx, MARIA.accountNumber, "kidlat-300");
    await change(ctx, { account_number: MARIA.accountNumber, quote_id: down, customer_confirmed: true });

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: up, customer_confirmed: true }),
    ).rejects.toThrow(NO_QUOTE);
    expect(await planOf(ctx, MARIA.accountNumber)).toBe("Kidlat 300");
  });

  /** A second quote priced the move from Kidlat 300; once on Kidlat 500, its price no longer holds. */
  it("refuses a quote priced from a plan the account has since left, and the plan stays the same", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, MARIA);
    const toFiveHundred = await quoteFor(ctx, MARIA.accountNumber, "kidlat-500");
    const toOneHundred = await quoteFor(ctx, MARIA.accountNumber, "kidlat-100");
    await change(ctx, { account_number: MARIA.accountNumber, quote_id: toFiveHundred, customer_confirmed: true });

    await expect(
      change(ctx, { account_number: MARIA.accountNumber, quote_id: toOneHundred, customer_confirmed: true }),
    ).rejects.toThrow(NO_QUOTE);
    expect(await planOf(ctx, MARIA.accountNumber)).toBe("Kidlat 500");
  });
});

describe("change_plan — its input", () => {
  const valid = { account_number: MARIA.accountNumber, quote_id: "QTE-2026-00001", customer_confirmed: true };
  const parses = (input: unknown) => changePlan.input.safeParse(input).success;

  it("takes the account number, a quote_id and the confirmation, each required, and nothing else", () => {
    expect(parses(valid)).toBe(true);
    expect(parses({ ...valid, account_number: "" })).toBe(false);
    expect(parses({ ...valid, quote_id: "" })).toBe(false);
    expect(parses({ ...valid, extra: 1 })).toBe(false);
    expect(Object.keys(toStrictJsonSchema(changePlan.input).properties)).toEqual([
      "account_number",
      "quote_id",
      "customer_confirmed",
    ]);
  });

  it("is a write that is not idempotent: replaying it with the same quote is refused", () => {
    expect(changePlan.safetyClass).toBe("auto_write");
    expect(changePlan.idempotent).toBe(false);
  });
});
