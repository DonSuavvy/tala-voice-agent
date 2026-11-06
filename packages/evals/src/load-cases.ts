/**
 * Loads eval cases: one JSON file per case, named `<slug>.json`, in a
 * directory the company pack owns (`packages/packs/kidlat-fiber/evals/cases`).
 * Cases are data, like the rest of a pack (ADR 2), so the pack ships no code
 * for them and this reads them from a path.
 *
 * Like the pack loader, it lists every problem in every file at once: a suite
 * author fixing one typo per run would pay for a model run per typo. Anything
 * named `*.json` is meant to be a case, so one that cannot be read or parsed
 * is a problem too; other files and subdirectories are passed over.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { caseSchema, type EvalCase } from "./case";

export class CaseLoadError extends Error {
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    super(
      `Eval cases in ${source} failed validation with ${issues.length} problem(s):\n` +
        issues.map((i) => `  - ${i}`).join("\n"),
    );
    this.name = "CaseLoadError";
    this.issues = issues;
  }
}

export interface CaseFile {
  /** The file's name, e.g. `scenario-1-outage.json`. */
  name: string;
  text: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `caller.maxTurns`, `expect.toolsCalled[0]`: numeric segments in brackets. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : `${out ? "." : ""}${String(segment)}`;
  }
  return out;
}

/** A `*.json` entry that could not be read as a file. */
interface Unreadable {
  name: string;
  unreadable: string;
}

type Entry = CaseFile | Unreadable;

/**
 * Codepoint order, not `localeCompare`: the run order and the report must not
 * depend on the locale of the machine that ran them.
 */
function byName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function parseOne(file: CaseFile, issues: string[]): EvalCase | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(file.text) as unknown;
  } catch (error) {
    issues.push(`${file.name}: not valid JSON (${messageOf(error)})`);
    return undefined;
  }

  const parsed = caseSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = formatPath(issue.path);
      issues.push(`${file.name}: ${where ? `${where}: ` : ""}${issue.message}`);
    }
    return undefined;
  }

  const expectedName = `${parsed.data.slug}.json`;
  if (file.name !== expectedName) {
    issues.push(
      `${file.name}: slug "${parsed.data.slug}" does not match the file name; ` +
        `name the file ${expectedName}`,
    );
    return undefined;
  }
  return parsed.data;
}

/** Every entry in file-name order; each problem is listed under its file. */
function parseEntries(source: string, entries: readonly Entry[]): EvalCase[] {
  const issues: string[] = [];
  if (entries.length === 0) issues.push("no case files (*.json) to load");

  const cases: EvalCase[] = [];
  for (const entry of [...entries].sort(byName)) {
    if ("unreadable" in entry) {
      issues.push(`${entry.name}: cannot be read (${entry.unreadable})`);
      continue;
    }
    const parsed = parseOne(entry, issues);
    if (parsed) cases.push(parsed);
  }

  if (issues.length > 0) throw new CaseLoadError(source, issues);
  return cases;
}

/**
 * Parse case files, ordered by file name. `source` names where they came from,
 * for the error message. Throws `CaseLoadError` listing every problem.
 */
export function parseCaseFiles(source: string, files: readonly CaseFile[]): EvalCase[] {
  return parseEntries(source, files);
}

/** Read every `*.json` case in `dir`. Throws `CaseLoadError` listing every problem. */
export function loadCases(dir: string): EvalCase[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    throw new CaseLoadError(dir, [`cannot read the cases directory (${messageOf(error)})`]);
  }

  const entries = names.map((name): Entry => {
    try {
      return { name, text: readFileSync(join(dir, name), "utf8") };
    } catch (error) {
      return { name, unreadable: messageOf(error) };
    }
  });
  return parseEntries(dir, entries);
}
