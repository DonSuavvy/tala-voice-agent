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
    // Jun owes his October bill, past due, with a disconnection scheduled;
    // his GCash payment from yesterday has not posted. Maria owes nothing.
    balances: [
      {
        accountNumber: "2234567890",
        amountDueMinor: 129_900,
        dueMinutesBeforeCall: 14_400 as number | null,
        disconnectionMinutesAfterCall: 1_440 as number | null,
      },
      {
        accountNumber: "1234567890",
        amountDueMinor: 0,
        dueMinutesBeforeCall: null as number | null,
        disconnectionMinutesAfterCall: null as number | null,
      },
    ],
    bills: [
      {
        reference: "SOA-2610-7890",
        accountNumber: "2234567890",
        amountMinor: 129_900,
        issuedMinutesBeforeCall: 36_000,
      },
    ],
    payments: [
      {
        reference: "1234567890123",
        accountNumber: "2234567890",
        channel: "gcash",
        amountMinor: 129_900,
        paidMinutesBeforeCall: 1_440,
        posted: false,
      },
      {
        reference: "MAYA7K2Q9",
        accountNumber: "1234567890",
        channel: "maya",
        amountMinor: 169_900,
        paidMinutesBeforeCall: 20_160,
        posted: true,
      },
    ],
    // Maria's line has lost signal and a reboot will not bring it back; Jun's
    // modem has hung, and a reboot clears it.
    modems: [
      {
        accountNumber: "1234567890",
        status: "degraded",
        receivedPowerDbm: -28.4,
        lastSeenMinutesBeforeCall: 2,
        fault: "high signal loss on the fiber line" as string | null,
        rebootMayClear: true,
        restartSeconds: 90,
        afterReboot: {
          status: "degraded",
          receivedPowerDbm: -28.3,
          fault: "high signal loss on the fiber line" as string | null,
          rebootMayClear: false,
        },
      },
      {
        accountNumber: "2234567890",
        status: "degraded",
        receivedPowerDbm: -19.5,
        lastSeenMinutesBeforeCall: 5,
        fault: "the modem has hung and is not passing traffic" as string | null,
        rebootMayClear: true,
        restartSeconds: 60,
        afterReboot: {
          status: "online",
          receivedPowerDbm: -19.4,
          fault: null as string | null,
          rebootMayClear: false,
        },
      },
    ],
    // A technician's visit windows, by the day after the call's local date
    // and a local start hour: the morning after the call in Batasan Hills, an
    // afternoon two days on in Commonwealth.
    technicianSlots: [
      { id: "batasan-hills-1", barangayId: "batasan-hills", daysAfterCall: 1, startHour: 9, lengthHours: 3 },
      { id: "commonwealth-1", barangayId: "commonwealth", daysAfterCall: 2, startHour: 13, lengthHours: 4 },
    ],
  };
}

/** Renumber an account and every reference to it, so only the number's shape is wrong. */
function renumberAccount(seed: ReturnType<typeof validSeed>, index: number, accountNumber: string) {
  const old = seed.accounts[index].accountNumber;
  seed.accounts[index].accountNumber = accountNumber;
  for (const entries of [seed.balances, seed.bills, seed.payments, seed.modems]) {
    for (const e of entries) if (e.accountNumber === old) e.accountNumber = accountNumber;
  }
}

