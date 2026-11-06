/**
 * `check_area_outage`: is there an outage where the verified caller's line is?
 *
 * The account gate runs in this handler as well as in the SOP: the model is
 * told to verify first, and the code refuses if it did not.
 */
import { z } from "zod";

import { checkAccountAccess, normalizeAccountNumber } from "../policy/identity";

import { defineTalaTool } from "./context";
import { formatLocalTime } from "./format-time";

export const checkAreaOutage = defineTalaTool({
  name: "check_area_outage",
  description:
    "Checks for ongoing outages in the service area (barangay) of the caller's account. " +
    "Use it when a verified caller reports no internet or slow internet, or asks about an " +
    "outage. It works only for the account verified on this call with verify_identity, and " +
    "refuses any other. Returns the service area, the time of the check, and a list of " +
    "outages, each with a reference, its cause, when it started and its estimated " +
    "restoration time, all in local time. An empty list means there is no outage in the " +
    "area. A null estimated_restoration means none has been given yet: say so, never guess.",
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
    const requested = normalizeAccountNumber(input.account_number);
    const access = checkAccountAccess(ctx.data.identity, requested);
    if (!access.allowed) throw new Error(refusal(access.reason));

    const { systems, company } = ctx.data;
    const account = await systems.accounts.findAccount(requested);
    // The gate passed, so this account was found when it was verified. Missing
    // now means the business system changed under the call: say so plainly.
    if (account === null) {
      throw new Error("the account verified on this call could not be found");
    }
    const outages = await systems.network.outagesAffecting(account.serviceArea.barangayId);

    return {
      service_area: `${account.serviceArea.barangayName}, ${account.serviceArea.city}`,
      checked_at: formatLocalTime(ctx.now, company),
      outages: outages.map((outage) => ({
        reference: outage.reference,
        cause: outage.cause,
        started: formatLocalTime(outage.startedAt, company),
        estimated_restoration:
          outage.estimatedRestorationAt === null
            ? null
            : formatLocalTime(outage.estimatedRestorationAt, company),
      })),
    };
  },
});

/** What the model reads when the account gate refuses: what happened, and what to do instead. */
function refusal(reason: "not_verified" | "other_account"): string {
  switch (reason) {
    case "not_verified":
      return (
        "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first."
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
