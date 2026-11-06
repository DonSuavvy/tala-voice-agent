/**
 * @tala/kidlat-fiber: the Kidlat Fiber company pack.
 *
 * Kidlat Fiber is a fictional Philippine fiber internet provider. Everything
 * that makes Tala *Kidlat's* agent rather than any ISP's lives in this
 * package's data files, and nothing here is code Tala's core runs:
 *
 * - `sop/v1.md`: the SOP, the prompt Claude reads. Its figures are
 *   placeholders filled from the policy at compile time, so what Tala says
 *   and what the tool handlers enforce cannot drift apart.
 * - `pack/policy.json`: the limits the tool handlers enforce.
 * - `pack/persona.json`: the lines Tala says that no model writes: the
 *   opening disclosure, the fallback line, and the filler and closing lines
 *   said for a model turn that calls a tool with nothing said.
 * - `pack/company.json`: the time zone and locale times are spoken in, and
 *   the currency money is spoken in.
 * - `pack/world.json`: the seed world every call starts from a fresh copy of,
 *   including scenario 1's Batasan Hills fiber cut, scenario 2's GCash
 *   payment that has not posted, and scenario 3's San Antonio line with signal
 *   loss that a remote reboot does not clear, with the technician calendar.
 *
 * `loadKidlatFiber()` reads them and hands them to core's `loadPack`, which
 * checks all of it at boot and lists every problem at once.
 */
import { readFileSync } from "node:fs";

import { loadPack, PackValidationError, type CompanyPack, type PackSource } from "@tala/core";

/** The SOP version every call made with this pack is pinned to. */
export const KIDLAT_SOP_VERSION = "v1";

const PACK_ROOT = new URL("../", import.meta.url);

const JSON_FILES = ["company", "persona", "policy", "world"] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pack's files as raw input, before `loadPack` checks them.
 *
 * `root` is the pack's directory (a URL ending in a slash); only tests pass it.
 * Every file is read first and every unreadable or unparseable one is listed in
 * one `PackValidationError`, so a syntax error in one file does not hide the
 * others. Schema problems are reported by `loadPack` once the JSON parses.
 */
export function kidlatFiberSource(root: URL = PACK_ROOT): PackSource {
  const issues: string[] = [];

  function read(path: string): string | undefined {
    try {
      return readFileSync(new URL(path, root), "utf8");
    } catch (error) {
      issues.push(`${path}: cannot be read (${messageOf(error)})`);
      return undefined;
    }
  }

  function readJson(path: string): unknown {
    const text = read(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      issues.push(`${path}: not valid JSON (${messageOf(error)})`);
      return undefined;
    }
  }

  const body = read(`sop/${KIDLAT_SOP_VERSION}.md`);
  const json = Object.fromEntries(
    JSON_FILES.map((name) => [name, readJson(`pack/${name}.json`)]),
  ) as Record<(typeof JSON_FILES)[number], unknown>;

  if (issues.length > 0 || body === undefined) {
    throw new PackValidationError("kidlat-fiber", issues);
  }

  return {
    id: "kidlat-fiber",
    sop: { version: KIDLAT_SOP_VERSION, body },
    company: json.company,
    persona: json.persona,
    policy: json.policy,
    world: json.world,
  };
}

/** Read and validate the pack. Throws `PackValidationError` listing every problem. */
export function loadKidlatFiber(): CompanyPack {
  return loadPack(kidlatFiberSource());
}
