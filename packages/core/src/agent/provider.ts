/**
 * The provider adapter: the only module that knows which Claude Tala talks to.
 *
 * Tala uses the **first-party Anthropic API only**. OpsPilot also ran on
 * Amazon Bedrock, through an AWS account shared with a live production
 * workload; that path is deliberately not imported, so there is no code here
 * that could reach it (CLAUDE.md: "never point it at the covara Bedrock
 * account").
 *
 * Two things live here and nowhere else:
 *
 * **Model identity.** Everything else in the codebase names models logically
 * (`haiku`, `sonnet`, `opus`), so a model upgrade is a change to one table.
 *
 * **The rate card.** Pricing is looked up through the provider, so cost
 * accounting owns only arithmetic (`cost.ts`).
 */
import Anthropic from "@anthropic-ai/sdk";

import { ANTHROPIC_RATES, type ModelId, type RateCard } from "./cost";

export type ProviderId = "anthropic";

/**
 * How the rest of the codebase names models. Deliberately not the wire id —
 * a logical name survives a model upgrade.
 */
export type LogicalModel = "haiku" | "sonnet" | "opus";

const FIRST_PARTY_ID: Readonly<Record<LogicalModel, ModelId>> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};

export interface Provider {
  id: ProviderId;
  /** The id the API expects for a logical model. */
  modelId(model: LogicalModel): string;
  rateCard(model: LogicalModel): RateCard;
}

/**
 * `Object.hasOwn`, not a plain lookup, so a name like `toString` coming in
 * from config is refused instead of resolving to Object.prototype's method.
 */
function requireMapping(model: LogicalModel): ModelId {
  if (!Object.hasOwn(FIRST_PARTY_ID, model)) {
    throw new RangeError(
      `provider: no mapping for model "${String(model)}" — add one rather ` +
        `than falling back, so an unknown model cannot reach the wire`,
    );
  }
  return FIRST_PARTY_ID[model];
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  modelId: (model) => requireMapping(model),
  rateCard: (model) => ANTHROPIC_RATES[requireMapping(model)],
};

/**
 * Choose the provider from the environment. There is one, so this only
 * checks that it is configured, and says which variable is missing if not.
 * AWS credentials in the environment are ignored: nothing here reads them.
 */
export function providerFromEnv(
  env: Record<string, string | undefined>,
): Provider {
  if ((env.ANTHROPIC_API_KEY ?? "").length > 0) return anthropicProvider;

  throw new Error(
    "provider: no provider configured — set ANTHROPIC_API_KEY " +
      "(Tala uses the first-party Anthropic API only)",
  );
}

export interface ClientTuning {
  /**
   * How many times the SDK retries a 429 or 5xx before giving up. The SDK's
   * own default is 2, with exponential backoff that honours `retry-after`.
   *
   * Raised only by callers that issue a *burst*, such as an eval suite. In
   * OpsPilot, eight back-to-back eval runs (about 25 calls in 40 seconds)
   * exhausted the default and lost the last three cases to 429s; more backoff
   * was the correct response. A live call has no burst and keeps the default.
   */
  maxRetries?: number;
}

/**
 * Build the SDK client.
 *
 * Separate from `providerFromEnv` so provider *selection* stays pure and
 * testable, while client construction, which reads credentials, is an
 * explicit, separate act.
 */
export function createClient(
  env: Record<string, string | undefined>,
  tuning: ClientTuning = {},
): Anthropic {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("provider: the Anthropic client needs ANTHROPIC_API_KEY");
  }
  return new Anthropic({
    apiKey,
    ...(tuning.maxRetries === undefined ? {} : { maxRetries: tuning.maxRetries }),
  });
}
