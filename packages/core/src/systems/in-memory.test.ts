import { describe, expect, it } from "vitest";
import { createInMemorySystems } from "./in-memory";
import type { SeedWorld } from "./seed-world";

const CALL_STARTED_AT = new Date("2026-11-06T06:00:00Z");

/** Two barangays; Batasan Hills has a fiber cut, Commonwealth has none. */
function seed(): SeedWorld {
  return {
    barangays: [
      { id: "batasan-hills", name: "Batasan Hills", city: "Quezon City" },
      { id: "commonwealth", name: "Commonwealth", city: "Quezon City" },
    ],
    accounts: [
      {
        accountNumber: "1234567890",
        holderName: "Maria Santos",
        registeredMobile: "+639175550101",
        status: "active",
        planName: "Kidlat 300",
        barangayId: "batasan-hills",
      },
    ],
    outages: [
      {
        reference: "OUT-2026-0412",
        cause: "fiber cut along Batasan Road from road works",
        barangayIds: ["batasan-hills"],
        startedMinutesBeforeCall: 150,
        restorationMinutesAfterCall: 90,
      },
    ],
  };
}

describe("createInMemorySystems", () => {
  describe("accounts.findAccount", () => {
    it("returns the account with its service area resolved", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.accounts.findAccount("1234567890")).toEqual({
        accountNumber: "1234567890",
        holderName: "Maria Santos",
        registeredMobile: "+639175550101",
        status: "active",
        planName: "Kidlat 300",
        serviceArea: {
          barangayId: "batasan-hills",
          barangayName: "Batasan Hills",
          city: "Quezon City",
        },
      });
    });
    it("returns null for an unknown number and for a near miss", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.accounts.findAccount("9999999999")).toBeNull();
      expect(await systems.accounts.findAccount("123456789")).toBeNull();
      expect(await systems.accounts.findAccount("1234567890 ")).toBeNull();
    });

    it("hands back a copy: mutating it changes nothing stored", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      const first = await systems.accounts.findAccount("1234567890");
      first!.holderName = "Someone Else";
      first!.serviceArea.city = "Manila";
      const second = await systems.accounts.findAccount("1234567890");
      expect(second!.holderName).toBe("Maria Santos");
      expect(second!.serviceArea.city).toBe("Quezon City");
    });

    it("rejects, rather than serving a half record, when a seed skipped the schema and dangles", async () => {
      const world = seed();
      world.accounts[0].barangayId = "payatas";
      const systems = createInMemorySystems(world, CALL_STARTED_AT);
      await expect(systems.accounts.findAccount("1234567890")).rejects.toThrow(/payatas/);
    });

    it("gives each call a fresh world: two systems from one seed share nothing", async () => {
      const shared = seed();
      const one = createInMemorySystems(shared, CALL_STARTED_AT);
      const two = createInMemorySystems(shared, CALL_STARTED_AT);
      shared.accounts[0].holderName = "Edited After Creation";
      shared.barangays[0].name = "Edited Barangay";
      for (const systems of [one, two]) {
        const account = await systems.accounts.findAccount("1234567890");
        expect(account!.holderName).toBe("Maria Santos");
        expect(account!.serviceArea.barangayName).toBe("Batasan Hills");
      }
    });
  });

  describe("network.outagesAffecting", () => {
    it("anchors the relative times to the call's start", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.network.outagesAffecting("batasan-hills")).toEqual([
        {
          reference: "OUT-2026-0412",
          cause: "fiber cut along Batasan Road from road works",
          barangayIds: ["batasan-hills"],
          startedAt: new Date("2026-11-06T03:30:00Z"),
          estimatedRestorationAt: new Date("2026-11-06T07:30:00Z"),
        },
      ]);
    });

    it("orders outages oldest first, ties in seed order", async () => {
      const world = seed();
      const template = world.outages[0];
      world.outages = [
        { ...template, reference: "RECENT", startedMinutesBeforeCall: 20 },
        { ...template, reference: "TIE-A", startedMinutesBeforeCall: 300 },
        { ...template, reference: "OLDEST", startedMinutesBeforeCall: 900 },
        { ...template, reference: "TIE-B", startedMinutesBeforeCall: 300 },
        { ...template, reference: "ELSEWHERE", startedMinutesBeforeCall: 5000, barangayIds: ["commonwealth"] },
      ];
      const systems = createInMemorySystems(world, CALL_STARTED_AT);
      const refs = (await systems.network.outagesAffecting("batasan-hills")).map((o) => o.reference);
      expect(refs).toEqual(["OLDEST", "TIE-A", "TIE-B", "RECENT"]);
    });

    it("reports a null restoration time when the network team has none", async () => {
      const world = seed();
      world.outages[0].restorationMinutesAfterCall = null;
      const systems = createInMemorySystems(world, CALL_STARTED_AT);
      const [outage] = await systems.network.outagesAffecting("batasan-hills");
      expect(outage.estimatedRestorationAt).toBeNull();
      expect(outage.startedAt).toEqual(new Date("2026-11-06T03:30:00Z"));
    });

    it("returns an empty list for a barangay with no outage and for an unknown one", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.network.outagesAffecting("commonwealth")).toEqual([]);
      expect(await systems.network.outagesAffecting("atlantis")).toEqual([]);
    });

    it("lists a multi-barangay outage under each of its barangays", async () => {
      const world = seed();
      world.outages[0].barangayIds = ["batasan-hills", "commonwealth"];
      const systems = createInMemorySystems(world, CALL_STARTED_AT);
      expect(await systems.network.outagesAffecting("commonwealth")).toHaveLength(1);
      expect(await systems.network.outagesAffecting("batasan-hills")).toHaveLength(1);
    });

    it("hands back copies: mutating a result changes nothing stored", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      const [first] = await systems.network.outagesAffecting("batasan-hills");
      first.cause = "tampered";
      first.barangayIds.push("commonwealth");
      first.startedAt.setUTCFullYear(1999);
      const [second] = await systems.network.outagesAffecting("batasan-hills");
      expect(second.cause).toBe("fiber cut along Batasan Road from road works");
      expect(second.barangayIds).toEqual(["batasan-hills"]);
      expect(second.startedAt).toEqual(new Date("2026-11-06T03:30:00Z"));
      expect(await systems.network.outagesAffecting("commonwealth")).toEqual([]);
    });

    it("does not let two calls from one seed see each other's world or the seed's later edits", async () => {
      const shared = seed();
      const one = createInMemorySystems(shared, CALL_STARTED_AT);
      shared.outages[0].cause = "edited after creation";
      const two = createInMemorySystems(shared, CALL_STARTED_AT);
      expect((await one.network.outagesAffecting("batasan-hills"))[0].cause).toBe(
        "fiber cut along Batasan Road from road works",
      );
      expect((await two.network.outagesAffecting("batasan-hills"))[0].cause).toBe("edited after creation");
    });

    it("follows the call's start, not the wall clock", async () => {
      const later = new Date("2031-02-14T22:15:00Z");
      const systems = createInMemorySystems(seed(), later);
      const [outage] = await systems.network.outagesAffecting("batasan-hills");
      expect(outage.startedAt).toEqual(new Date("2031-02-14T19:45:00Z"));
      expect(outage.estimatedRestorationAt).toEqual(new Date("2031-02-14T23:45:00Z"));
    });
  });
});
