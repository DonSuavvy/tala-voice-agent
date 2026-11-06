import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CaseLoadError, loadCases, parseCaseFiles } from "./load-cases";

/**
 * Eval cases are data in the company pack, one JSON file per case named after
 * its slug. The loader reads a directory of them and, like the pack loader,
 * lists every problem in every file at once rather than stopping at the first.
 */

function caseJson(slug: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    slug,
    title: `Case ${slug}`,
    caller: { brief: "You are a caller with no internet.", maxTurns: 4 },
    expect: { endedBy: "end_call" },
    ...over,
  });
}

/** The thrown error's issues, or a failure if nothing was thrown. */
function issuesFrom(load: () => unknown): string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof CaseLoadError) return error.issues;
    throw error;
  }
  throw new Error("expected the cases to be rejected");
}

describe("parseCaseFiles", () => {
  it("returns every case, ordered by file name", () => {
    const cases = parseCaseFiles("cases", [
      { name: "scenario-2-gcash.json", text: caseJson("scenario-2-gcash") },
      { name: "scenario-1-outage.json", text: caseJson("scenario-1-outage") },
    ]);

    expect(cases.map((c) => c.slug)).toEqual(["scenario-1-outage", "scenario-2-gcash"]);
    expect(cases[0]).toEqual({
      slug: "scenario-1-outage",
      title: "Case scenario-1-outage",
      caller: { brief: "You are a caller with no internet.", maxTurns: 4 },
      expect: { endedBy: "end_call" },
    });
  });

  it("lists every problem in every file at once, each with its file and path", () => {
    const issues = issuesFrom(() =>
      parseCaseFiles("cases", [
        { name: "broken.json", text: "{ not json" },
        {
          name: "typos.json",
          text: caseJson("typos", {
            caller: { brief: "x", maxTurns: 0 },
            expect: { endedBy: "end_call", toolsCaled: ["end_call"] },
          }),
        },
        { name: "fine.json", text: caseJson("fine") },
      ]),
    );

    expect(issues).toEqual([
      expect.stringMatching(/^broken\.json: not valid JSON \(.+\)$/),
      "typos.json: caller.maxTurns: Too small: expected number to be >0",
      'typos.json: expect: Unrecognized key: "toolsCaled"',
    ]);
  });

  it("puts the problems in the error's message, one per line", () => {
    try {
      parseCaseFiles("packs/kidlat-fiber/evals/cases", [
        { name: "a.json", text: caseJson("a", { title: "" }) },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(
        "Eval cases in packs/kidlat-fiber/evals/cases failed validation with 1 problem(s):\n" +
          "  - a.json: title: a title must not be empty",
      );
    }
  });

  /** The file name is how a person finds a case; the slug is how the diff matches it. */
  it("rejects a case whose slug is not its file name", () => {
    expect(
      issuesFrom(() =>
        parseCaseFiles("cases", [{ name: "scenario-1.json", text: caseJson("scenario-1-outage") }]),
      ),
    ).toEqual([
      'scenario-1.json: slug "scenario-1-outage" does not match the file name; ' +
        "name the file scenario-1-outage.json",
    ]);
  });

  /** An empty suite passes every run. */
  it("rejects a suite with no cases", () => {
    expect(issuesFrom(() => parseCaseFiles("cases", []))).toEqual([
      "no case files (*.json) to load",
    ]);
  });
});

describe("loadCases", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "tala-cases-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the .json files in a directory and passes over everything else", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "scenario-1-outage.json"), caseJson("scenario-1-outage"));
    writeFileSync(join(dir, "README.md"), "# Cases");
    mkdirSync(join(dir, "drafts"));
    writeFileSync(join(dir, "drafts", "draft.json"), "{ not json");

    expect(loadCases(dir).map((c) => c.slug)).toEqual(["scenario-1-outage"]);
  });

  /** Anything named like a case is meant to be one, so one that cannot be read is a problem. */
  it("lists a .json entry it cannot read beside the other problems", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "stray.json"));
    writeFileSync(join(dir, "a.json"), caseJson("a", { title: "" }));

    expect(issuesFrom(() => loadCases(dir))).toEqual([
      "a.json: title: a title must not be empty",
      expect.stringMatching(/^stray\.json: cannot be read \(.+\)$/),
    ]);
  });

  it("reports a directory that does not exist as a problem, not a crash", () => {
    const missing = join(tempDir(), "nope");

    expect(issuesFrom(() => loadCases(missing))).toEqual([
      expect.stringMatching(/^cannot read the cases directory \(.+\)$/),
    ]);
  });
});
