/**
 * A diagnosis of the verified account's connection, as the line tools read it
 * and say it. `run_line_diagnostics` gives it as found; `remote_reboot_modem`
 * checks it before a restart and gives the re-check in the same form.
 */
import type { BusinessSystems, Diagnosis } from "../systems/types";

import type { CallData } from "./context";
import { formatLocalTime } from "./format-time";

/**
 * The network's diagnosis of this account's connection, or a plain error when
 * no modem is on record.
 */
export async function diagnosisOf(
  systems: BusinessSystems,
  accountNumber: string,
): Promise<Diagnosis> {
  const diagnosis = await systems.network.diagnose(accountNumber);
  if (diagnosis === null) {
    throw new Error("no modem is on record for the account verified on this call");
  }
  return diagnosis;
}

/** A diagnosis as the model reads it, with its time in the company's own words. */
export function spokenDiagnosis(diagnosis: Diagnosis, company: CallData["company"]) {
  return {
    modem_status: diagnosis.modemStatus,
    received_power_dbm: diagnosis.receivedPowerDbm,
    last_seen: formatLocalTime(diagnosis.lastSeenAt, company),
    fault: diagnosis.fault,
    reboot_may_clear: diagnosis.rebootMayClear,
  };
}
