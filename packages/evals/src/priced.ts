/**
 * What one model call cost: its usage, priced with its model's rate card. The
 * simulated caller's calls and the grader's call each carry one, and the
 * report adds them up beside Tala's spans.
 */
import { costOf, type AssistantTurn, type RateCard, type TokenUsage } from "@tala/core";

export interface PricedUsage {
  /** Null when the call failed before a response came back. */
  usage: TokenUsage | null;
  costNanos: number;
  /** True when priced from a rate card with no verified date. */
  estimated: boolean;
}

/** A response's usage in core's shape, priced with the rate card of the model that answered. */
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
