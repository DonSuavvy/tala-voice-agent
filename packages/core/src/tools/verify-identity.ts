/**
 * `verify_identity`: the caller proves they hold an account.
 *
 * Every decision is the identity policy's (`../policy/identity`); this handler
 * only puts them in order and replaces the call's identity state. Two rules
 * shape the result: a failure reads the same for an unknown account and a
 * wrong last 4, so no account can be probed, and no result ever carries the
 * mobile number or the full account number.
 */
import { z } from "zod";

import {
  attemptsRemaining,
  checkVerificationAttempt,
  mobileLast4Matches,
  normalizeAccountNumber,
  recordVerification,
} from "../policy/identity";
import { parseSupportPolicy } from "../policy/support-policy";
import type { AccountRecord } from "../systems/types";

import { defineTalaTool } from "./context";

export const verifyIdentity = defineTalaTool({
  name: "verify_identity",
  description:
    "Verifies that the caller holds an account, using the account number and the last 4 " +
    "digits of the mobile number registered on it. Call it before any other account tool: " +
    "nothing about an account may be shared until it returns verified true. Only one " +
    "account can be verified per call. On success it returns the holder's first name, " +
    "service area and account status. On failure it returns attempts_remaining; the result " +
    "is the same whether the account number or the digits were wrong, so never tell the " +
    "caller which. When locked is true, verification is locked for the rest of the call: do " +
    "not call it again. Calling it again for the account already verified spends no attempt " +
    "and returns already_verified true. If the caller gives other than 4 digits, ask again " +
    "before calling.",
  input: z
    .object({
      account_number: z
        .string()
        .min(1)
        .max(40)
        .describe("The account number as the caller said it; spaces and dashes are fine."),
      mobile_last4: z
        .string()
        .regex(/^\s*(\d\s*){4}$/)
        .describe("Exactly the last 4 digits of the mobile number registered on the account."),
    })
    .strict(),
  safetyClass: "read",
  idempotent: false,
  handler: async (input, ctx) => {
    const requested = normalizeAccountNumber(input.account_number);
    const gate = checkVerificationAttempt(ctx.data.identity, requested, ctx.policyConfig);
    if (!gate.allowed) throw new Error(refusal(gate.reason, ctx.policyConfig));
    const account = await ctx.data.systems.accounts.findAccount(requested);
    if (gate.alreadyVerified) {
      if (account === null) {
        throw new Error("the account verified on this call could not be found");
      }
      return verifiedResult(account, true);
    }
    const matched =
      account !== null && mobileLast4Matches(account.registeredMobile, input.mobile_last4);
    ctx.data.identity = recordVerification(ctx.data.identity, requested, matched);
    if (account === null || !matched) {
      const remaining = attemptsRemaining(ctx.data.identity, ctx.policyConfig);
      return { verified: false, attempts_remaining: remaining, locked: remaining === 0 };
    }
    return verifiedResult(account, false);
  },
});

/** What the model reads when the gate refuses: what happened, and what to do instead. */
function refusal(reason: "other_account_verified" | "locked", policy: unknown): string {
  switch (reason) {
    case "other_account_verified":
      return (
        "This call is already verified for a different account. " +
        "Only that account can be served on this call."
      );
    case "locked": {
      const { maxFailedAttempts } = parseSupportPolicy(policy).identity;
      return (
        `Verification is locked for this call after ${maxFailedAttempts} failed attempts. ` +
        "Do not try again; tell the caller you cannot access the account on this call."
      );
    }
    default:
      return reason satisfies never;
  }
}

function verifiedResult(account: AccountRecord, alreadyVerified: boolean) {
  return {
    verified: true,
    already_verified: alreadyVerified,
    holder_first_name: account.holderName.split(" ")[0],
    service_area: `${account.serviceArea.barangayName}, ${account.serviceArea.city}`,
    account_status: account.status,
  };
}