/** Rename a barangay and every reference to it, so only the id shape is wrong. */
function renameBarangay(seed: ReturnType<typeof validSeed>, id: string) {
  const old = seed.barangays[0].id;
  seed.barangays[0].id = id;
  for (const a of seed.accounts) if (a.barangayId === old) a.barangayId = id;
  for (const o of seed.outages) o.barangayIds = o.barangayIds.map((b) => (b === old ? id : b));
  for (const s of seed.technicianSlots) if (s.barangayId === old) s.barangayId = id;
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

  it("rejects an unknown key inside a balance, a bill and a payment", () => {
    const a = validSeed();
    (a.balances[0] as Record<string, unknown>).extra = 1;
    const b = validSeed();
    (b.bills[0] as Record<string, unknown>).extra = 1;
    const c = validSeed();
    (c.payments[0] as Record<string, unknown>).extra = 1;
    for (const [seed, collection] of [
      [a, "balances"],
      [b, "bills"],
      [c, "payments"],
    ] as const) {
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([[collection, 0]]);
    }
  });

  it("accepts a world with no balances, bills or payments", () => {
    const seed = { ...validSeed(), balances: [], bills: [], payments: [] };
    expect(seedWorldSchema.safeParse(seed).success).toBe(true);
  });

  it("accepts a world with no modems", () => {
    expect(seedWorldSchema.safeParse({ ...validSeed(), modems: [] }).success).toBe(true);
  });

  it("accepts a world with no technician slots", () => {
    expect(seedWorldSchema.safeParse({ ...validSeed(), technicianSlots: [] }).success).toBe(true);
  });

  it("rejects an unknown key inside a technician slot", () => {
    const seed = validSeed();
    (seed.technicianSlots[0] as Record<string, unknown>).extra = 1;
    expect(seedWorldSchema.safeParse(seed).error?.issues.map((i) => i.path)).toEqual([
      ["technicianSlots", 0],
    ]);
  });

  it("rejects an unknown key inside a modem and inside its state after a reboot", () => {
    const a = validSeed();
    (a.modems[0] as Record<string, unknown>).extra = 1;
    const b = validSeed();
    (b.modems[0].afterReboot as Record<string, unknown>).extra = 1;
    expect(seedWorldSchema.safeParse(a).error?.issues.map((i) => i.path)).toEqual([["modems", 0]]);
    expect(seedWorldSchema.safeParse(b).error?.issues.map((i) => i.path)).toEqual([
      ["modems", 0, "afterReboot"],
    ]);
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
      seed.technicianSlots[1].barangayId = "batasan-hills";
      expect(paths(seed)).toEqual([["barangays", 1, "id"]]);
    });

    it("flags a duplicate account number at the later entry", () => {
      const seed = validSeed();
      seed.accounts.push({ ...seed.accounts[1], accountNumber: "1234567890" });
      expect(paths(seed)).toEqual([["accounts", 2, "accountNumber"]]);
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

    it("flags a second balance for one account at the later entry", () => {
      const seed = validSeed();
      seed.balances[1].accountNumber = "2234567890";
      expect(paths(seed)).toEqual([["balances", 1, "accountNumber"]]);
    });

    it("flags a duplicate bill reference at the later entry", () => {
      const seed = validSeed();
      seed.bills.push({ ...seed.bills[0], accountNumber: "1234567890" });
      expect(paths(seed)).toEqual([["bills", 1, "reference"]]);
    });

    it("flags a duplicate payment reference at the later entry, even on another account", () => {
      const seed = validSeed();
      seed.payments[1].reference = "1234567890123";
      expect(paths(seed)).toEqual([["payments", 1, "reference"]]);
    });

    it("flags a balance, a bill and a payment for an unknown account, each as its own issue", () => {
      const seed = validSeed();
      seed.balances[0].accountNumber = "9999999999";
      seed.bills[0].accountNumber = "8888888888";
      seed.payments[1].accountNumber = "7777777777";
      const result = seedWorldSchema.safeParse(seed);
      expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
        [["balances", 0, "accountNumber"], 'balance names unknown account "9999999999"'],
        [["bills", 0, "accountNumber"], 'bill SOA-2610-7890 names unknown account "8888888888"'],
        [["payments", 1, "accountNumber"], 'payment MAYA7K2Q9 names unknown account "7777777777"'],
      ]);
    });

    it("flags a second modem for one account at the later entry", () => {
      const seed = validSeed();
      seed.modems[1].accountNumber = "1234567890";
      expect(paths(seed)).toEqual([["modems", 1, "accountNumber"]]);
    });

    it("flags a modem for an unknown account", () => {
      const seed = validSeed();
      seed.modems[1].accountNumber = "9999999999";
      const result = seedWorldSchema.safeParse(seed);
      expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
        [["modems", 1, "accountNumber"], 'modem names unknown account "9999999999"'],
      ]);
    });

    it("flags a duplicate technician slot id at the later entry", () => {
      const seed = validSeed();
      seed.technicianSlots[1].id = "batasan-hills-1";
      expect(paths(seed)).toEqual([["technicianSlots", 1, "id"]]);
    });

    it("flags a technician slot in an unknown barangay", () => {
      const seed = validSeed();
      seed.technicianSlots[1].barangayId = "payatas";
      const result = seedWorldSchema.safeParse(seed);
      expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
        [["technicianSlots", 1, "barangayId"], 'technician slot commonwealth-1 names unknown barangay "payatas"'],
      ]);
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
      [
        "no accounts (and so no billing or modems)",
        (s) => {
          (s as { accounts: unknown[] }).accounts = [];
          s.balances = [];
          s.bills = [];
          s.payments = [];
          s.modems = [];
        },
        ["accounts"],
      ],
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

    // 30 days, in minutes: the largest offset a seed may state.
    const MAX_OFFSET = 43_200;

    it.each(["startedMinutesBeforeCall", "restorationMinutesAfterCall"] as const)(
      "accepts %s at 43_200 and refuses 43_201",
      (field) => {
        const atLimit = validSeed();
        atLimit.outages[0][field] = MAX_OFFSET;
        expect(seedWorldSchema.safeParse(atLimit).success).toBe(true);

        const over = validSeed();
        over.outages[0][field] = MAX_OFFSET + 1;
        const result = seedWorldSchema.safeParse(over);
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((i) => i.path)).toEqual([["outages", 0, field]]);
      },
    );

    it("accepts a null restoration time and an empty outage list", () => {
      const seed = validSeed();
      seed.outages[0].restorationMinutesAfterCall = null as unknown as number;
      expect(seedWorldSchema.safeParse(seed).success).toBe(true);
      expect(seedWorldSchema.safeParse({ ...validSeed(), outages: [] }).success).toBe(true);
    });
  });

  describe("balance, bill and payment shape", () => {
    // Amounts are whole minor units (centavos for PHP), never fractions.
    const cases: Array<[string, (s: ReturnType<typeof validSeed>) => void, (string | number)[]]> = [
      ["negative amount due", (s) => (s.balances[0].amountDueMinor = -1), ["balances", 0, "amountDueMinor"]],
      ["fractional amount due", (s) => (s.balances[0].amountDueMinor = 1299.5), ["balances", 0, "amountDueMinor"]],
      ["negative due offset", (s) => (s.balances[0].dueMinutesBeforeCall = -1), ["balances", 0, "dueMinutesBeforeCall"]],
      ["zero disconnection offset", (s) => (s.balances[0].disconnectionMinutesAfterCall = 0), ["balances", 0, "disconnectionMinutesAfterCall"]],
      ["empty bill reference", (s) => (s.bills[0].reference = ""), ["bills", 0, "reference"]],
      ["zero bill amount", (s) => (s.bills[0].amountMinor = 0), ["bills", 0, "amountMinor"]],
      ["fractional bill amount", (s) => (s.bills[0].amountMinor = 0.5), ["bills", 0, "amountMinor"]],
      ["negative issue offset", (s) => (s.bills[0].issuedMinutesBeforeCall = -1), ["bills", 0, "issuedMinutesBeforeCall"]],
      ["payment reference with a space", (s) => (s.payments[0].reference = "1234 567890123"), ["payments", 0, "reference"]],
      ["payment reference with a dash", (s) => (s.payments[0].reference = "1234-567890123"), ["payments", 0, "reference"]],
      ["payment reference in lower case", (s) => (s.payments[1].reference = "maya7k2q9"), ["payments", 1, "reference"]],
      ["unknown payment channel", (s) => (s.payments[0].channel = "paypal"), ["payments", 0, "channel"]],
      ["zero payment amount", (s) => (s.payments[0].amountMinor = 0), ["payments", 0, "amountMinor"]],
      ["negative paid offset", (s) => (s.payments[0].paidMinutesBeforeCall = -1), ["payments", 0, "paidMinutesBeforeCall"]],
    ];

    it.each(cases)("rejects %s", (_name, mutate, path) => {
      const seed = validSeed();
      mutate(seed);
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([path]);
    });

    it.each(["gcash", "maya", "bank", "seven_eleven", "bayad"])("accepts the %s channel", (channel) => {
      const seed = validSeed();
      seed.payments[0].channel = channel;
      expect(seedWorldSchema.safeParse(seed).success).toBe(true);
    });

    // 366 days, in minutes: a billing history spans months, so billing dates
    // have their own bound, wider than the outages' 30 days.
    const MAX_BILLING_OFFSET = 527_040;
    const offsets = [
      ["balances", "dueMinutesBeforeCall"],
      ["balances", "disconnectionMinutesAfterCall"],
      ["bills", "issuedMinutesBeforeCall"],
      ["payments", "paidMinutesBeforeCall"],
    ] as const;

    it.each(offsets)("accepts %s %s at 527_040 and refuses 527_041", (collection, field) => {
      const atLimit = validSeed();
      (atLimit[collection][0] as Record<string, unknown>)[field] = MAX_BILLING_OFFSET;
      expect(seedWorldSchema.safeParse(atLimit).success).toBe(true);

      const over = validSeed();
      (over[collection][0] as Record<string, unknown>)[field] = MAX_BILLING_OFFSET + 1;
      const result = seedWorldSchema.safeParse(over);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([[collection, 0, field]]);
    });
  });

  /**
   * A modem is what the network's own monitoring says about the connection at
   * an account's home: the seed states the system's diagnosis and what a
   * remote reboot does to it. No code turns the numbers into a verdict.
   */
  describe("modem shape", () => {
    const cases: Array<[string, (s: ReturnType<typeof validSeed>) => void, (string | number)[]]> = [
      ["unknown status", (s) => (s.modems[0].status = "rebooting"), ["modems", 0, "status"]],
      ["empty fault", (s) => (s.modems[0].fault = ""), ["modems", 0, "fault"]],
      ["negative last-seen offset", (s) => (s.modems[0].lastSeenMinutesBeforeCall = -1), ["modems", 0, "lastSeenMinutesBeforeCall"]],
      ["fractional last-seen offset", (s) => (s.modems[0].lastSeenMinutesBeforeCall = 1.5), ["modems", 0, "lastSeenMinutesBeforeCall"]],
      ["zero restart time", (s) => (s.modems[0].restartSeconds = 0), ["modems", 0, "restartSeconds"]],
      ["fractional restart time", (s) => (s.modems[0].restartSeconds = 30.5), ["modems", 0, "restartSeconds"]],
      ["unknown status after a reboot", (s) => (s.modems[0].afterReboot.status = "rebooting"), ["modems", 0, "afterReboot", "status"]],
      ["empty fault after a reboot", (s) => (s.modems[0].afterReboot.fault = ""), ["modems", 0, "afterReboot", "fault"]],
    ];

    it.each(cases)("rejects %s", (_name, mutate, path) => {
      const seed = validSeed();
      mutate(seed);
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([path]);
    });

    it.each(["online", "degraded", "offline"])("accepts the %s status, before and after a reboot", (status) => {
      const seed = validSeed();
      seed.modems[0].status = status;
      seed.modems[0].afterReboot.status = status;
      expect(seedWorldSchema.safeParse(seed).success).toBe(true);
    });

    // The caller waits on the line through a restart, so a seed may state at
    // most 3 minutes.
    it("accepts a restart of 180 seconds and refuses 181", () => {
      const atLimit = validSeed();
      atLimit.modems[0].restartSeconds = 180;
      expect(seedWorldSchema.safeParse(atLimit).success).toBe(true);

      const over = validSeed();
      over.modems[0].restartSeconds = 181;
      expect(seedWorldSchema.safeParse(over).error?.issues.map((i) => i.path)).toEqual([
        ["modems", 0, "restartSeconds"],
      ]);
    });

    // 30 days, in minutes, like the outages: an unbounded offset fails mid-call.
    it("accepts a modem last seen 43_200 minutes before the call and refuses 43_201", () => {
      const atLimit = validSeed();
      atLimit.modems[0].lastSeenMinutesBeforeCall = 43_200;
      expect(seedWorldSchema.safeParse(atLimit).success).toBe(true);

      const over = validSeed();
      over.modems[0].lastSeenMinutesBeforeCall = 43_201;
      expect(seedWorldSchema.safeParse(over).error?.issues.map((i) => i.path)).toEqual([
        ["modems", 0, "lastSeenMinutesBeforeCall"],
      ]);
    });
  });

  /**
   * A slot is a day after the call's local date, a local start hour and a
   * length, so its window reads the same whatever time the call starts.
   */
  describe("technician slot shape", () => {
    const cases: Array<[string, (s: ReturnType<typeof validSeed>) => void, (string | number)[]]> = [
      ["slot id not a slug", (s) => (s.technicianSlots[0].id = "Slot 1"), ["technicianSlots", 0, "id"]],
      ["slot on the call's own date", (s) => (s.technicianSlots[0].daysAfterCall = 0), ["technicianSlots", 0, "daysAfterCall"]],
      ["fractional day offset", (s) => (s.technicianSlots[0].daysAfterCall = 1.5), ["technicianSlots", 0, "daysAfterCall"]],
      ["negative start hour", (s) => (s.technicianSlots[0].startHour = -1), ["technicianSlots", 0, "startHour"]],
      ["start hour 24", (s) => (s.technicianSlots[0].startHour = 24), ["technicianSlots", 0, "startHour"]],
      ["fractional start hour", (s) => (s.technicianSlots[0].startHour = 9.5), ["technicianSlots", 0, "startHour"]],
      ["zero-hour window", (s) => (s.technicianSlots[0].lengthHours = 0), ["technicianSlots", 0, "lengthHours"]],
      ["fractional length", (s) => (s.technicianSlots[0].lengthHours = 2.5), ["technicianSlots", 0, "lengthHours"]],
      [
        "window past midnight",
        (s) => {
          s.technicianSlots[0].startHour = 22;
          s.technicianSlots[0].lengthHours = 3;
        },
        ["technicianSlots", 0, "lengthHours"],
      ],
    ];

    it.each(cases)("rejects %s", (_name, mutate, path) => {
      const seed = validSeed();
      mutate(seed);
      const result = seedWorldSchema.safeParse(seed);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path)).toEqual([path]);
    });

    it("accepts a window that ends at midnight", () => {
      const seed = validSeed();
      seed.technicianSlots[0].startHour = 21;
      seed.technicianSlots[0].lengthHours = 3;
      expect(seedWorldSchema.safeParse(seed).success).toBe(true);
    });

    // 30 days, like the outages: an unbounded offset fails mid-call.
    it("accepts a slot 30 days after the call's date and refuses 31", () => {
      const atLimit = validSeed();
      atLimit.technicianSlots[0].daysAfterCall = 30;
      expect(seedWorldSchema.safeParse(atLimit).success).toBe(true);

      const over = validSeed();
      over.technicianSlots[0].daysAfterCall = 31;
      expect(seedWorldSchema.safeParse(over).error?.issues.map((i) => i.path)).toEqual([
        ["technicianSlots", 0, "daysAfterCall"],
      ]);
    });
  });

  describe("barangay and account shape", () => {
    // Each case breaks exactly one field and names the path the issue must carry.
    const cases: Array<[string, (s: ReturnType<typeof validSeed>) => void, (string | number)[]]> = [
      ["barangay id not a slug", (s) => renameBarangay(s, "Batasan Hills"), ["barangays", 0, "id"]],
      ["barangay id with trailing dash", (s) => renameBarangay(s, "batasan-"), ["barangays", 0, "id"]],
      ["empty barangay name", (s) => (s.barangays[0].name = ""), ["barangays", 0, "name"]],
      ["empty city", (s) => (s.barangays[1].city = ""), ["barangays", 1, "city"]],
      ["nine-digit account number", (s) => renumberAccount(s, 0, "123456789"), ["accounts", 0, "accountNumber"]],
      ["account number with a dash", (s) => renumberAccount(s, 0, "12345-6789"), ["accounts", 0, "accountNumber"]],
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
