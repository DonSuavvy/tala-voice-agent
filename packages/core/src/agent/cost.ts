/**
 * Cost accounting for agent runs.
 *
 * Answers *what did this call cost?*, and answers it in integers.
 *
 * **The unit is the nano-dollar.** The policy engine holds money in integer
 * minor units; this holds cost in integer nano-dollars (1e-9 USD) and converts
 * to micro-dollars only at the storage boundary. Nanos rather than micros
 * because cache multipliers land off the micro grid. In nanos every published
 * rate and every multiplier is exact, so a run's cost is the same number no
 * matter what order its spans were summed in — and a rate that is not exact is
 * refused rather than rounded.
 *
 * **1 nano-dollar per token == $1 per MTok.** A million tokens at 1000 nanos
 * each is 10^9 nanos, which is exactly one dollar, so the table below reads
 * straight off the pricing page.
 *
 * Imported from OpsPilot. Rates re-verified for the 5.5 models on 2026-11-06
 * against the live pricing page, which corrected two of OpsPilot's
 * assumptions: cache hits are 0.05x input on Opus 5.5 and Sonnet 5.5 (not
 * 0.1x everywhere), and Haiku 5.5 has a second rate card for long prompts.
 */

/**
 * The three models Tala runs. Named logically everywhere but `provider.ts`.
 * A refusal fallback can serve a turn on another model: a documented target
 * is priced at its card in `FALLBACK_TARGET_RATES`, any other model at
 * `UNKNOWN_MODEL_CEILING`.
 */
export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";

/** The models a refusal fallback documents as its targets. Never requested by Tala. */
export type FallbackTargetId = "claude-opus-5" | "claude-opus-4-8" | "claude-sonnet-5";

/** Which cache TTL a write was billed at. 5 minutes is the API default. */
export type CacheTtl = "5m" | "1h";

export interface ModelPricing {
  /** Uncached input, nano-dollars per token. Equals the $/MTok figure. */
  inputNanosPerToken: number;
  outputNanosPerToken: number;
  /** A cache hit: 0.1x input on most models, 0.05x on Opus and Sonnet 5.5. */
  cacheReadNanosPerToken: number;
  /** 1.25x input. The API default TTL. */
  cacheWrite5mNanosPerToken: number;
  /** 2x input. Cheaper per hour, dearer per write — needs more reads to pay off. */
  cacheWrite1hNanosPerToken: number;
}

/**
 * The prices a request pays when its prompt is longer than `overTokens`.
 * Haiku 5.5 has one; the prompt counts every input token, cache reads and
 * writes included, and every token class switches card, output too.
 */
export interface LongPromptPricing extends ModelPricing {
  overTokens: number;
}

/**
 * A price list plus the answer to "how do you know?".
 *
 * Provenance is part of the data. A rate card that cannot say where it came
 * from is a rate card whose output should not be presented as a fact, so
 * `verifiedOn: null` propagates into `CostBreakdown.estimated` and the number
 * is labelled rather than asserted. (OpsPilot needed this for Amazon Bedrock,
 * whose rates it could not verify. Every Tala card is verified.)
 */
export interface RateCard extends ModelPricing {
  /** ISO date these rates were confirmed, or `null` when unverified. */
  verifiedOn: string | null;
  /** Where they came from — a doc, a bill, a skill. Read by humans. */
  source: string;
  longPrompt?: LongPromptPricing;
}

export interface PricingOptions {
  /**
   * Cache hits cost input / this. 10 by default (0.1x); 20 on Opus and
   * Sonnet 5.5 (0.05x).
   */
  cacheReadDivisor?: number;
}

/** Dollars per MTok to whole nanos per token, or a RangeError. */
function toNanos(perMTok: number, what: string): number {
  const exact = perMTok * 1_000;
  const nanos = Math.round(exact);
  // Floating point turns $4.02 into 4019.9999999999995; that is still a whole
  // number of nanos. A price that is genuinely off the grid is refused.
  if (!Number.isSafeInteger(nanos) || nanos < 0 || Math.abs(exact - nanos) > 1e-6) {
    throw new RangeError(
      `cost: ${what} of $${perMTok}/MTok is not a whole number of nanos per token`,
    );
  }
  return nanos;
}

/** `numerator / divisor`, refusing a result off the integer grid. */
function exactly(numerator: number, divisor: number, what: string): number {
  const value = numerator / divisor;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `cost: ${what} lands on ${value} nanos per token, not a whole number`,
    );
  }
  return value;
}

