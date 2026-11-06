import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_RATES,
  costOf,
  nanosToMicros,
  rateCard,
  type ModelPricing,
  type RateCard,
  type TokenUsage,
} from "./cost";

/**
 * Cost accounting is on CLAUDE.md's test-first list: it is pure, it is
 * arithmetic about money, and it feeds the per-call cost Tala reports and the
 * spend guard that stops the public demo at $2 a day.
 *
 * Decisions this suite pins:
 *
 * **Money is never a float.** Cost is held in integer **nano-dollars** and
 * converted to micro-dollars only at the storage boundary. Nanos rather than
 * micros because cache multipliers land off the micro grid. In nanos every
 * published price and multiplier is exact, and a rate that is not is refused.
 *
 * **1 nano-dollar per token == $1 per MTok.** A million tokens at 1000 nanos
 * each is 10^9 nanos, exactly $1, so the table reads straight off the pricing
 * page.
 *
 * **Every figure is a literal from the pricing page**, fetched 2026-11-06
 * (platform.claude.com/docs/en/about-claude/pricing, "Model pricing"), not a
 * multiple computed in the test. Two of OpsPilot's assumptions did not survive
 * that page: cache hits on Opus 5.5 and Sonnet 5.5 cost 0.05x input, not 0.1x,
 * and Haiku 5.5 has a second, higher rate card for prompts over 100,000 tokens.
 */

/** Per-token prices in nanos, transcribed from the pricing page's table. */
const PUBLISHED: Record<string, ModelPricing> = {
  // $4 in · $5 5m write · $8 1h write · $0.20 cache hit · $20 out
  "claude-opus-5-5": {
    inputNanosPerToken: 4_000,
    outputNanosPerToken: 20_000,
    cacheReadNanosPerToken: 200,
    cacheWrite5mNanosPerToken: 5_000,
    cacheWrite1hNanosPerToken: 8_000,
  },
  // $2 in · $2.50 5m write · $4 1h write · $0.10 cache hit · $10 out
  "claude-sonnet-5-5": {
    inputNanosPerToken: 2_000,
    outputNanosPerToken: 10_000,
    cacheReadNanosPerToken: 100,
    cacheWrite5mNanosPerToken: 2_500,
    cacheWrite1hNanosPerToken: 4_000,
  },
  // Prompts up to 100,000 tokens:
  // $0.10 in · $0.125 5m write · $0.20 1h write · $0.01 cache hit · $0.50 out
  "claude-haiku-5-5": {
    inputNanosPerToken: 100,
    outputNanosPerToken: 500,
    cacheReadNanosPerToken: 10,
    cacheWrite5mNanosPerToken: 125,
    cacheWrite1hNanosPerToken: 200,
  },
};

/** Haiku 5.5, prompts over 100,000 tokens: $0.50 · $0.625 · $1 · $0.05 · $2.50. */
const HAIKU_LONG: ModelPricing = {
  inputNanosPerToken: 500,
  outputNanosPerToken: 2_500,
  cacheReadNanosPerToken: 50,
  cacheWrite5mNanosPerToken: 625,
  cacheWrite1hNanosPerToken: 1_000,
};

const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;

function pricingOf(card: ModelPricing): ModelPricing {
  return {
    inputNanosPerToken: card.inputNanosPerToken,
    outputNanosPerToken: card.outputNanosPerToken,
    cacheReadNanosPerToken: card.cacheReadNanosPerToken,
    cacheWrite5mNanosPerToken: card.cacheWrite5mNanosPerToken,
    cacheWrite1hNanosPerToken: card.cacheWrite1hNanosPerToken,
  };
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...over,
  };
}

/** A $1/$5 card, for the arithmetic identities. Not a real model. */
const ONE_DOLLAR = rateCard(1, 5, { verifiedOn: "2026-11-06", source: "test fixture" });

