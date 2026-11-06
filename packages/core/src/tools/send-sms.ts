/**
 * `send_sms`: text the verified caller a summary or a reference number.
 *
 * The text goes only to the mobile number registered on the verified account.
 * That is a property of the input, not a check in the handler: there is no
 * field for a number, the schema is strict, and the loop refuses any input
 * its schema rejects before the handler runs. A model talked into "send it to
 * my other number" has nowhere to put the number.
 */
import { z } from "zod";

import { holdsAccountNumbers } from "../policy/account-numbers";

import { requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";

export const sendSms = defineTalaTool({
  name: "send_sms",
  description:
    "Sends a text message to the mobile number registered on the account verified on this " +
    "call, and only to that number: there is no way to send to any other. Use it to text the " +
    "caller a short summary or a reference number, such as a ticket reference, after offering " +
    "to. Returns sent true and the last 4 digits of the number it went to; say only those " +
    "digits, never the whole number.",
  input: z
    .object({
      message: z
        .string()
        .min(1)
        .max(320)
        .describe("The text to send: short, plain, with no account or full mobile numbers."),
    })
    .strict(),
  safetyClass: "auto_write",
  idempotent: false,
  handler: async (input, ctx) => {
    const accountNumber = requireVerifiedAccount(ctx);
    const { systems } = ctx.data;
    const account = await systems.accounts.findAccount(accountNumber);
    // The gate passed, so this account was found when it was verified. Missing
    // now means the business system changed under the call: say so plainly.
    if (account === null) {
      throw new Error("the account verified on this call could not be found");
    }
    if (holdsAccountNumbers(input.message, account)) {
      throw new Error(
        "Refused: the message contains the account number or the registered mobile number. " +
          "Leave out the account and mobile numbers; the text already goes to the mobile on file.",
      );
    }
    await systems.sms.send({ to: account.registeredMobile, message: input.message });
    return { sent: true, to_last4: account.registeredMobile.slice(-4) };
  },
});
