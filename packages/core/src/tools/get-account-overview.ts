/**
 * `get_account_overview`: the verified caller's plan, status and what they
 * owe.
 *
 * It takes an account number, like `check_area_outage`, so a request about
 * anyone else's account ("my neighbor's balance") reaches the code and is
 * refused there by the account gate, where the refusal can be seen.
 */
import { z } from "zod";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatCompanyMoney, formatLocalDate } from "./format-time";

export const getAccountOverview = defineTalaTool({
  name: "get_account_overview",
  description:
    "Gives the plan, the account status and the balance of the caller's account: the amount " +
    "due, the due date, whether it is past due, and the date of any scheduled disconnection " +
    "for non-payment. Use it when a verified caller asks what they owe, when it is due, or " +
    "whether they will be disconnected. It works only for the account verified on this call " +
    "with verify_identity, and refuses any other. Amounts and dates are given as they should " +
    "be said. A null due_date means nothing is due; a null disconnection_date means none is " +
    "scheduled.",
  input: z
    .object({
      account_number: accountNumberInput,
    })
    .strict(),
  safetyClass: "read",
  idempotent: true,
  handler: async (input, ctx) => {
    const account = await requireVerifiedAccount(ctx, input.account_number);
    const { systems, company } = ctx.data;
    const balance = await systems.billing.balanceOf(account.accountNumber);
    if (balance === null) {
      throw new Error("no balance is on record for the account verified on this call");
    }

    return {
      plan: account.planName,
      account_status: account.status,
      balance_due: formatCompanyMoney(balance.amountDueMinor, company),
      due_date: balance.dueAt === null ? null : formatLocalDate(balance.dueAt, company),
      // Decided here, not by the model: comparing dates is a calculation it
      // can get wrong.
      past_due:
        balance.amountDueMinor > 0 &&
        balance.dueAt !== null &&
        balance.dueAt.getTime() < ctx.now.getTime(),
      disconnection_date:
        balance.disconnectionAt === null ? null : formatLocalDate(balance.disconnectionAt, company),
    };
  },
});
