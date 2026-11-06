import { describe, expect, it } from "vitest";

import type { HelpArticle } from "../pack/help-articles";

import { rankHelpArticles } from "./rank-help-articles";

/**
 * Ranking help articles against what the caller asked, as a pure function.
 *
 * Words are lowercased and stripped of punctuation. Each distinct word of the
 * question scores in each part of an article it appears in: the title most,
 * then the tags, then the body. The best three come back, best first; equal
 * scores keep the catalog's order, and an article that shares no word with
 * the question is left out. Every expected order is worked out by hand.
 */

const article = (id: string, title: string, tags: string[], body: string): HelpArticle => ({
  id,
  title,
  tags,
  body,
});

/** A small catalog, in catalog order. */
const LIGHTS = article(
  "modem-lights",
  "What the lights on your modem mean",
  ["modem", "lights", "ilaw", "pula"],
  "A red LOS light means no signal reaches the modem.",
);
const RESTART = article(
  "restart-modem",
  "Restarting your modem",
  ["restart", "reboot"],
  "Turn the modem off and on again.",
);
const PASSWORD = article(
  "wifi-password",
  "Changing your Wi-Fi password",
  ["wifi", "password"],
  "Open the modem's settings page and type a new password.",
);
const SLOW = article(
  "slow-wifi",
  "Slow Wi-Fi in some rooms",
  ["slow", "wifi", "mabagal"],
  "Move the modem up high, away from walls.",
);
const PAY = article("pay-bill", "Where you can pay your bill", ["pay", "bayad"], "Pay through GCash.");
const CATALOG = [LIGHTS, RESTART, PASSWORD, SLOW, PAY];

const idsFor = (query: string, articles: readonly HelpArticle[] = CATALOG) =>
  rankHelpArticles(articles, query).map((a) => a.id);

describe("rankHelpArticles", () => {
  /**
   * "router" is in the last article's title (3), the middle one's tags (2)
   * and the first one's body (1): the field decides, not the catalog order.
   */
  it("ranks a word in the title above one in the tags, and the tags above the body", () => {
    const inBody = article("in-body", "Your connection", ["internet"], "Restart the router.");
    const inTags = article("in-tags", "Your equipment", ["router"], "Check the cables.");
    const inTitle = article("in-title", "Your router", ["equipment"], "Check the cables.");

    expect(idsFor("router", [inBody, inTags, inTitle])).toEqual(["in-title", "in-tags", "in-body"]);
  });

  /**
   * "slow wifi": Slow Wi-Fi has both words in its title (3 + 3) and its tags
   * (2 + 2), 10; the password article has "wifi" in its title and tags, 5.
   */
  it("ranks an article matching more of the question's words higher", () => {
    expect(idsFor("slow wifi")).toEqual(["slow-wifi", "wifi-password"]);
  });

  /**
   * "WI-FI Password?" is "wifi" and "password": the password article scores
   * 3 + 3 in its title, 2 + 2 in its tags and 1 in its body, 11; Slow Wi-Fi
   * scores 3 + 2 for "wifi", 5.
   */
  it("ignores case and punctuation in the question and the articles", () => {
    expect(idsFor("WI-FI Password?")).toEqual(["wifi-password", "slow-wifi"]);
  });

  /** Callers say what they see in Tagalog: the tags carry those words. */
  it("finds an article by the Tagalog words in its tags", () => {
    expect(idsFor("Bakit pula ang ilaw?")).toEqual(["modem-lights"]);
  });

  /**
   * "the modem": the lights article scores 3 + 3 (title), 2 (tags) and
   * 1 + 1 (body), 10; Restart, 3 (title) and 1 + 1 (body), 5; Slow Wi-Fi,
   * 1 + 1 (body), 2; the password article, 1 ("the"; its body says
   * "modem's", which is another word). Only the best three come back.
   */
  it("gives the best three, best first", () => {
    expect(idsFor("the modem")).toEqual(["modem-lights", "restart-modem", "slow-wifi"]);
  });

  it("keeps the catalog's order between articles with the same score", () => {
    const first = article("first", "Fiber", ["cable"], "One.");
    const second = article("second", "Fiber", ["cable"], "Two.");

    expect(idsFor("fiber cable", [first, second])).toEqual(["first", "second"]);
    expect(idsFor("fiber cable", [second, first])).toEqual(["second", "first"]);
  });

  /** Said three times, "wifi" still scores once: 3 against "password"'s 3, a tie. */
  it("counts a word the question repeats once", () => {
    const password = article("password", "Password", ["account"], "One.");
    const wifi = article("wifi", "Wifi", ["network"], "Two.");

    expect(idsFor("wifi wifi wifi password", [password, wifi])).toEqual(["password", "wifi"]);
  });

  it("gives nothing when no article shares a word with the question", () => {
    expect(rankHelpArticles(CATALOG, "cancel subscription")).toEqual([]);
    expect(rankHelpArticles(CATALOG, "?!")).toEqual([]);
    expect(rankHelpArticles([], "modem")).toEqual([]);
  });

  it("hands back the articles themselves, whole", () => {
    expect(rankHelpArticles(CATALOG, "reboot")).toEqual([RESTART]);
  });
});
