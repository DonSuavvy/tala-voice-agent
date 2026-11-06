import { describe, expect, it } from "vitest";

import { compilePackSop } from "@tala/core";
import { speakingStyleOf } from "@tala/evals";
import { loadKidlatFiber } from "@tala/kidlat-fiber";

/**
 * The Kidlat Fiber pack as `npm run eval` uses it. Repo-level, because
 * `@tala/evals` itself depends on no company pack. None of this needs a key,
 * so a pack change that would break the suite fails here before any money is
 * spent.
 */

describe("Kidlat Fiber's SOP, as the advisory grader reads it", () => {
  /** Renaming the heading would quietly leave every case without a grade. */
  it("has a How you speak section for the grader to grade against", () => {
    const style = speakingStyleOf(compilePackSop(loadKidlatFiber()));

    expect(style).not.toBeNull();
    expect(style).toContain("Taglish");
  });
});
