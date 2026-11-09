/**
 * What one model call cost: its usage, priced with its model's rate card. The
 * simulated caller's calls and the grader's call each carry one, and the
 * report adds them up beside Tala's spans.
 */
import {
  costOf,
  costOfTurn,
  type AssistantTurn,
  type LogicalModel,
  type Provider,
  type RateCard,
  type TokenUsage,
} from "@tala/core";

export interface PricedUsage {
  /** Null when the call failed before a response came back. */
  usage: TokenUsage | null;
  costNanos: number;
  /** True when priced from a rate card with no verified date. */
  estimated: boolean;
}

/**
 * A response's usage in core's shape, priced with one rate card. For a call
 * that cannot fall back, such as the grader's own non-streaming request.
 */
export function priceUsage(rates: RateCard, usage: AssistantTurn["usage"]): PricedUsage {
  const tokens: TokenUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
  const cost = costOf(rates, tokens);
  return { usage: tokens, costNanos: cost.totalNanos, estimated: cost.estimated };
}

/**
 * A model turn priced by the model(s) that served it, with core's rules
 * (`costOfTurn`), as Tala's own turns are: each attempt in `usage.iterations`
 * at its own model's card, an attempt that names no model at the requested
 * model's, and a model with no card at the ceiling.
 *
 * For a call made through the streaming creator, which asks for server-side
 * refusal fallback on Opus and Sonnet, so the top-level usage may cover only
 * the attempt that served.
 */
export function priceTurn(
  provider: Provider,
  requested: LogicalModel,
  reply: AssistantTurn,
): PricedUsage {
  const cost = costOfTurn(
    reply.usage,
    { requested: provider.modelId(requested), servedBy: reply.model ?? null },
    (modelId) => provider.rateCardForModelId(modelId),
  );
  return { usage: cost.usage, costNanos: cost.totalNanos, estimated: cost.estimated };
}