describe("ANTHROPIC_RATES", () => {
  it("prices the three 5.5 models Tala runs", () => {
    expect(Object.keys(ANTHROPIC_RATES).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
  });

  it.each(MODELS)("%s carries the published prices, every column", (model) => {
    expect(pricingOf(ANTHROPIC_RATES[model])).toEqual(PUBLISHED[model]);
  });

  /**
   * The multiplier nobody quotes, and the one OpsPilot had hard-coded: cache
   * hits were a tenth of input on every model it ran. Not on these two.
   */
  it.each(["claude-opus-5-5", "claude-sonnet-5-5"] as const)(
    "%s prices a cache hit at a twentieth of input",
    (model) => {
      const card = ANTHROPIC_RATES[model];
      expect(card.cacheReadNanosPerToken * 20).toBe(card.inputNanosPerToken);
    },
  );

  it("prices a Haiku 5.5 cache hit at a tenth of input", () => {
    const card = ANTHROPIC_RATES["claude-haiku-5-5"];
    expect(card.cacheReadNanosPerToken * 10).toBe(card.inputNanosPerToken);
  });

  it("gives Haiku 5.5 a second card for prompts over 100,000 tokens", () => {
    const long = ANTHROPIC_RATES["claude-haiku-5-5"].longPrompt;
    expect(long?.overTokens).toBe(100_000);
    expect(long && pricingOf(long)).toEqual(HAIKU_LONG);
  });

  it.each(["claude-opus-5-5", "claude-sonnet-5-5"] as const)(
    "%s has one price at any prompt length",
    (model) => {
      expect(ANTHROPIC_RATES[model].longPrompt).toBeUndefined();
    },
  );

  /** No float anywhere, including the long-prompt card. */
  it.each(MODELS)("%s lands every rate on the integer nano grid", (model) => {
    const card = ANTHROPIC_RATES[model];
    for (const pricing of [card, card.longPrompt].filter(Boolean)) {
      for (const [k, v] of Object.entries(pricing!)) {
        if (typeof v === "number") {
          expect(Number.isSafeInteger(v), `${k} must be a safe integer`).toBe(true);
        }
      }
    }
  });

  /**
   * Provenance is data, not a comment. `verifiedOn` is what makes a cost an
   * assertion rather than an estimate.
   */
  it.each(MODELS)("%s records when and where its rates were verified", (model) => {
    expect(ANTHROPIC_RATES[model].verifiedOn).toBe("2026-11-06");
    expect(ANTHROPIC_RATES[model].source).toMatch(/pricing/i);
    expect(ANTHROPIC_RATES[model].source).toMatch(/claude-api skill/i);
  });

  it("prices a first-party run as measured, not estimated", () => {
    expect(
      costOf(ANTHROPIC_RATES["claude-haiku-5-5"], usage({ inputTokens: 1 })).estimated,
    ).toBe(false);
  });

  /**
   * The complement, and the reason `estimated` exists: a card with no
   * `verifiedOn` (OpsPilot's Bedrock card was one) taints every figure derived
   * from it.
   */
  it("flags a run priced with an unverified card as an estimate", () => {
    const unverified: RateCard = {
      ...ANTHROPIC_RATES["claude-haiku-5-5"],
      verifiedOn: null,
      source: "UNVERIFIED placeholder",
    };

    expect(costOf(unverified, usage({ inputTokens: 1 })).estimated).toBe(true);
  });
});

describe("rateCard", () => {
  it("derives OpsPilot's multipliers by default: 0.1x hit, 1.25x 5m write, 2x 1h write", () => {
    expect(pricingOf(ONE_DOLLAR)).toEqual({
      inputNanosPerToken: 1_000,
      outputNanosPerToken: 5_000,
      cacheReadNanosPerToken: 100,
      cacheWrite5mNanosPerToken: 1_250,
      cacheWrite1hNanosPerToken: 2_000,
    });
  });

  it("takes a different cache-hit divisor", () => {
    const card = rateCard(4, 20, { verifiedOn: null, source: "test" }, { cacheReadDivisor: 20 });
    expect(card.cacheReadNanosPerToken).toBe(200);
  });

  /** $4.02 is 4019.9999999999995 nanos in floating point; it must come out 4020. */
  it("lands a rate exactly despite floating-point input", () => {
    expect(rateCard(4.02, 20, { verifiedOn: null, source: "test" }).inputNanosPerToken).toBe(4_020);
  });

  /** Money is never a float: a price off the nano grid is refused, not rounded. */
  it("refuses a price that is not a whole number of nanos per token", () => {
    expect(() => rateCard(0.0001, 1, { verifiedOn: null, source: "test" })).toThrow(RangeError);
  });

  it("refuses a cache rate that would land off the nano grid", () => {
    expect(() =>
      rateCard(0.003, 1, { verifiedOn: null, source: "test" }, { cacheReadDivisor: 20 }),
    ).toThrow(RangeError);
  });
});

describe("costOf", () => {
  it("charges nothing for a run that used nothing", () => {
    expect(costOf(ANTHROPIC_RATES["claude-haiku-5-5"], usage()).totalNanos).toBe(0);
  });

  /**
   * The identity the whole table rests on: a million input tokens at $1/MTok
   * costs exactly one dollar — 10^9 nanos — with no rounding applied.
   */
  it("charges exactly $1.00 for 1M input tokens at $1/MTok", () => {
    const c = costOf(ONE_DOLLAR, usage({ inputTokens: 1_000_000 }));
    expect(c.inputNanos).toBe(1_000_000_000);
    expect(c.totalNanos).toBe(1_000_000_000);
  });

  it("charges each token class at its own rate and sums them", () => {
    const c = costOf(
      ANTHROPIC_RATES["claude-opus-5-5"],
      usage({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 2_000,
      }),
    );

    expect(c.inputNanos).toBe(1_000 * 4_000);
    expect(c.outputNanos).toBe(500 * 20_000);
    expect(c.cacheReadNanos).toBe(10_000 * 200);
    expect(c.cacheWriteNanos).toBe(2_000 * 5_000);
    expect(c.totalNanos).toBe(c.inputNanos + c.outputNanos + c.cacheReadNanos + c.cacheWriteNanos);
  });

  /**
   * The saving a cache badge would report. On Sonnet 5.5 a cache hit is a
   * twentieth of the uncached price; if this inverted, the badge would
   * advertise a saving that isn't there.
   */
  it("makes a Sonnet 5.5 cache read exactly a twentieth of an uncached token", () => {
    const cached = costOf(ANTHROPIC_RATES["claude-sonnet-5-5"], usage({ cacheReadInputTokens: 10_000 }));
    const uncached = costOf(ANTHROPIC_RATES["claude-sonnet-5-5"], usage({ inputTokens: 10_000 }));

    expect(cached.totalNanos * 20).toBe(uncached.totalNanos);
  });

  it("charges a 1-hour cache write more than a 5-minute one", () => {
    const sonnet = ANTHROPIC_RATES["claude-sonnet-5-5"];
    const short = costOf(sonnet, usage({ cacheCreationInputTokens: 1_000 }));
    const long = costOf(sonnet, usage({ cacheCreationInputTokens: 1_000 }), { cacheTtl: "1h" });

    expect(short.cacheWriteNanos).toBe(1_000 * 2_500);
    expect(long.cacheWriteNanos).toBe(1_000 * 4_000);
  });

  /**
   * Integer arithmetic exists so that summing spans is exact. In floats,
   * accumulating a fraction of a cent ten thousand times drifts.
   */
  it("sums ten thousand spans without drift", () => {
    const one = costOf(ANTHROPIC_RATES["claude-haiku-5-5"], usage({ outputTokens: 3 }));
    let total = 0;
    for (let i = 0; i < 10_000; i++) total += one.totalNanos;

    expect(total).toBe(10_000 * 3 * 500);
    expect(Number.isSafeInteger(total)).toBe(true);
  });

  /**
   * `usage` arrives from the Anthropic SDK, which is external data. A NaN
   * token count must not silently produce a NaN cost that then poisons every
   * sum over it.
   */
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s token count rather than costing it", (_label, value) => {
    expect(() => costOf(ANTHROPIC_RATES["claude-haiku-5-5"], usage({ inputTokens: value }))).toThrow();
  });

  /** A run must never be silently free because a lookup returned undefined. */
  it("rejects a missing rate card rather than costing a run at zero", () => {
    expect(() => costOf(undefined as unknown as RateCard, usage({ inputTokens: 1 }))).toThrow(
      /rate card/i,
    );
  });
});