/**
 * Derived rather than transcribed: every cache rate is a multiple of the input
 * rate, so writing them out by hand would create four more places for a typo
 * to hide. The multipliers are the part nobody quotes and therefore the part
 * most likely to be wrong, which is why the tests pin the results as literals
 * from the pricing page.
 */
export function pricing(
  inputPerMTok: number,
  outputPerMTok: number,
  options: PricingOptions = {},
): ModelPricing {
  const input = toNanos(inputPerMTok, "input");
  return {
    inputNanosPerToken: input,
    outputNanosPerToken: toNanos(outputPerMTok, "output"),
    cacheReadNanosPerToken: exactly(input, options.cacheReadDivisor ?? 10, "a cache read"),
    cacheWrite5mNanosPerToken: exactly(input * 5, 4, "a 5-minute cache write"),
    cacheWrite1hNanosPerToken: input * 2,
  };
}

export function rateCard(
  inputPerMTok: number,
  outputPerMTok: number,
  provenance: { verifiedOn: string | null; source: string },
  options: PricingOptions & {
    longPrompt?: { overTokens: number; inputPerMTok: number; outputPerMTok: number };
  } = {},
): RateCard {
  const { longPrompt, ...pricingOptions } = options;
  return {
    ...pricing(inputPerMTok, outputPerMTok, pricingOptions),
    ...provenance,
    ...(longPrompt
      ? {
          longPrompt: {
            overTokens: longPrompt.overTokens,
            ...pricing(longPrompt.inputPerMTok, longPrompt.outputPerMTok, pricingOptions),
          },
        }
      : {}),
  };
}

const ANTHROPIC_PROVENANCE = {
  verifiedOn: "2026-11-06",
  source:
    "platform.claude.com/docs/en/about-claude/pricing (model pricing table, " +
    "fetched 2026-11-06), cross-checked with the claude-api skill",
} as const;

/** First-party Anthropic API rates. */
export const ANTHROPIC_RATES: Readonly<Record<ModelId, RateCard>> = {
  "claude-haiku-5-5": rateCard(0.1, 0.5, ANTHROPIC_PROVENANCE, {
    longPrompt: { overTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  }),
  "claude-sonnet-5-5": rateCard(2, 10, ANTHROPIC_PROVENANCE, { cacheReadDivisor: 20 }),
  "claude-opus-5-5": rateCard(4, 20, ANTHROPIC_PROVENANCE, { cacheReadDivisor: 20 }),
};

const FALLBACK_TARGET_PROVENANCE = {
  verifiedOn: null,
  source:
    "the claude-api skill's model table (cached 2026-10-06), not checked against " +
    "the live pricing page; cache multiples assumed at OpsPilot's pre-5.5 ones " +
    "(writes 1.25x input, reads 0.1x, the higher read price)",
} as const;

/**
 * The models a refusal fallback documents as its targets: Opus 5.5 falls
 * back to Opus 5 or Opus 4.8, Sonnet 5.5 to Sonnet 5 (claude-api skill). A
 * turn one of them served bills at its rates, so it is priced at its card,
 * not at Tala's requested model's. Unverified, so a turn priced with one is
 * marked estimated; the cache-read price is the higher of the two Tala
 * knows, so an unchecked multiple does not under-count.
 */
export const FALLBACK_TARGET_RATES: Readonly<Record<FallbackTargetId, RateCard>> = {
  "claude-opus-5": rateCard(5, 25, FALLBACK_TARGET_PROVENANCE),
  "claude-opus-4-8": rateCard(5, 25, FALLBACK_TARGET_PROVENANCE),
  "claude-sonnet-5": rateCard(2, 10, FALLBACK_TARGET_PROVENANCE),
};

/**
 * What a model Tala has no card for is booked at: a ceiling, never a guess.
 *
 * A refusal fallback could serve a turn on a model that is neither one Tala
 * runs nor a documented target, and pricing it at a cheaper card Tala
 * happens to know would under-count, which the spend guard must never do
 * (ADR 4). So it is booked at the dearest card in the
 * claude-api skill's model table, Claude Fable 5.1's $10 in and $50 out,
 * with cache writes at the usual multiples of input and cache reads at the
 * full input price. `verifiedOn: null`: what it prices is an estimate.
 */
export const UNKNOWN_MODEL_CEILING: RateCard = rateCard(
  10,
  50,
  {
    verifiedOn: null,
    source:
      "ceiling for a model with no card of its own: Claude Fable 5.1's rates " +
      "from the claude-api skill's model table (cached 2026-10-06), cache " +
      "reads at the full input rate",
  },
  { cacheReadDivisor: 1 },
);

/**
 * The token counts from one API response.
 *
 * Field names mirror the SDK's `usage` object in camelCase. All four are
 * counts of *distinct* token classes — the API does not double-count a cached
 * token as input, so the total is a plain sum.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface CostBreakdown {
  inputNanos: number;
  outputNanos: number;
  cacheReadNanos: number;
  cacheWriteNanos: number;
  totalNanos: number;
  /**
   * True when the rate card had no `verifiedOn` date. The arithmetic is exact
   * either way — this says the *prices* are unconfirmed, so the figure is an
   * estimate. Callers must not present an estimated cost as measured, and the
   * spend guard charges it at a pessimistic multiple.
   */
  estimated: boolean;
  /** True when the prompt was long enough to be priced on the long-prompt card. */
  longPrompt: boolean;
}

