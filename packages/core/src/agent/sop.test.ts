import { describe, expect, it } from "vitest";

import {
  compileSop,
  formatMoney,
  sopPlaceholders,
  UnknownPlaceholderError,
  type SopRenderers,
} from "./sop";

/**
 * The SOP *is* the prompt. That only holds if the figures the model reads come
 * from the same policy the tool handler revalidates against. Otherwise editing
 * a limit changes what the code enforces while the prose keeps the old number,
 * and the agent refuses something under a rule it was never told.
 *
 * So the markdown carries placeholders and the figures are substituted at
 * compile time from the policy. The engine owns the mechanism; a company pack
 * owns the vocabulary. The policy below is a test fixture shaped like a bill
 * credit policy, not Kidlat Fiber's real one.
 */

interface FixturePolicy {
  credit: { maxAutoApproveMinor: number; maxCreditMinor: number };
  outage: { creditAfterHours: number };
}

const PESO = { code: "PHP", locale: "en-PH" } as const;

const DEFAULT: FixturePolicy = {
  credit: { maxAutoApproveMinor: 20_000, maxCreditMinor: 150_000 },
  outage: { creditAfterHours: 24 },
};

const RENDERERS: SopRenderers<FixturePolicy> = {
  "credit.maxAutoApprove": (p) => formatMoney(p.credit.maxAutoApproveMinor, PESO),
  "credit.maxCredit": (p) => formatMoney(p.credit.maxCreditMinor, PESO),
  "outage.creditAfterHours": (p) => String(p.outage.creditAfterHours),
};

function policy(overrides: {
  credit?: Partial<FixturePolicy["credit"]>;
  outage?: Partial<FixturePolicy["outage"]>;
}): FixturePolicy {
  return {
    credit: { ...DEFAULT.credit, ...overrides.credit },
    outage: { ...DEFAULT.outage, ...overrides.outage },
  };
}

function compile(bodyMarkdown: string, policyConfig: FixturePolicy = DEFAULT) {
  return compileSop({ bodyMarkdown, policyConfig, renderers: RENDERERS });
}

describe("compileSop", () => {
  it("substitutes a figure from the policy, not from the markdown", () => {
    expect(compile("Credit after {{outage.creditAfterHours}} hours.")).toBe(
      "Credit after 24 hours.",
    );
  });

  /**
   * The load-bearing property. Same document, one policy field changed, and
   * the text the model receives must differ. If this passed trivially, editing
   * a limit would prove nothing.
   */
  it("changes the compiled prompt when a policy figure changes", () => {
    const markdown = "Credit after {{outage.creditAfterHours}} hours.";

    const day = compile(markdown, policy({ outage: { creditAfterHours: 24 } }));
    const twelve = compile(markdown, policy({ outage: { creditAfterHours: 12 } }));

    expect(day).not.toEqual(twelve);
    expect(twelve).toBe("Credit after 12 hours.");
  });

  it("renders money through the pack's currency", () => {
    expect(compile("auto {{credit.maxAutoApprove}} / cap {{credit.maxCredit}}")).toBe(
      "auto ₱200.00 / cap ₱1,500.00",
    );
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(
      compile(
        "{{outage.creditAfterHours}} and {{outage.creditAfterHours}}",
        policy({ outage: { creditAfterHours: 12 } }),
      ),
    ).toBe("12 and 12");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(compile("{{ outage.creditAfterHours }}h")).toBe("24h");
  });

  /**
   * Fails loudly, like the tool registry's boot validation. A typo'd
   * placeholder that survived into the prompt would ship a literal
   * `{{outage.creditAfterHour}}` to the model, which reads as an instruction
   * nobody wrote.
   */
  it("throws on an unknown placeholder rather than passing it through", () => {
    expect(() => compile("after {{outage.creditAfterHour}} hours")).toThrow(
      UnknownPlaceholderError,
    );
  });

  it("names the offending placeholder and the pack's vocabulary in the error", () => {
    expect(() => compile("{{credit.nonsense}}")).toThrow(/credit\.nonsense/);
    expect(() => compile("{{credit.nonsense}}")).toThrow(/credit\.maxCredit/);
  });

  /**
   * The renderers are a plain object, so a plain lookup also finds what
   * Object.prototype supplies. `{{toString}}` would then render as
   * "[object Object]" instead of failing, which is a figure the model reads
   * and nobody wrote. The same bug class as OpsPilot's FAILURES #18.
   */
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "treats {{%s}} as unknown, not as an inherited member",
    (name) => {
      expect(() => compile(`figure: {{${name}}}`)).toThrow(UnknownPlaceholderError);
    },
  );

  /** The vocabulary is the pack's. Another pack's placeholder is unknown here. */
  it("knows only the placeholders the pack supplies", () => {
    expect(() => compile("window {{refund.windowDays}} days")).toThrow(
      UnknownPlaceholderError,
    );
  });

  it("leaves markdown without placeholders untouched", () => {
    const markdown = "# Heading\n\nProse with no substitutions.";
    expect(compile(markdown)).toBe(markdown);
  });

  /**
   * No clock, no I/O. A compiler whose output varied between two runs of the
   * same SOP version would also change the prompt-cache key and silently drop
   * the hit rate to zero.
   */
  it("is deterministic across calls", () => {
    const markdown = "after {{outage.creditAfterHours}} auto {{credit.maxAutoApprove}}";
    expect(compile(markdown)).toBe(compile(markdown));
  });
});

describe("sopPlaceholders", () => {
  it("lists the pack's vocabulary, for an editor or a boot check to validate against", () => {
    expect(sopPlaceholders(RENDERERS)).toEqual([
      "credit.maxAutoApprove",
      "credit.maxCredit",
      "outage.creditAfterHours",
    ]);
  });
});

/**
 * Money is held in integer minor units everywhere (centavos for pesos, cents
 * for dollars), as the policy engine does, and formatted only for prose. The
 * locale is always explicit: formatting that read the host's locale would make
 * the compiled prompt, and so the cache key, differ between a laptop and the
 * server.
 */
describe("formatMoney", () => {
  it("formats pesos", () => {
    expect(formatMoney(150_000, PESO)).toBe("₱1,500.00");
    expect(formatMoney(5, PESO)).toBe("₱0.05");
  });

  it("formats dollars, as OpsPilot did", () => {
    expect(formatMoney(123_456, { code: "USD", locale: "en-US" })).toBe("$1,234.56");
  });

  it("follows the currency's own minor unit", () => {
    // Yen has no minor unit, so 1500 minor units is ¥1,500, not ¥15.00.
    expect(formatMoney(1_500, { code: "JPY", locale: "ja-JP" })).toBe("￥1,500");
  });

  it("refuses an amount that is not a whole number of minor units", () => {
    expect(() => formatMoney(10.5, PESO)).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, PESO)).toThrow(RangeError);
    expect(() => formatMoney(Number.POSITIVE_INFINITY, PESO)).toThrow(RangeError);
  });
});
