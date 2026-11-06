import { describe, expect, it } from "vitest";

import { ANTHROPIC_RATES, FALLBACK_TARGET_RATES, UNKNOWN_MODEL_CEILING } from "./cost";
import {
  anthropicProvider,
  createClient,
  providerFromEnv,
  refusalFallbackFor,
  type LogicalModel,
} from "./provider";

/**
 * Tala calls Claude through the first-party Anthropic API only. This adapter
 * is the one place that maps logical model names to wire ids and rate cards;
 * nothing downstream names a model by its id.
 *
 * OpsPilot's version also had an Amazon Bedrock provider, with its own ids,
 * unverified rates and credential checks. That provider and its 12 tests were
 * not carried over: Tala must never call Bedrock.
 */
const MODELS: LogicalModel[] = ["haiku", "sonnet", "opus"];

describe("model identity", () => {
  it.each([
    ["haiku", "claude-haiku-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["opus", "claude-opus-5-5"],
  ] as const)("maps %s to the bare first-party id", (model, id) => {
    expect(anthropicProvider.modelId(model)).toBe(id);
  });

  it("refuses a model it has no mapping for", () => {
    expect(() => anthropicProvider.modelId("gpt-4" as LogicalModel)).toThrow(/gpt-4/);
  });

  it("refuses a name Object.prototype happens to supply", () => {
    expect(() => anthropicProvider.modelId("toString" as LogicalModel)).toThrow(
      /toString/,
    );
  });
});

describe("rate cards carry their provenance", () => {
  it.each(MODELS)("marks the %s card verified, with its source", (model) => {
    const card = anthropicProvider.rateCard(model);
    expect(card.verifiedOn).not.toBeNull();
    expect(card.source).toMatch(/claude-api skill/i);
  });

  it.each(MODELS)("prices %s from the first-party table", (model) => {
    expect(anthropicProvider.rateCard(model)).toBe(
      ANTHROPIC_RATES[anthropicProvider.modelId(model) as keyof typeof ANTHROPIC_RATES],
    );
  });
});

/**
 * A response names the model that served it by wire id, and with server-side
 * fallback that need not be the model requested. Pricing it needs the way
 * back from a wire id to a card, and that lookup lives here, beside the
 * mapping it reverses.
 */
describe("the card for the model that served a turn", () => {
  it.each(MODELS)("finds %s's own card from its wire id", (model) => {
    expect(anthropicProvider.rateCardForModelId(anthropicProvider.modelId(model))).toBe(
      anthropicProvider.rateCard(model),
    );
  });

  /**
   * A refusal fallback runs Opus 5.5's turns on Opus 5 or Opus 4.8, and
   * Sonnet 5.5's on Sonnet 5. Those are wire ids a response can name, never
   * logical models Tala requests.
   */
  it.each(["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"] as const)(
    "finds the card of %s, a documented fallback target",
    (modelId) => {
      expect(anthropicProvider.rateCardForModelId(modelId)).toBe(FALLBACK_TARGET_RATES[modelId]);
    },
  );

  it("books a model it has no card for at the ceiling, never at a cheaper card", () => {
    expect(anthropicProvider.rateCardForModelId("claude-opus-4-7")).toBe(UNKNOWN_MODEL_CEILING);
    expect(anthropicProvider.rateCardForModelId("claude-fable-5-1")).toBe(UNKNOWN_MODEL_CEILING);
  });

  it("books a missing model id, or one Object.prototype supplies, at the ceiling", () => {
    expect(anthropicProvider.rateCardForModelId(null)).toBe(UNKNOWN_MODEL_CEILING);
    expect(anthropicProvider.rateCardForModelId("toString")).toBe(UNKNOWN_MODEL_CEILING);
  });
});

/**
 * When a safety classifier declines a turn, the API can re-run it on a
 * fallback model inside the same call, so a false positive does not cost the
 * caller the call. The opt-in is per model and decided here, by wire id,
 * because the streaming creator only ever sees the wire id.
 *
 * The claude-api skill: `fallbacks: "default"` takes the
 * `server-side-fallback-2026-07-01` beta (the array form's `-2026-06-01`
 * header 400s with it); Sonnet 5.5 accepts only the "default" form; Haiku 5.5
 * has no server-side fallback, so its requests do not send it.
 */
describe("server-side refusal fallback", () => {
  it.each(["sonnet", "opus"] as const)(
    "opts %s in with fallbacks: \"default\" and the 2026-07-01 beta",
    (model) => {
      expect(refusalFallbackFor(anthropicProvider.modelId(model))).toEqual({
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    },
  );

  it("never opts haiku in: Haiku 5.5 has no server-side fallback", () => {
    expect(refusalFallbackFor(anthropicProvider.modelId("haiku"))).toBeNull();
  });

  it("opts in no model id it has no mapping for", () => {
    expect(refusalFallbackFor("claude-opus-5")).toBeNull();
    expect(refusalFallbackFor("toString")).toBeNull();
  });
});

describe("providerFromEnv", () => {
  it("selects the Anthropic API when the key is present", () => {
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "sk-ant-example" }).id).toBe("anthropic");
  });

  it("refuses to guess when nothing is configured, and names the variable", () => {
    expect(() => providerFromEnv({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("treats an empty key as missing", () => {
    expect(() => providerFromEnv({ ANTHROPIC_API_KEY: "" })).toThrow(/no provider/i);
  });

  /**
   * OpsPilot chose Bedrock when AWS credentials were present. A developer who
   * copies OpsPilot's environment must not end up anywhere but the
   * first-party API, and with no key, nowhere at all.
   */
  it("ignores AWS credentials: never Bedrock, with or without a key", () => {
    const AWS = {
      AWS_ANTHROPIC_ACCESS_KEY_ID: "AKIAEXAMPLE0000000AA",
      AWS_ANTHROPIC_SECRET_ACCESS_KEY: "s".repeat(40),
      AWS_ANTHROPIC_REGION: "ap-southeast-1",
    };

    expect(() => providerFromEnv(AWS)).toThrow(/ANTHROPIC_API_KEY/);
    expect(providerFromEnv({ ...AWS, ANTHROPIC_API_KEY: "sk-ant-example" }).id).toBe(
      "anthropic",
    );
  });
});

describe("createClient", () => {
  it("refuses to build a client without a key", () => {
    expect(() => createClient({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds a client without making a request", () => {
    expect(createClient({ ANTHROPIC_API_KEY: "sk-ant-example" })).toBeDefined();
  });
});
