/**
 * `change_plan_quote`: price a change of the verified caller's plan, and keep
 * the quote so `change_plan` can make that change once the caller says yes.
 *
 * The price is the plan-change policy's (`../policy/plan-change`), from the
 * company pack's catalog and the account's latest bill, at the call's `now`.
 * The quote is kept in the business systems with when it was made; it changes
 * nothing about the account.
 */
import { z } from "zod";

import { pricePlanChange, type PlanChangePrice } from "../policy/plan-change";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatCompanyMoney, formatLocalDate } from "./format-time";

export const changePlanQuote = defineTalaTool({
  name: "change_plan_quote",
  description:
    "Prices a change of the caller's plan: the new plan's monthly price, the prorated amount " +
    "added to the next bill, and the date the change takes effect. An upgrade, to a plan that " +
    "costs more, takes effect today, with the difference for the rest of the billing cycle " +
    "prorated; a downgrade takes effect when the next billing cycle starts, with nothing " +
    "prorated. Use it when a verified caller asks to change plans or what a change would cost. " +
    "It works only for the account verified on this call with verify_identity, and refuses any " +
    "other. It changes nothing: read the price back to the caller, and only if they say yes, " +
    "make the change with change_plan and the quote_id this returns. Amounts and dates are " +
    "given as they should be said.",
  input: z
    .object({
      account_number: accountNumberInput,
      plan_id: z
        .string()
        .min(1)
        .max(40)
        .describe(
          "The id of the plan the caller wants, as the plan list in your instructions gives it.",
        ),
    })
    .strict(),
  safetyClass: "read",
  idempotent: false,
  handler: async (input, ctx) => {
    const account = await requireVerifiedAccount(ctx, input.account_number);
    const { systems, company, plans } = ctx.data;

    const next = plans.find((plan) => plan.id === input.plan_id);
    if (!next) {
      throw new Error(
        "Refused: no plan has that id. Use a plan id from the plan list in your instructions.",
      );
    }
    // The pack's boot check puts every seeded account on a catalog plan; an
    // account the business systems hold on another plan cannot be priced.
    const current = plans.find((plan) => plan.name === account.planName);
    if (!current) {
      throw new Error("the plan of the account verified on this call is not in the plan catalog");
    }

    const [latestBill] = await systems.billing.billsFor(account.accountNumber);
    const price: PlanChangePrice =
      latestBill === undefined
        ? { allowed: false, reason: "outside_billing_cycle" }
        : pricePlanChange({
            current,
            next,
            latestBillIssuedAt: latestBill.issuedAt,
            now: ctx.now,
            timeZone: company.timeZone,
          });
    if (!price.allowed) throw new Error(refusal(price.reason));

    const { reference } = await systems.plans.createQuote(
      {
        accountNumber: account.accountNumber,
        currentPlanName: current.name,
        newPlanName: next.name,
        newMonthlyPriceMinor: next.monthlyPriceMinor,
        proratedAmountMinor: price.proratedAmountMinor,
        effectiveAt: price.effectiveAt,
      },
      ctx.now,
    );
    return {
      quote_id: reference,
      current_plan: current.name,
      new_plan: next.name,
      new_monthly_price: formatCompanyMoney(next.monthlyPriceMinor, company),
      prorated_amount: formatCompanyMoney(price.proratedAmountMinor, company),
      effective_date: formatLocalDate(price.effectiveAt, company),
      kind: price.kind,
    };
  },
});

/** What the model reads when the change cannot be priced. */
function refusal(reason: "same_plan" | "outside_billing_cycle"): string {
  switch (reason) {
    case "same_plan":
      return "Refused: the caller is already on that plan.";
    case "outside_billing_cycle":
      return (
        "Refused: the account has no current billing cycle to price the change against, so " +
        "its plan cannot be changed on this call."
      );
    default:
      return reason satisfies never;
  }
}
