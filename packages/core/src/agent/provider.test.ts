import { describe, expect, it } from "vitest";

import { ANTHROPIC_RATES } from "./cost";
import {
  anthropicProvider,
  createClient,
  providerFromEnv,
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
