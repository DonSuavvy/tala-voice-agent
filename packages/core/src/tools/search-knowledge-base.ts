/**
 * `search_knowledge_base`: find the company's help articles that answer a
 * general how-to question.
 *
 * Not behind the account gate: help articles are public and hold nothing
 * about any account, so a caller needs no verification to hear one. The
 * ranking is `rankHelpArticles`, over the company pack's articles.
 */
import { z } from "zod";

import { defineTalaTool } from "./context";
import { MAX_HELP_RESULTS, rankHelpArticles } from "./rank-help-articles";

export const searchKnowledgeBase = defineTalaTool({
  name: "search_knowledge_base",
  description:
    "Searches the company's help articles for a general how-to question, such as what a light " +
    "on the modem means or how to change the Wi-Fi password. It needs no verification: the " +
    "articles hold nothing about any account. Pass the question in a few key words, in the " +
    "caller's own words, Tagalog included. Returns up to " +
    String(MAX_HELP_RESULTS) +
    " articles, best match first, " +
    "each with its id, title and text. An empty list means no article matched. A match is " +
    "not always an answer: answer only from an article that answers the question.",
  input: z
    .object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("The caller's question in a few key words, such as their own words for it."),
    })
    .strict(),
  safetyClass: "read",
  idempotent: true,
  handler: (input, ctx) =>
    Promise.resolve({
      articles: rankHelpArticles(ctx.data.helpArticles, input.query).map((article) => ({
        id: article.id,
        title: article.title,
        text: article.body,
      })),
    }),
});
