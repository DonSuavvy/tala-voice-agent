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
 * accounting owns only arithmetic (`cost.ts`). That includes the way back,
 * from the wire id a response names to its card.
 *
 * **Server-side refusal fallback.** Which models ask for it, and the request
 * fields that do, are decided here too, by wire id.
 */
import Anthropic from "@anthropic-ai/sdk";

import {
  ANTHROPIC_RATES,
  FALLBACK_TARGET_RATES,
  UNKNOWN_MODEL_CEILING,
  type FallbackTargetId,
  type ModelId,
  type RateCard,
} from "./cost";

export type ProviderId = "anthropic";

/**
 * How the rest of the codebase names models. Deliberately not the wire id —
 * a logical name survives a model upgrade.
 */
export type LogicalModel = "haiku" | "sonnet" | "opus";

const FIRST_PARTY_ID: Readonly<Record<LogicalModel, ModelId>> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** The logical model a wire id names, or null for an id Tala has no mapping for. */
function logicalModelOf(modelId: string): LogicalModel | null {
  for (const model of Object.keys(FIRST_PARTY_ID) as LogicalModel[]) {
    if (FIRST_PARTY_ID[model] === modelId) return model;
  }
  return null;
}

/**
 * Which models ask for server-side refusal fallback. When a safety classifier
 * declines a turn, the API re-runs it on a fallback model inside the same
 * call, so a false positive does not cost the caller the call.
 *
 * Haiku 5.5 has none: with `fallbacks: "default"` a declined request stays
 * declined, so its requests do not send it (claude-api skill, Migrating to
 * Claude Haiku 5.5).
 */
const SERVER_SIDE_FALLBACK: Readonly<Record<LogicalModel, boolean>> = {
  haiku: false,
  sonnet: true,
  opus: true,
};

/** The request fields that opt one request into server-side refusal fallback. */
export interface RefusalFallbackOptIn {
  /** Sent as the `anthropic-beta` header. */
  betas: ["server-side-fallback-2026-07-01"];
  fallbacks: "default";
}

/**
 * The opt-in for a request to `modelId`, or null when that model does not
 * take one.
 *
 * `"default"` rather than a list of named models: the API routes by refusal
 * category, so there is no fallback model list to keep current, and Sonnet
 * 5.5 accepts only this form. The scalar form takes the `-2026-07-01` beta;
 * the list form's `-2026-06-01` header 400s with it.
 */
export function refusalFallbackFor(modelId: string): RefusalFallbackOptIn | null {
  const model = logicalModelOf(modelId);
  if (model === null || !SERVER_SIDE_FALLBACK[model]) return null;
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

export interface Provider {
  id: ProviderId;
  /** The id the API expects for a logical model. */
  modelId(model: LogicalModel): string;
  rateCard(model: LogicalModel): RateCard;
  /**
   * The card for the model a response says served it, by wire id: the way
   * back from `modelId`. With a refusal fallback that need not be the model
   * requested: a documented fallback target gets its own card. A model with
   * no card here, or a missing id, gets `UNKNOWN_MODEL_CEILING`, so a turn
   * is never priced below what it cost.
   */
  rateCardForModelId(modelId: string | null): RateCard;
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
  rateCardForModelId: (modelId) => {
    if (modelId === null) return UNKNOWN_MODEL_CEILING;
    const model = logicalModelOf(modelId);
    if (model !== null) return ANTHROPIC_RATES[FIRST_PARTY_ID[model]];
    // A refusal fallback's documented targets: wire ids a response can name,
    // never logical models Tala requests.
    if (Object.hasOwn(FALLBACK_TARGET_RATES, modelId)) {
      return FALLBACK_TARGET_RATES[modelId as FallbackTargetId];
    }
    return UNKNOWN_MODEL_CEILING;
  },
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
