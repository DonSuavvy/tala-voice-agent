/**
 * What Tala's tool handlers receive: the engine's `ToolContext`, filled with
 * one call's data and the support policy that call was pinned to.
 */
import type { z } from "zod";

import type { ToolContext, ToolDefinition } from "../agent/registry";
import type { IdentityState } from "../policy/identity";
import type { SupportPolicy } from "../policy/support-policy";
import type { BusinessSystems } from "../systems/types";

export interface CallData {
  systems: BusinessSystems;
  /** The call's identity state. Owned by the call session; verify_identity replaces it via recordVerification. */
  identity: IdentityState;
  company: { timeZone: string; locale: string };
}

export type TalaToolContext = ToolContext<CallData, SupportPolicy>;

/**
 * Returns the definition unchanged. It exists for inference: the handler's
 * `input` is typed from the tool's own schema, and the context is Tala's.
 */
export function defineTalaTool<T extends z.ZodObject>(
  definition: ToolDefinition<T, TalaToolContext>,
): ToolDefinition<T, TalaToolContext> {
  return definition;
}
