/**
 * `verify_payment`: did the verified caller's payment reach us, and has it
 * posted?
 *
 * It looks only among the verified account's own payments. A reference that
 * belongs to another account's payment answers exactly as an unknown one does,
 * so no caller can learn about anyone's payment by quoting its reference.
 */
import { z } from "zod";

import { PAYMENT_CHANNELS } from "../systems/types";

import { requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatCompanyMoney, formatLocalTime } from "./format-time";

/**
 * Removes what speech-to-text puts inside a long reference (whitespace, the
 * hyphen-minus and the Unicode dashes U+2010 to U+2015) and upper-cases the
 * letters, the form references are stored in. Nothing else is repaired, so a
 * malformed reference misses the lookup.
 */
function normalizeReference(raw: string): string {
  return raw.replace(/[\s\-\u2010-\u2015]/g, "").toUpperCase();
}

export const verifyPayment = defineTalaTool({
  name: "verify_payment",
  description:
    "Looks up a payment the verified caller made, by the reference number the payment " +
    "channel gave them. Use it when a verified caller says a payment has not posted. It " +
    "searches only the account verified on this call with verify_identity. Returns found " +
    "false when no payment of that account has the reference: ask the caller to check the " +
    "number, and never suggest it might be on another account. When found, returns the " +
    `channel (one of ${PAYMENT_CHANNELS.join(", ")}), the amount and the time it was paid, ` +
    "as they should be said, and posted: whether the payment has been applied to the " +
    "account yet.",
  input: z
    .object({
      reference: z
        .string()
        .min(1)
        .max(40)
        .describe("The payment's reference number as the caller said it; spaces and dashes are fine."),
    })
    .strict(),
  safetyClass: "read",
  idempotent: true,
  handler: async (input, ctx) => {
    const { accountNumber } = await requireVerifiedAccount(ctx);
    const { systems, company } = ctx.data;
    const payment = await systems.billing.findPayment(
      accountNumber,
      normalizeReference(input.reference),
    );
    if (payment === null) return { found: false };
    return {
      found: true,
      channel: payment.channel,
      amount: formatCompanyMoney(payment.amountMinor, company),
      paid_at: formatLocalTime(payment.paidAt, company),
      posted: payment.posted,
    };
  },
});
