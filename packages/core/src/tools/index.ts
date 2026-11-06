/**
 * Tala's tools, as one registry.
 *
 * #5 registers three: `verify_identity`, `check_area_outage` and the terminal
 * `end_call`. Later tickets add theirs here.
 */
import { buildRegistry, type ToolRegistry } from "../agent/registry";

import { checkAreaOutage } from "./check-area-outage";
import type { TalaToolContext } from "./context";
import { endCall } from "./end-call";
import { verifyIdentity } from "./verify-identity";

export type { CallData, TalaToolContext } from "./context";

export const TALA_TOOLS = [verifyIdentity, checkAreaOutage, endCall];

/** Validated at boot by the engine: a misconfigured tool fails here, every problem at once. */
export function buildTalaRegistry(): ToolRegistry<TalaToolContext> {
  return buildRegistry(TALA_TOOLS);
}
