/**
 * `change_plan`: make the plan change a quote priced, once the verified
 * caller has heard the price and said yes.
 *
 * Two things must hold, and the code checks both. The caller confirmed:
 * `customer_confirmed` must be the literal `true`, so a call without it is
 * refused by the tool's own schema before this handler runs, and the caller
 * must have spoken since the quote was made, so a quote and a change in the
 * same turn, before the caller heard the price, are refused. And the change
 * matches a quote: the latest one the business systems hold for this account
 * (a newer quote supersedes an older one the caller may have heard first),
 * made at or after the call's start (they may hold older ones), not used
 * yet, and priced from the plan the account is still on. The model proposes the quote; the
 * code checks it before any plan changes.
 */
import { z } from "zod";

import { planWithId } from "../pack/plan-catalog";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatLocalDate } from "./format-time";

/** What the model reads when the quote_id is not the one quote that may change the plan. */
const NO_MATCHING_QUOTE =
  "Refused: a plan is changed only with the latest quote made for this account on this call, " +
  "once, while the account is still on the plan the quote priced, and that quote_id is not " +
  "one. Price the change with change_plan_quote, read the price back, and change the plan " +
  "with the quote_id it returns only after the caller says yes.";

export const changePlan = defineTalaTool({
  name: "change_plan",
  description:
    "Changes the caller's plan as a quote from change_plan_quote priced it. Call it only after " +
    "you have read the quote's price back and the caller has clearly said yes; if they decline " +
    "or are unsure, do not call it. It works only for the account verified on this call with " +
    "verify_identity, and refuses any other. It refuses a quote that is not the latest made " +
    "for this account on this call, that was used already, or that priced a move from a plan " +
    "the account is no longer on, and a change before the caller has spoken since the quote, " +
    "as in the same turn. Returns changed true, the new plan, and the date the change " +
    "takes effect, as it should be said. A change that takes effect later is scheduled: the " +
    "account stays on its plan until that date.",
  input: z
    .object({
      account_number: accountNumberInput,
      quote_id: z
        .string()
        .min(1)
        .max(40)
        .describe("The quote_id change_plan_quote gave for the change the caller agreed to."),
      customer_confirmed: z
        .literal(true)
        .describe("True only once the caller has heard the price and said yes to the change."),
    })
    .strict(),
  safetyClass: "auto_write",
  idempotent: false,
  handler: async (input, ctx) => {
    const account = await requireVerifiedAccount(ctx, input.account_number);
    const { systems, company, plans, startedAt } = ctx.data;
    const { accountNumber } = account;

    const quote = await systems.plans.latestQuote(accountNumber);
    const matches =
      quote !== null &&
      quote.reference === input.quote_id &&
      !quote.used &&
      quote.quotedAt.getTime() >= startedAt.getTime() &&
      quote.currentPlanId === account.planId;
    if (!matches) {
      throw new Error(NO_MATCHING_QUOTE);
    }
    const lastSpoke = ctx.data.lastCallerTurnAt();
    if (lastSpoke === null || lastSpoke.getTime() <= quote.quotedAt.getTime()) {
      throw new Error(
        "Refused: the caller has not spoken since this quote was made, so they have not said " +
          "yes to its price. Read the price back and wait for their answer before calling " +
          "change_plan.",
      );
    }

    await systems.plans.applyQuote(accountNumber, quote.reference, ctx.now);
    return {
      changed: true,
      plan: planWithId(plans, quote.newPlanId).name,
      effective_date: formatLocalDate(quote.effectiveAt, company),
    };
  },
});