/**
 * Haiku 5.5 is priced by prompt length. From the pricing page's "Long context
 * pricing": a request whose prompt is over 100,000 tokens pays the higher
 * prices; the prompt length counts all input tokens, including cache reads and
 * cache writes; and each request is priced on its own.
 */
describe("costOf — Haiku 5.5's long-prompt card", () => {
  const haiku = ANTHROPIC_RATES["claude-haiku-5-5"];

  it("prices a prompt of exactly 100,000 tokens on the base card", () => {
    const c = costOf(haiku, usage({ inputTokens: 100_000, outputTokens: 1_000 }));

    expect(c.longPrompt).toBe(false);
    expect(c.totalNanos).toBe(100_000 * 100 + 1_000 * 500);
  });

  it("prices one token more on the higher card, output included", () => {
    const c = costOf(haiku, usage({ inputTokens: 100_001, outputTokens: 1_000 }));

    expect(c.longPrompt).toBe(true);
    expect(c.inputNanos).toBe(100_001 * 500);
    expect(c.outputNanos).toBe(1_000 * 2_500);
  });

  it("counts cache reads and cache writes toward the threshold", () => {
    const c = costOf(
      haiku,
      usage({ inputTokens: 1_000, cacheReadInputTokens: 90_000, cacheCreationInputTokens: 9_001 }),
    );

    expect(c.longPrompt).toBe(true);
    expect(c.totalNanos).toBe(1_000 * 500 + 90_000 * 50 + 9_001 * 625);
  });

  it("does not count output toward the threshold", () => {
    const c = costOf(haiku, usage({ inputTokens: 100_000, outputTokens: 50_000 }));

    expect(c.longPrompt).toBe(false);
  });

  it("never applies to a model without a long-prompt card", () => {
    const c = costOf(ANTHROPIC_RATES["claude-opus-5-5"], usage({ inputTokens: 200_000 }));

    expect(c.longPrompt).toBe(false);
    expect(c.inputNanos).toBe(200_000 * 4_000);
  });
});

/**
 * Storage keeps micro-dollars (six decimal places), so nanos become micros at
 * the boundary. Rounding is stated and tested rather than left to whatever
 * `toFixed` does, because it runs on every span.
 */
describe("nanosToMicros", () => {
  it.each([
    [0, 0],
    [1_000, 1],
    [1_499, 1],
    [1_500, 2], // half rounds up
    [2_500, 3],
    [999, 1], // sub-micro cost is not silently dropped
    [1, 1],
  ])("rounds %i nanos to %i micros, half-up", (nanos, micros) => {
    expect(nanosToMicros(nanos)).toBe(micros);
  });

  /**
   * A short Haiku 5.5 turn: ~4k input, ~800 output. Pinned end to end so the
   * figure is reproducible from the rates by hand.
   */
  it("prices a realistic Haiku 5.5 turn to a stable micro figure", () => {
    const c = costOf(ANTHROPIC_RATES["claude-haiku-5-5"], usage({ inputTokens: 4_000, outputTokens: 800 }));

    // 4000 * 100 + 800 * 500 = 800_000 nanos = $0.0008
    expect(c.totalNanos).toBe(800_000);
    expect(nanosToMicros(c.totalNanos)).toBe(800);
  });
});
