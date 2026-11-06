import { describe, expect, it } from "vitest";

import { toStrictJsonSchema } from "../agent/registry";
import { MARIA, testSystems, testToolContext } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { searchKnowledgeBase } from "./search-knowledge-base";
import { verifyIdentity } from "./verify-identity";

/**
 * `search_knowledge_base`, driven through its public definition with the
 * test pack's two help articles: what the modem's lights mean, and changing
 * the Wi-Fi password. Help articles hold nothing about any account, so the
 * search works for a caller nobody has verified.
 */

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function search(ctx: TalaToolContext, query: string) {
  return searchKnowledgeBase.handler(searchKnowledgeBase.input.parse({ query }), ctx);
}

const LIGHTS = {
  id: "modem-lights",
  title: "What the lights on your modem mean",
  text: "Power is on when the modem has power. A red LOS light means no signal reaches it.",
};
const PASSWORD = {
  id: "wifi-password",
  title: "Changing your Wi-Fi password",
  text: "Open the settings page printed on the modem's sticker and choose a new password.",
};

describe("search_knowledge_base", () => {
  it("answers a caller nobody has verified, with each matching article's id, title and text", async () => {
    const ctx = testToolContext(testSystems());

    expect(await search(ctx, "red LOS light")).toEqual({ articles: [LIGHTS] });
  });

  /**
   * "wifi password" scores 11 for the password article (both words in its
   * title and tags, "password" in its body) and nothing for the lights one.
   * "the modem" scores 3 + 3 (title), 2 (tags) and 1 + 1 (body) for the
   * lights article, and 1 for the password one: "the" is in its body, which
   * says "modem's", another word.
   */
  it("gives the matching articles best first", async () => {
    const ctx = testToolContext(testSystems());

    expect(await search(ctx, "wifi password")).toEqual({ articles: [PASSWORD] });
    expect(await search(ctx, "the modem")).toEqual({ articles: [LIGHTS, PASSWORD] });
  });

  /** The articles come from the business systems' knowledge base, an adapter a company fills. */
  it("answers from the knowledge base the business systems give it", async () => {
    const systems = testSystems();
    const answer = { id: "moving", title: "Moving house", tags: ["move"], body: "Tell us first." };
    const ctx = testToolContext({
      ...systems,
      knowledgeBase: { search: (query) => Promise.resolve(query === "lipat" ? [answer] : []) },
    });

    expect(await search(ctx, "lipat")).toEqual({
      articles: [{ id: "moving", title: "Moving house", text: "Tell us first." }],
    });
  });

  it("gives an empty list when no article matches", async () => {
    expect(await search(testToolContext(testSystems()), "cancel my service")).toEqual({
      articles: [],
    });
  });

  it("works once verification is locked, since it reads no account", async () => {
    const ctx = testToolContext(testSystems());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await verifyIdentity.handler(
        verifyIdentity.input.parse({ account_number: MARIA.accountNumber, mobile_last4: "9999" }),
        ctx,
      );
    }

    expect(await search(ctx, "ilaw")).toEqual({ articles: [LIGHTS] });
  });

  const parses = (input: unknown) => searchKnowledgeBase.input.safeParse(input).success;

  it("takes the question, required, and nothing else", () => {
    expect(parses({ query: "modem lights" })).toBe(true);
    expect(parses({ query: "" })).toBe(false);
    expect(parses({})).toBe(false);
    expect(parses({ query: "modem lights", account_number: MARIA.accountNumber })).toBe(false);
    expect(Object.keys(toStrictJsonSchema(searchKnowledgeBase.input).properties)).toEqual(["query"]);
  });

  it("is a read, safe to replay", () => {
    expect(searchKnowledgeBase.safetyClass).toBe("read");
    expect(searchKnowledgeBase.idempotent).toBe(true);
  });
});
