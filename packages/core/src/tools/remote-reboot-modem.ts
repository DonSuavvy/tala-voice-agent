/**
 * `remote_reboot_modem`: restart the verified caller's modem remotely, wait
 * the restart out, and check the connection again.
 *
 * One tool does all three, so every restart is followed by its re-check: the
 * re-check cannot be skipped (DESIGN section 6: "remote reboot, then a
 * re-check"). How long the restart takes and how the modem reads afterwards
 * are the network system's; the wait is the call session's (`CallData.wait`),
 * and the time is the context's `now`, so the handler never reads a clock. A
 * reboot already running when the caller talks finishes (ADR 4), so its
 * re-check is never lost.
 */
import { z } from "zod";

import { SECOND_MS } from "../systems/time-units";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { diagnosisOf, spokenDiagnosis } from "./diagnosis";

export const remoteRebootModem = defineTalaTool({
  name: "remote_reboot_modem",
  description:
    "Restarts the modem at the caller's home remotely, waits until the restart is over, then " +
    "checks the connection again. The caller's internet drops while the modem restarts. Use " +
    "it only after the caller agrees to the restart. It works only for the account verified " +
    "on this call with verify_identity, and refuses any other. It refuses, restarting " +
    "nothing, unless the latest check of the connection suggests a reboot (reboot_may_clear), " +
    "so it refuses a second restart on the call. Returns rebooted true, " +
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
    // The SOP offers a restart only when the check suggests one; this makes
    // sure. The check after a restart suggests none, so it is never repeated.
    const latest = await diagnosisOf(systems, account.accountNumber);
    if (!latest.rebootMayClear) {
      throw new Error(
        "Refused: the latest check of this connection does not suggest a remote reboot, so the " +
          "modem was not restarted. If the problem remains, open a connection ticket with " +
          "create_trouble_ticket.",
      );
    }
    // The modem was there a moment ago; missing now, or after the restart,
    // means the network system changed under the call.
    const reboot = await systems.network.rebootModem(account.accountNumber, ctx.now);
    if (reboot === null) {
      throw new Error("the modem could not be restarted");
    }
    await wait(reboot.restartSeconds * SECOND_MS);
    const recheck = await systems.network.diagnose(account.accountNumber);
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
