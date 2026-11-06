/**
 * What Tala's tool handlers receive: the engine's `ToolContext`, filled with
 * one call's data and the support policy that call was pinned to.
 */
import type { z } from "zod";

import type { ToolContext, ToolDefinition } from "../agent/registry";
import type { HelpArticle } from "../pack/help-articles";
import type { Plan } from "../pack/plan-catalog";
import type { IdentityState } from "../policy/identity";
import type { SupportPolicy } from "../policy/support-policy";
import type { BusinessSystems } from "../systems/types";

export interface CallData {
  systems: BusinessSystems;
  /** The call's identity state. Owned by the call session; verify_identity replaces it via recordVerification. */
  identity: IdentityState;
  /** How times and money are spoken: the company's time zone, locale and ISO 4217 currency. */
  company: { timeZone: string; locale: string; currency: string };
  /** The company pack's plan catalog: the plans the SOP names, and what each costs a month. */
  plans: readonly Plan[];
  /** The company pack's help articles, in catalog order. They hold nothing about any account. */
  helpArticles: readonly HelpArticle[];
  /**
   * When the call started, from the session's clock. A ticket "opened on this
   * call" or a quote "made on this call" is one opened or made at or after
   * this, whatever else the business systems hold.
   */
  startedAt: Date;
  /**
   * Resolves after this many milliseconds, for a tool that has to wait, such
   * as a remote reboot waiting out the restart. The call session supplies it:
   * a real timer unless it is given another. Tests pass one that resolves at
   * once. Handlers wait only through this, never on a timer of their own.
   */
  wait: (ms: number) => Promise<void>;
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
