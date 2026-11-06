/**
 * Ranking a company pack's help articles against what the caller asked: how
 * the in-memory knowledge base searches (`./in-memory`).
 *
 * A plain term score, so the order can be worked out by hand: text is
 * lowercased and stripped of punctuation, then split into words. Each
 * distinct word of the question scores in each part of an article it appears
 * in, a title match most, then a tag, then the body, and the scores add up.
 * Common words count like any other; the SOP tells Tala to answer only from
 * an article that answers the question.
 *
 * Pure: no clock, no I/O.
 */
import type { HelpArticle } from "../pack/help-articles";

import { MAX_HELP_RESULTS } from "./types";

/** What a word scores in each part of an article. A title above the tags, the tags above the body. */
const WEIGHTS = { title: 3, tags: 2, body: 1 } as const;

/** Lowercase words with every punctuation mark and symbol removed: "Wi-Fi?" is "wifi". */
function wordsOf(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .split(/\s+/)
    .filter((word) => word !== "");
  return new Set(words);
}

/**
 * The best `MAX_HELP_RESULTS` articles for the question, best first. Equal
 * scores keep the catalog's order. An article sharing no word with the
 * question is left out, so no match is an empty list.
 */
export function rankHelpArticles(articles: readonly HelpArticle[], query: string): HelpArticle[] {
  const asked = wordsOf(query);
  const scored = articles.map((article, position) => {
    const parts = {
      title: wordsOf(article.title),
      tags: wordsOf(article.tags.join(" ")),
      body: wordsOf(article.body),
    };
    let score = 0;
    for (const word of asked) {
      for (const part of ["title", "tags", "body"] as const) {
        if (parts[part].has(word)) score += WEIGHTS[part];
      }
    }
    return { article, position, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, MAX_HELP_RESULTS)
    .map((s) => s.article);
}
