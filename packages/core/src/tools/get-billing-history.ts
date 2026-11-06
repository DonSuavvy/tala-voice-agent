/**
 * `get_billing_history`: the verified caller's recent bills and payments, as
 * one list.
 *
 * It takes an account number, like `check_area_outage`, so a request about
 * anyone else's account reaches the code and is refused there by the account
 * gate, where the refusal can be seen.
 */
import { z } from "zod";

import { formatMoney } from "../agent/sop";

import { requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatLocalDate } from "./format-time";

/** Enough to show a pattern of months; more is too much to say on a call. */
const MAX_ENTRIES = 6;

export const getBillingHistory = defineTalaTool({
  name: "get_billing_history",
  description:
    "Lists the recent bills and payments of the caller's account, newest first, at most " +
    `${MAX_ENTRIES}. Use it when a verified caller asks about past bills or payments. It works ` +
    "only for the account verified on this call with verify_identity, and refuses any other. " +
    "Each entry is a bill or a payment with its date and amount, as they should be said; a " +
    "payment also has its channel and posted: whether it has been applied to the account. " +
    "Tell the caller only the entries they asked about.",
  input: z
    .object({
      account_number: z
        .string()
        .min(1)
        .max(40)
        .describe("The account number as the caller said it; spaces and dashes are fine."),
    })
    .strict(),
  safetyClass: "read",
  idempotent: true,
  handler: async (input, ctx) => {
    const accountNumber = requireVerifiedAccount(ctx, input.account_number);
    const { systems, company } = ctx.data;
    const [bills, payments] = await Promise.all([
      systems.billing.billsFor(accountNumber),
      systems.billing.paymentsFor(accountNumber),
    ]);
    const money = (minor: number) =>
      formatMoney(minor, { code: company.currency, locale: company.locale });

    const entries = [
      ...bills.map((bill) => ({
        at: bill.issuedAt,
        entry: {
          kind: "bill",
          date: formatLocalDate(bill.issuedAt, company),
          amount: money(bill.amountMinor),
        },
      })),
      ...payments.map((payment) => ({
        at: payment.paidAt,
        entry: {
          kind: "payment",
          date: formatLocalDate(payment.paidAt, company),
          amount: money(payment.amountMinor),
          channel: payment.channel,
          posted: payment.posted,
        },
      })),
    ]
      // Newest first. The sort is stable, so at the same moment a bill comes
      // before a payment.
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, MAX_ENTRIES)
      .map(({ entry }) => entry);

    return { entries };
  },
});
