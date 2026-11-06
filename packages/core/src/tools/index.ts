/**
 * Tala's tools, as one registry.
 *
 * #5 registered `verify_identity`, `check_area_outage` and the terminal
 * `end_call`. #10 adds `get_account_overview`, `get_billing_history`,
 * `verify_payment`, `create_trouble_ticket` and `send_sms`. #11 adds
 * `run_line_diagnostics`, `remote_reboot_modem` and `get_technician_slots`.
 * Every tool but `verify_identity` and `end_call` sits behind the account
 * gate (`./account-gate`). Later tickets add theirs here.
 */
import { buildRegistry, type ToolRegistry } from "../agent/registry";

import { checkAreaOutage } from "./check-area-outage";
import type { TalaToolContext } from "./context";
import { createTroubleTicket } from "./create-trouble-ticket";
import { endCall } from "./end-call";
import { getAccountOverview } from "./get-account-overview";
import { getBillingHistory } from "./get-billing-history";
import { getTechnicianSlots } from "./get-technician-slots";
import { remoteRebootModem } from "./remote-reboot-modem";
import { runLineDiagnostics } from "./run-line-diagnostics";
import { sendSms } from "./send-sms";
import { verifyIdentity } from "./verify-identity";
import { verifyPayment } from "./verify-payment";

export type { CallData, TalaToolContext } from "./context";

export const TALA_TOOLS = [
  verifyIdentity,
  checkAreaOutage,
  getAccountOverview,
  getBillingHistory,
  verifyPayment,
  runLineDiagnostics,
  remoteRebootModem,
  getTechnicianSlots,
  createTroubleTicket,
  sendSms,
  endCall,
];

/** Validated at boot by the engine: a misconfigured tool fails here, every problem at once. */
export function buildTalaRegistry(): ToolRegistry<TalaToolContext> {
  return buildRegistry(TALA_TOOLS);
}
