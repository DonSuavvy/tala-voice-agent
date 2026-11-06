import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { compilePackSop, createInMemorySystems, loadPack, PackValidationError } from "@tala/core";

import { KIDLAT_SOP_VERSION, kidlatFiberSource, loadKidlatFiber } from "./index";

/**
 * The shipped pack, checked as data. core's own tests prove the loader; these
 * prove that what Kidlat Fiber ships passes it and still says what the demo
 * scenarios need.
 */
describe("the Kidlat Fiber pack", () => {
  it("loads with no problems and is pinned to its SOP version", () => {
    const pack = loadKidlatFiber();

    expect(pack.id).toBe("kidlat-fiber");
    expect(pack.sop.version).toBe(KIDLAT_SOP_VERSION);
  });

  it("states the verification limit from its policy, not from typed text", () => {
    const source = kidlatFiberSource();
    const shipped = compilePackSop(loadPack(source));
    const stricter = compilePackSop(
      loadPack({ ...source, policy: { identity: { maxFailedAttempts: 2 } } }),
    );

    expect(shipped).toContain("After 3 failed attempts");
    expect(stricter).toContain("After 2 failed attempts");
    expect(shipped).not.toContain("{{");
  });

  it("opens every call by saying Tala is an AI and the call is recorded", () => {
    const { persona } = loadKidlatFiber();

    expect(persona.openingLine).toMatch(/AI assistant/);
    expect(persona.openingLine).toMatch(/record/);
  });

  it("has scenario 1's world: a fiber cut in Batasan Hills with a restoration time", async () => {
    const { world } = loadKidlatFiber();
    const systems = createInMemorySystems(world, new Date("2026-11-06T05:00:00Z"));

    const maria = await systems.accounts.findAccount("8012345601");
    const outages = await systems.network.outagesAffecting("batasan-hills");

    expect(maria?.serviceArea).toEqual({
      barangayId: "batasan-hills",
      barangayName: "Batasan Hills",
      city: "Quezon City",
    });
    expect(outages).toHaveLength(1);
    expect(outages[0].cause).toMatch(/fiber/);
    expect(outages[0].estimatedRestorationAt).not.toBeNull();
  });
});

/**
 * A pack with unreadable files must name every one of them, not stop at the
 * first parser error. Tested on a temporary copy so the shipped files stay put.
 */
describe("kidlatFiberSource on a broken copy of the pack", () => {
  const copies: string[] = [];

  afterEach(() => {
    for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function copyOfPack(): { root: URL; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "kidlat-pack-"));
    copies.push(dir);
    const here = fileURLToPath(new URL("../", import.meta.url));
    cpSync(join(here, "sop"), join(dir, "sop"), { recursive: true });
    cpSync(join(here, "pack"), join(dir, "pack"), { recursive: true });
    return { root: pathToFileURL(dir + sep), dir };
  }

  function issuesFrom(root: URL): string[] {
    try {
      kidlatFiberSource(root);
    } catch (error) {
      if (error instanceof PackValidationError) return error.issues;
      throw error;
    }
    throw new Error("expected kidlatFiberSource to throw");
  }

  it("lists every file that is not valid JSON, by name", () => {
    const { root, dir } = copyOfPack();
    writeFileSync(join(dir, "pack/world.json"), '{ "barangays": [1,, 2] }');
    writeFileSync(join(dir, "pack/policy.json"), "{ nope");

    const issues = issuesFrom(root);

    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual(expect.stringMatching(/^pack\/world\.json: not valid JSON \(.+\)$/));
    expect(issues).toContainEqual(expect.stringMatching(/^pack\/policy\.json: not valid JSON \(.+\)$/));
  });

  it("lists a missing file the same way", () => {
    const { root, dir } = copyOfPack();
    rmSync(join(dir, "pack/persona.json"));

    expect(issuesFrom(root)).toEqual([
      expect.stringMatching(/^pack\/persona\.json: cannot be read \(.+\)$/),
    ]);
  });
});
