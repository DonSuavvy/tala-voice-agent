import { describe, expect, it } from "vitest";

import { compilePackSop, createInMemorySystems, loadPack } from "@tala/core";

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
    expect(persona.openingLine).toMatch(/nire-record/);
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
