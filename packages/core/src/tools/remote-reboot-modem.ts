/**
 * `remote_reboot_modem`: restart the verified caller's modem remotely, wait
 * the restart out, and check the connection again.
 *
 * One call does all three, so the model never reports a re-check it did not
 * make (DESIGN section 6: "remote reboot, then a re-check"). How long the
 * restart takes and how the modem reads afterwards are the network system's;
 * the wait is the call session's (`CallData.wait`), and the time is the
 * context's `now`, so the handler never reads a clock. A reboot already
 * running when the caller talks finishes (ADR 4), so its re-check is never
 * lost.
 */
import { z } from "zod";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { spokenDiagnosis } from "./run-line-diagnostics";

const SECOND_MS = 1_000;

export const remoteRebootModem = defineTalaTool({
  name: "remote_reboot_modem",
  description:
    "Restarts the modem at the caller's home remotely, waits until the restart is over, then " +
    "checks the connection again. The caller's internet drops while the modem restarts. Use " +
    "it only after the caller agrees to the restart. It works only for the account verified " +
    "on this call with verify_identity, and refuses any other. Returns rebooted true, " +
    "waited_seconds (how long the restart took), and the re-check in the same form as " +
    "run_line_diagnostics: the modem's status, the optical power it receives in dBm, when the " +
    "network last heard from it, and the fault the system still finds, or null if none.",
  input: z
    .object({
      account_number: accountNumberInput,
    })
    .strict(),
  safetyClass: "auto_write",
  idempotent: false,
  handler: async (input, ctx) => {
    const account = await requireVerifiedAccount(ctx, input.account_number);
    const { systems, company, wait } = ctx.data;
    const reboot = await systems.network.rebootModem(account.accountNumber, ctx.now);
    if (reboot === null) {
      throw new Error("no modem is on record for the account verified on this call");
    }
    await wait(reboot.restartSeconds * SECOND_MS);
    const recheck = await systems.network.diagnose(account.accountNumber);
    // The modem was there a moment ago; missing now means the network system
    // changed under the call.
    if (recheck === null) {
      throw new Error("the modem was restarted but could not be checked again");
    }
    return {
      rebooted: true,
      waited_seconds: reboot.restartSeconds,
      ...spokenDiagnosis(recheck, company),
    };
  },
});
