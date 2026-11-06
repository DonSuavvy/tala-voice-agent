/**
 * The account gate, as every account tool runs it.
 *
 * The decision is the identity policy's (`checkAccountAccess`); this turns a
 * refusal into the words the model reads, so every account tool refuses the
 * same way. The SOP tells the model to verify first; this is the code making
 * sure of it.
 */
import { attemptsRemaining, checkAccountAccess, normalizeAccountNumber } from "../policy/identity";

import type { TalaToolContext } from "./context";

/**
 * The verified account's number, normalized, or a thrown refusal.
 *
 * `requested` is the account number the model named, for a tool whose input
 * has one; any other account is refused. A tool that only ever acts on the
 * verified account leaves it out.
 *
 * Once a call is verified, its account never changes (`verify_identity`
 * refuses any other), so a handler may await after this and still act on the
 * account it was let through for.
 */
export function requireVerifiedAccount(ctx: TalaToolContext, requested?: string): string {
  const { identity } = ctx.data;
  const account =
    requested === undefined ? identity.verifiedAccount : normalizeAccountNumber(requested);
  const access = checkAccountAccess(identity, account ?? "");
  if (!access.allowed) {
    // Unverified because verification is locked is a dead end, not a next
    // step: telling the model to verify would contradict verify_identity.
    const reason =
      access.reason === "not_verified" && attemptsRemaining(identity, ctx.policyConfig) === 0
        ? "verification_locked"
        : access.reason;
    throw new Error(refusal(reason));
  }
  // Allowed means verified, so the account is not null here.
  return account!;
}

/** What the model reads when the account gate refuses: what happened, and what to do instead. */
function refusal(reason: "not_verified" | "verification_locked" | "other_account"): string {
  switch (reason) {
    case "not_verified":
      return (
        "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first."
      );
    case "verification_locked":
      return (
        "Refused: verification is locked for this call, so no account can be checked. " +
        "Do not call verify_identity again; tell the caller you cannot access the account " +
        "on this call."
      );
    case "other_account":
      return (
        "Refused: this call is verified for a different account, " +
        "and only that account can be checked."
      );
    default:
      return reason satisfies never;
  }
}