/**
 * `usage` comes off the Anthropic SDK — external data. A NaN here would
 * produce a NaN cost, and one NaN turns every sum over the column into NaN:
 * the dashboard shows *nothing* rather than something visibly wrong, which is
 * the harder failure to notice. Throwing is the loud direction, and this is
 * programmer-facing data, not a user-facing decision.
 */
function tokenCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `cost: ${field} must be a non-negative safe integer, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Takes the rate card rather than a model name, so the provider owns pricing
 * and this module owns only arithmetic.
 */
export function costOf(
  rates: RateCard,
  usage: TokenUsage,
  options: { cacheTtl?: CacheTtl } = {},
): CostBreakdown {
  if (!rates) {
    throw new RangeError(
      "cost: no rate card supplied — a run must never be silently free",
    );
  }

  const inputTokens = tokenCount(usage.inputTokens, "inputTokens");
  const outputTokens = tokenCount(usage.outputTokens, "outputTokens");
  const cacheReadTokens = tokenCount(usage.cacheReadInputTokens, "cacheReadInputTokens");
  const cacheWriteTokens = tokenCount(
    usage.cacheCreationInputTokens,
    "cacheCreationInputTokens",
  );

  // The prompt is every input token, cached or not. Output does not count.
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const longPrompt =
    rates.longPrompt !== undefined && promptTokens > rates.longPrompt.overTokens;
  const card: ModelPricing = longPrompt ? rates.longPrompt! : rates;

  const cacheWriteRate =
    options.cacheTtl === "1h"
      ? card.cacheWrite1hNanosPerToken
      : card.cacheWrite5mNanosPerToken;

  const inputNanos = inputTokens * card.inputNanosPerToken;
  const outputNanos = outputTokens * card.outputNanosPerToken;
  const cacheReadNanos = cacheReadTokens * card.cacheReadNanosPerToken;
  const cacheWriteNanos = cacheWriteTokens * cacheWriteRate;

  return {
    inputNanos,
    outputNanos,
    cacheReadNanos,
    cacheWriteNanos,
    totalNanos: inputNanos + outputNanos + cacheReadNanos + cacheWriteNanos,
    estimated: rates.verifiedOn === null,
    longPrompt,
  };
}

/** One attempt's usage, as a response's `usage.iterations` reports it. */
export interface AttemptUsage {
  /**
   * `fallback_message` for a fallback model's attempt that served the turn;
   * `message` for any other attempt: one that declined, or, on a turn no
   * refusal fallback served, the one that served.
   */
  type: string;
  /**
   * The model that ran the attempt. An ordinary Sonnet 5.5 turn with
   * `fallbacks` on came back with exactly one `message` entry whose model
   * was null, and it was the model the request named (live, 2026-11-06,
   * #35). `costOfTurn` says what is assumed for other unnamed entries.
   */
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** A response's `usage`, wire-shaped, as the SDK hands it over. */
export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /**
   * One entry per attempt when more than one model may have run, as with
   * server-side refusal fallback. When present, it is the source of truth:
   * the top-level counts cover only the attempt that produced the message.
   */
  iterations?: AttemptUsage[] | null;
}

/** A turn's cost, and the token counts it was priced from. */
export interface TurnCost extends CostBreakdown {
  /** Summed over every attempt, so the counts match the cost. */
  usage: TokenUsage;
}

function tokenUsageOf(usage: Omit<AttemptUsage, "type" | "model">): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** The two models a turn's price can depend on, by wire id. */
export interface TurnModels {
  /** The model the request named. */
  requested: string;
  /** The response's `model`: who produced the message. Null when it has none. */
  servedBy: string | null;
}

/**
 * Maps a wire id to its card: the provider's `rateCardForModelId`. `null`
 * asks for a model the turn does not name, and like any model with no card
 * it gets the ceiling. That decision is the provider's, made in one place.
 */
export type RateCardFor = (modelId: string | null) => RateCard;

/**
 * The model the attempt at `index` in `usage.iterations` is priced as.
 *
 * A named attempt is priced as its own model.
 *
 * An unnamed attempt is the hard case. Observed live (#35): an ordinary
 * turn with `fallbacks` on has exactly one `message` attempt, with `model:
 * null`, and it is the requested model's. Assumed, not observed: in a turn
 * a refusal fallback served, the first attempt is still the requested
 * model's, because the API runs it first, whatever `servedBy` names. So an
 * unnamed `message` attempt first in the list is priced as the requested
 * model. Any other unnamed attempt, a later hop or a `fallback_message`,
 * could be any model, so it is priced as no model in particular (`null`):
 * the ceiling, rather than a card that might be too cheap.
 */
function attemptModel(attempt: AttemptUsage, index: number, requested: string): string | null {
  if (attempt.model != null) return attempt.model;
  return attempt.type === "message" && index === 0 ? requested : null;
}

/**
 * Price one model turn by the model(s) that served it, not the one requested.
 *
 * With `usage.iterations`, each attempt is priced at its own model's card
 * and the results summed: an attempt that declined mid-stream bills at
 * normal rates and a fallback model's attempt at its own (claude-api skill,
 * refusal section, "Billing"). Without them, or with an empty list, the turn
 * is priced at `servedBy`, the response's `model`, or at the requested
 * model when the turn names none.
 *
 * `rateCardFor` is the provider's (`RateCardFor`): which card a model gets,
 * the ceiling included, is decided there. This module owns only arithmetic.
 */
export function costOfTurn(
  usage: TurnUsage,
  models: TurnModels,
  rateCardFor: RateCardFor,
  options: { cacheTtl?: CacheTtl } = {},
): TurnCost {
  const attempts =
    usage.iterations && usage.iterations.length > 0
      ? usage.iterations.map((a, index) => ({
          rates: rateCardFor(attemptModel(a, index, models.requested)),
          tokens: tokenUsageOf(a),
        }))
      : [{ rates: rateCardFor(models.servedBy ?? models.requested), tokens: tokenUsageOf(usage) }];

  const total: TurnCost = {
    inputNanos: 0,
    outputNanos: 0,
    cacheReadNanos: 0,
    cacheWriteNanos: 0,
    totalNanos: 0,
    estimated: false,
    longPrompt: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
  for (const { rates, tokens } of attempts) {
    const cost = costOf(rates, tokens, options);
    total.inputNanos += cost.inputNanos;
    total.outputNanos += cost.outputNanos;
    total.cacheReadNanos += cost.cacheReadNanos;
    total.cacheWriteNanos += cost.cacheWriteNanos;
    total.totalNanos += cost.totalNanos;
    total.estimated ||= cost.estimated;
    total.longPrompt ||= cost.longPrompt;
    total.usage.inputTokens += tokens.inputTokens;
    total.usage.outputTokens += tokens.outputTokens;
    total.usage.cacheCreationInputTokens += tokens.cacheCreationInputTokens;
    total.usage.cacheReadInputTokens += tokens.cacheReadInputTokens;
  }
  return total;
}

/**
 * Convert to the storage unit, micro-dollars (six decimal places).
 *
 * Half-up, and stated here rather than left to `toFixed`, because it runs on
 * every span and a reader should be able to reproduce the figure by hand. Note
 * the floor at 1: a real but sub-micro cost rounds *up* to the smallest
 * representable amount rather than to zero, so a cheap span is never recorded
 * as free.
 */
export function nanosToMicros(nanos: number): number {
  if (!Number.isSafeInteger(nanos) || nanos < 0) {
    throw new TypeError(
      `cost: nanos must be a non-negative safe integer, got ${String(nanos)}`,
    );
  }
  if (nanos === 0) return 0;
  return Math.max(1, Math.round(nanos / 1_000));
}

/** Format micro-dollars for a `numeric(12,6)` column. */
export function microsToUsdString(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}
