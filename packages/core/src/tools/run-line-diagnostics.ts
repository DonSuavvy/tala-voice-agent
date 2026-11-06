/**
 * `run_line_diagnostics`: what the network sees of the connection at the
 * verified caller's home.
 *
 * The finding is the network system's own (`NetworkOperations.diagnose`): the
 * modem's status, its signal, when it was last seen, any fault and whether a
 * remote reboot may clear it. This tool says it as it was found; no code here
 * turns a signal level into a verdict.
 */
import { z } from "zod";

import type { Diagnosis } from "../systems/types";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool, type CallData } from "./context";
import { formatLocalTime } from "./format-time";

/** A diagnosis as the model reads it, with its time in the company's own words. */
function spokenDiagnosis(diagnosis: Diagnosis, company: CallData["company"]) {
  return {
    modem_status: diagnosis.modemStatus,
    received_power_dbm: diagnosis.receivedPowerDbm,
    last_seen: formatLocalTime(diagnosis.lastSeenAt, company),
    fault: diagnosis.fault,
    reboot_may_clear: diagnosis.rebootMayClear,
  };
}

export const runLineDiagnostics = defineTalaTool({
  name: "run_line_diagnostics",
  description:
    "Runs the network's check of the connection at the caller's home: the modem's status " +
    "(online, degraded or offline), the optical power it receives in dBm, when the network " +
    "last heard from it, and the fault the system found, in plain words. Use it when a " +
    "verified caller reports slow or no internet and there is no outage in their area. It " +
    "works only for the account verified on this call with verify_identity, and refuses any " +
    "other. A null fault means the system found none. reboot_may_clear says whether the " +
    "system suggests a remote reboot with remote_reboot_modem.",
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
    const diagnosis = await systems.network.diagnose(account.accountNumber);
    if (diagnosis === null) {
      throw new Error("no modem is on record for the account verified on this call");
    }
    return {
      checked_at: formatLocalTime(ctx.now, company),
      ...spokenDiagnosis(diagnosis, company),
    };
  },
});
