import { describe, expect, it } from "vitest";
import { seedWorldSchema } from "./seed-world";

/** A small valid world: one outage in Batasan Hills, a second barangay with none. */
function validSeed() {
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
      {
        accountNumber: "2234567890",
        holderName: "Jun Reyes",
        registeredMobile: "+639175550102",
        status: "suspended",
        planName: "Kidlat 100",
        barangayId: "commonwealth",
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

/** Rename a barangay and every reference to it, so only the id shape is wrong. */
function renameBarangay(seed: ReturnType<typeof validSeed>, id: string) {
  const old = seed.barangays[0].id;
  seed.barangays[0].id = id;
  for (const a of seed.accounts) if (a.barangayId === old) a.barangayId = id;
  for (const o of seed.outages) o.barangayIds = o.barangayIds.map((b) => (b === old ? id : b));
}

describe("seedWorldSchema", () => {
  it("accepts a valid seed world", () => {
    const result = seedWorldSchema.safeParse(validSeed());
    expect(result.success).toBe(true);
  });

  it("rejects an unknown key at the top level", () => {
    const result = seedWorldSchema.safeParse({ ...validSeed(), extra: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside a barangay, an account and an outage", () => {
    const a = validSeed();
    (a.barangays[0] as Record<string, unknown>).extra = 1;
    const b = validSeed();
    (b.accounts[0] as Record<string, unknown>).extra = 1;
    const c = validSeed();
    (c.outages[0] as Record<string, unknown>).extra = 1;
    for (const seed of [a, b, c]) {
      expect(seedWorldSchema.safeParse(seed).success).toBe(false);
    }
  });

  describe("cross-references", () => {
    function paths(seed: unknown) {
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      return result.error?.issues.map((i) => i.path);
    }

    it("flags a duplicate barangay id at the later entry", () => {
      const seed = validSeed();
      seed.barangays[1].id = "batasan-hills";
      seed.accounts[1].barangayId = "batasan-hills";
      expect(paths(seed)).toEqual([["barangays", 1, "id"]]);
    });

    it("flags a duplicate account number at the later entry", () => {
      const seed = validSeed();
      seed.accounts[1].accountNumber = "1234567890";
      expect(paths(seed)).toEqual([["accounts", 1, "accountNumber"]]);
    });

    it("flags a duplicate outage reference at the later entry", () => {
      const seed = validSeed();
      seed.outages.push({ ...seed.outages[0], barangayIds: ["commonwealth"] });
      expect(paths(seed)).toEqual([["outages", 1, "reference"]]);
    });

    it("flags an account in an unknown barangay", () => {
      const seed = validSeed();
      seed.accounts[1].barangayId = "payatas";
      expect(paths(seed)).toEqual([["accounts", 1, "barangayId"]]);
    });

    it("flags an outage naming an unknown barangay, at that array element", () => {
      const seed = validSeed();
      seed.outages[0].barangayIds = ["batasan-hills", "payatas"];
      expect(paths(seed)).toEqual([["outages", 0, "barangayIds", 1]]);
    });

    it("reports each broken reference as its own issue", () => {
      const seed = validSeed();
      seed.accounts[0].barangayId = "holy-spirit";
      seed.accounts[1].barangayId = "payatas";
      seed.outages[0].barangayIds = ["fairview"];
      expect(paths(seed)).toEqual([
        ["accounts", 0, "barangayId"],
        ["accounts", 1, "barangayId"],
        ["outages", 0, "barangayIds", 0],
      ]);
    });

    it("names the bad value in the message", () => {
      const seed = validSeed();
      seed.accounts[1].barangayId = "payatas";
      const result = seedWorldSchema.safeParse(seed);
      expect(result.error?.issues[0].message).toContain("payatas");
    });
  });

  // The zod 4 probe. A pack loader reports every problem in one pass only as
  // far as zod lets the cross-reference checks run, so pin down where that is.
  describe("refinements next to shape errors", () => {
    const danglingAccount = (seed: ReturnType<typeof validSeed>) => {
      seed.accounts[1].barangayId = "payatas";
    };
    const pathsOf = (seed: unknown) =>
      seedWorldSchema.safeParse(seed).error?.issues.map((i) => i.path);

    it("still runs after a failed check (regex, min, unknown key)", () => {
      const seed = validSeed();
      danglingAccount(seed);
      seed.accounts[0].registeredMobile = "09175550101";
      expect(pathsOf(seed)).toEqual([
        ["accounts", 0, "registeredMobile"],
        ["accounts", 1, "barangayId"],
      ]);
    });

    it("is skipped after a wrong type, so the dangling reference goes unreported", () => {
      const seed = validSeed();
      danglingAccount(seed);
      (seed.accounts[0] as { holderName: unknown }).holderName = 5;
      expect(pathsOf(seed)).toEqual([["accounts", 0, "holderName"]]);
    });

    it("is skipped after a missing field", () => {
      const seed = validSeed();
      danglingAccount(seed);
      delete (seed.accounts[0] as { planName?: string }).planName;
      expect(pathsOf(seed)).toEqual([["accounts", 0, "planName"]]);
    });
  });

  describe("outage and collection shape", () => {
    const cases: Array<[string, (s: ReturnType<typeof validSeed>) => void, (string | number)[]]> = [
      ["empty outage reference", (s) => (s.outages[0].reference = ""), ["outages", 0, "reference"]],
      ["empty outage cause", (s) => (s.outages[0].cause = ""), ["outages", 0, "cause"]],
      ["outage with no barangays", (s) => (s.outages[0].barangayIds = []), ["outages", 0, "barangayIds"]],
      ["negative start offset", (s) => (s.outages[0].startedMinutesBeforeCall = -1), ["outages", 0, "startedMinutesBeforeCall"]],
      ["fractional start offset", (s) => (s.outages[0].startedMinutesBeforeCall = 1.5), ["outages", 0, "startedMinutesBeforeCall"]],
      ["zero restoration offset", (s) => (s.outages[0].restorationMinutesAfterCall = 0), ["outages", 0, "restorationMinutesAfterCall"]],
      ["fractional restoration offset", (s) => (s.outages[0].restorationMinutesAfterCall = 2.5), ["outages", 0, "restorationMinutesAfterCall"]],
      ["no accounts", (s) => ((s as { accounts: unknown[] }).accounts = []), ["accounts"]],
    ];

    it.each(cases)("rejects %s", (_name, mutate, path) => {
      const seed = validSeed();
      mutate(seed);
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([path]);
    });

    it("rejects an empty barangay list (the accounts then dangle too)", () => {
      const result = seedWorldSchema.safeParse({ ...validSeed(), barangays: [] });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toContainEqual(["barangays"]);
    });

    it("accepts a null restoration time and an empty outage list", () => {
      const seed = validSeed();
      seed.outages[0].restorationMinutesAfterCall = null as unknown as number;
      expect(seedWorldSchema.safeParse(seed).success).toBe(true);
      expect(seedWorldSchema.safeParse({ ...validSeed(), outages: [] }).success).toBe(true);
    });
  });

  describe("barangay and account shape", () => {
    // Each case breaks exactly one field and names the path the issue must carry.
    const cases: Array<[string, (s: ReturnType<typeof validSeed>) => void, (string | number)[]]> = [
      ["barangay id not a slug", (s) => renameBarangay(s, "Batasan Hills"), ["barangays", 0, "id"]],
      ["barangay id with trailing dash", (s) => renameBarangay(s, "batasan-"), ["barangays", 0, "id"]],
      ["empty barangay name", (s) => (s.barangays[0].name = ""), ["barangays", 0, "name"]],
      ["empty city", (s) => (s.barangays[1].city = ""), ["barangays", 1, "city"]],
      ["nine-digit account number", (s) => (s.accounts[0].accountNumber = "123456789"), ["accounts", 0, "accountNumber"]],
      ["account number with a dash", (s) => (s.accounts[0].accountNumber = "12345-6789"), ["accounts", 0, "accountNumber"]],
      ["empty holder name", (s) => (s.accounts[0].holderName = ""), ["accounts", 0, "holderName"]],
      ["mobile without the plus", (s) => (s.accounts[0].registeredMobile = "639175550101"), ["accounts", 0, "registeredMobile"]],
      ["mobile in local 09 format", (s) => (s.accounts[1].registeredMobile = "09175550101"), ["accounts", 1, "registeredMobile"]],
      ["landline, not a mobile", (s) => (s.accounts[0].registeredMobile = "+63281234567"), ["accounts", 0, "registeredMobile"]],
      ["unknown status", (s) => (s.accounts[0].status = "closed"), ["accounts", 0, "status"]],
      ["empty plan name", (s) => (s.accounts[0].planName = ""), ["accounts", 0, "planName"]],
    ];

    it.each(cases)("rejects %s", (_name, mutate, path) => {
      const seed = validSeed();
      mutate(seed);
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([path]);
    });
  });
});
