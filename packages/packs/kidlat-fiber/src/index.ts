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
 * - `pack/persona.json`: the opening disclosure and the fallback line.
 * - `pack/company.json`: the time zone and locale times are spoken in.
 * - `pack/world.json`: the seed world every call starts from a fresh copy of,
 *   including scenario 1's Batasan Hills fiber cut.
 *
 * `loadKidlatFiber()` reads them and hands them to core's `loadPack`, which
 * checks all of it at boot and lists every problem at once.
 */
import { readFileSync } from "node:fs";

import { loadPack, type CompanyPack, type PackSource } from "@tala/core";

/** The SOP version every call made with this pack is pinned to. */
export const KIDLAT_SOP_VERSION = "v1";

const PACK_ROOT = new URL("../", import.meta.url);

function readText(path: string): string {
  return readFileSync(new URL(path, PACK_ROOT), "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}

/** The pack's files as raw input, before `loadPack` checks them. */
export function kidlatFiberSource(): PackSource {
  return {
    id: "kidlat-fiber",
    sop: {
      version: KIDLAT_SOP_VERSION,
      body: readText(`sop/${KIDLAT_SOP_VERSION}.md`),
    },
    company: readJson("pack/company.json"),
    persona: readJson("pack/persona.json"),
    policy: readJson("pack/policy.json"),
    world: readJson("pack/world.json"),
  };
}

/** Read and validate the pack. Throws `PackValidationError` listing every problem. */
export function loadKidlatFiber(): CompanyPack {
  return loadPack(kidlatFiberSource());
}
