/**
 * Compare two eval reports (#9).
 *
 *   npm run eval:diff -- <before.json> <after.json>
 *
 * Prints both runs' pins, which parts of the pin changed, and every case
 * sorted into regressed, fixed, added, removed and unchanged, with the
 * assertions that moved. Reads files only: no key, no network, no cost.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { formatDiff, parseReport, type DiffableReport } from "@tala/evals";

function read(path: string): DiffableReport {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path} (${error instanceof Error ? error.message : String(error)})`, {
      cause: error,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not JSON (${error instanceof Error ? error.message : String(error)})`, {
      cause: error,
    });
  }
  return parseReport(raw, path);
}

function main(): void {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 2) {
    throw new Error("usage: npm run eval:diff -- <before.json> <after.json>");
  }
  const [before, after] = positionals.map(read);
  console.log(formatDiff(before, after));
}

try {
  main();
} catch (error) {
  console.error(`eval:diff: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
