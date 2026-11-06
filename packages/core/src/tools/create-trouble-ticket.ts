/**
 * `create_trouble_ticket`: hand the verified caller's concern to the team that
 * can act on it, with a reference the caller can quote back.
 *
 * The ticket is always on the verified account: the input has no account
 * number, so the model cannot open one anywhere else.
 */
import { z } from "zod";

import { TICKET_CATEGORIES } from "../systems/types";

import { requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";

export const createTroubleTicket = defineTalaTool({
  name: "create_trouble_ticket",
  description:
    "Opens a ticket on the account verified on this call, for a team to act on what you " +
    "cannot do on the call yourself, such as posting a payment that was received but has " +
    "not posted (category billing). Returns the ticket reference: give it to the caller so " +
    "they can follow up. Open one ticket per concern; calling it again opens another ticket.",
  input: z
    .object({
      category: z
        .enum(TICKET_CATEGORIES)
        .describe(
          "billing: payments and bills. connection: no internet, slow internet or the modem. " +
            "other: anything else.",
        ),
      notes: z
        .string()
        .min(10)
        .max(500)
        .describe(
          "What the team needs to know, in one or two plain sentences: what happened and what " +
            "should be done. No account or phone numbers.",
        ),
    })
    .strict(),
  safetyClass: "auto_write",
  idempotent: false,
  handler: async (input, ctx) => {
    const accountNumber = requireVerifiedAccount(ctx);
    const { reference } = await ctx.data.systems.tickets.createTicket({
      accountNumber,
      category: input.category,
      notes: input.notes,
    });
    return { created: true, reference };
  },
});
