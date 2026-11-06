import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  compilePackSop,
  createInMemorySystems,
  formatMoney,
  loadPack,
  PackValidationError,
} from "@tala/core";

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

  /** The plans DESIGN §4 names, with Kidlat's speeds and monthly prices. */
  it("offers the Kidlat 100, 300, 500 and 1000 plans", () => {
    expect(loadKidlatFiber().plans).toEqual([
      { id: "kidlat-100", name: "Kidlat 100", downloadMbps: 100, monthlyPriceMinor: 129_900 },
      { id: "kidlat-300", name: "Kidlat 300", downloadMbps: 300, monthlyPriceMinor: 169_900 },
      { id: "kidlat-500", name: "Kidlat 500", downloadMbps: 500, monthlyPriceMinor: 209_900 },
      { id: "kidlat-1000", name: "Kidlat 1000", downloadMbps: 1000, monthlyPriceMinor: 299_900 },
    ]);
  });

  /**
   * The seed's bills are a month of each account's plan. The loader cannot
   * require this of every pack (a bill can carry a prorated amount, or an
   * older plan), so it is checked here, on the data Kidlat ships.
   */
  it("bills every account at its plan's monthly price", () => {
    const { plans, world } = loadKidlatFiber();

    for (const account of world.accounts) {
      const plan = plans.find((p) => p.name === account.planName);
      const bills = world.bills.filter((b) => b.accountNumber === account.accountNumber);

      expect(plan, account.planName).toBeDefined();
      expect(bills.length, account.accountNumber).toBeGreaterThan(0);
      for (const bill of bills) expect(bill.amountMinor, bill.reference).toBe(plan?.monthlyPriceMinor);
    }
  });

  describe("its help articles", () => {
    const article = (id: string) => {
      const found = loadKidlatFiber().help.find((a) => a.id === id);
      if (!found) throw new Error(`no help article "${id}"`);
      return found;
    };

    it("covers the modem lights, restarting the modem, the Wi-Fi name and password, paying, slow Wi-Fi in some rooms and moving", () => {
      expect(loadKidlatFiber().help.map((a) => a.id)).toEqual([
        "modem-lights",
        "moving-address",
        "payment-channels",
        "restart-modem",
        "slow-wifi-rooms",
        "wifi-name-password",
      ]);
    });

    it("says what a red or blinking LOS light means, and what to check first", () => {
      const { body } = article("modem-lights");

      for (const light of ["Power", "PON", "LOS", "LAN", "WLAN"]) expect(body).toContain(light);
      expect(body).toMatch(/red/);
      expect(body).toMatch(/blink/);
      expect(body).toMatch(/fiber cable/);
    });

    /** Callers say what they see in Tagalog too: "pulang ilaw", "kumikislap". */
    it("tags the modem lights with the words callers use, in English and Tagalog", () => {
      expect(article("modem-lights").tags).toEqual(
        expect.arrayContaining(["lights", "los", "red", "blinking", "ilaw", "pula", "kumikislap"]),
      );
    });

    it("names each payment channel the billing system knows", () => {
      const { body } = article("payment-channels");

      for (const channel of ["GCash", "Maya", "bank", "7-Eleven", "Bayad"]) expect(body).toContain(channel);
    });

    /** Prices, fees and limits belong to the plan catalog and the policy, never to an article. */
    it("states no amount, price or other figure, and names no plan", () => {
      const { help, plans } = loadKidlatFiber();

      for (const { id, title, body } of help) {
        const text = `${title} ${body}`;
        expect(text.replace(/7-Eleven/g, ""), id).not.toMatch(/\d/);
        expect(text, id).not.toMatch(/₱|peso/i);
        for (const plan of plans) expect(text, id).not.toContain(plan.name);
      }
    });
  });

  /** Kidlat starts an upgrade at once and a downgrade with the next billing cycle. */
  it("states when plan changes take effect from its policy, not from typed text", () => {
    const source = kidlatFiberSource();
    const shipped = compilePackSop(loadPack(source));
    const flipped = compilePackSop(
      loadPack({
        ...source,
        policy: {
          identity: { maxFailedAttempts: 3 },
          planChanges: { upgrade: "next_cycle", downgrade: "now" },
        },
      }),
    );

    expect(shipped).toContain("A move to a faster plan takes effect at once.");
    expect(shipped).toContain("A move to a cheaper plan takes effect when the next billing cycle starts.");
    expect(flipped).toContain("A move to a faster plan takes effect when the next billing cycle starts.");
    expect(flipped).toContain("A move to a cheaper plan takes effect at once.");
    expect(source.sop.body).not.toMatch(/billing cycle starts|at once/);
  });

  it("names its plans and their speeds from its catalog, not from typed text", () => {
    const source = kidlatFiberSource();
    const shipped = compilePackSop(loadPack(source));
    const faster = compilePackSop(
      loadPack({
        ...source,
        plans: (source.plans as { id: string; downloadMbps: number }[]).map((plan) =>
          plan.id === "kidlat-1000" ? { ...plan, downloadMbps: 1200 } : plan,
        ),
      }),
    );

    expect(shipped).toContain("- Kidlat 1000: 1000 Mbps, plan id kidlat-1000");
    expect(faster).toContain("- Kidlat 1000: 1200 Mbps, plan id kidlat-1000");
  });

  it("opens every call by saying Tala is an AI and the call is recorded", () => {
    const { persona } = loadKidlatFiber();

    expect(persona.openingLine).toMatch(/AI assistant/);
    expect(persona.openingLine).toMatch(/record/);
  });

  it("has the lines Tala says when the model calls a tool with nothing said", () => {
    const { persona } = loadKidlatFiber();

    expect(persona.fillerLine).toBe("Sandali lang po, let me check.");
    expect(persona.closingLine).toBe("Thank you for calling Kidlat Fiber po. Ingat po!");
  });

  it("has scenario 1's world: a fiber cut in Batasan Hills with a restoration time", async () => {
    const { world } = loadKidlatFiber();
    const systems = createInMemorySystems(world, new Date("2026-11-06T05:00:00Z"), "Asia/Manila");

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

  /** Issue #10's acceptance test: the seed world supports scenario 2. */
  describe("scenario 2's world: Jose's GCash payment has not posted", () => {
    // 1:00 PM in Manila.
    const CALL_STARTED_AT = new Date("2026-11-06T05:00:00Z");
    const JOSE = "8012345602";
    const GCASH_REFERENCE = "1234567890123";

    function systems() {
      return createInMemorySystems(loadKidlatFiber().world, CALL_STARTED_AT, "Asia/Manila");
    }

    it("has Jose's account, with his registered mobile ending 0102", async () => {
      const jose = await systems().accounts.findAccount(JOSE);

      expect(jose?.holderName).toBe("Jose Dela Cruz");
      expect(jose?.registeredMobile).toBe("+639175550102");
      expect(jose?.status).toBe("active");
    });

    it("has 1,299 pesos past due, with disconnection scheduled for the day after the call", async () => {
      const pack = loadKidlatFiber();
      const balance = await systems().billing.balanceOf(JOSE);

      const currency = { code: pack.company.currency, locale: pack.company.locale };
      expect(formatMoney(balance!.amountDueMinor, currency)).toBe("₱1,299.00");
      expect(balance!.dueAt!.getTime()).toBeLessThan(CALL_STARTED_AT.getTime());
      expect(balance!.disconnectionAt).toEqual(new Date("2026-11-07T05:00:00Z"));
    });

    it("has his 1,299-peso GCash payment from the day before, found by its reference and not yet posted", async () => {
      const payment = await systems().billing.findPayment(JOSE, GCASH_REFERENCE);

      expect(payment).toEqual({
        reference: GCASH_REFERENCE,
        channel: "gcash",
        amountMinor: 129_900,
        paidAt: new Date("2026-11-05T05:00:00Z"),
        posted: false,
      });
    });

    it("gives him a history with a pattern: two monthly bills paid and posted, then the unposted GCash payment", async () => {
      const world = systems();
      const bills = await world.billing.billsFor(JOSE);
      const payments = await world.billing.paymentsFor(JOSE);

      expect(bills.map((b) => b.amountMinor)).toEqual([129_900, 129_900, 129_900]);
      expect(payments.map((p) => [p.channel, p.amountMinor, p.posted])).toEqual([
        ["gcash", 129_900, false],
        ["gcash", 129_900, true],
        ["gcash", 129_900, true],
      ]);
      expect(payments[0].reference).toBe(GCASH_REFERENCE);
      // Each older bill was paid before the next one was issued.
      for (const older of [1, 2]) {
        expect(payments[older].paidAt.getTime()).toBeGreaterThan(bills[older].issuedAt.getTime());
        expect(payments[older].paidAt.getTime()).toBeLessThan(bills[older - 1].issuedAt.getTime());
      }
    });

    it("does not find his payment on anyone else's account", async () => {
      expect(await systems().billing.findPayment("8012345601", GCASH_REFERENCE)).toBeNull();
    });

    it("has Maria current and paid: nothing due, no disconnection", async () => {
      expect(await systems().billing.balanceOf("8012345601")).toEqual({
        amountDueMinor: 0,
        dueAt: null,
        disconnectionAt: null,
      });
    });
  });

  /** Issue #11's acceptance test: the seed world supports scenario 3. */
  describe("scenario 3's world: Ana's line is slow, and a reboot does not fix it", () => {
    // 1:00 PM, Fri, Nov 6 in Manila.
    const CALL_STARTED_AT = new Date("2026-11-06T05:00:00Z");
    const ANA = "8012345603";
    const JOSE = "8012345602";
    const DAY_MS = 86_400_000;

    function systems() {
      return createInMemorySystems(loadKidlatFiber().world, CALL_STARTED_AT, "Asia/Manila");
    }

    it("has Ana's account in San Antonio, Pasig, with her registered mobile ending 0103", async () => {
      const ana = await systems().accounts.findAccount(ANA);

      expect(ana?.holderName).toBe("Ana Reyes");
      expect(ana?.registeredMobile).toBe("+639175550103");
      expect(ana?.serviceArea).toEqual({
        barangayId: "san-antonio",
        barangayName: "San Antonio",
        city: "Pasig",
      });
    });

    it("has no outage in San Antonio, so the slowness is on her line", async () => {
      expect(await systems().network.outagesAffecting("san-antonio")).toEqual([]);
    });

    it("diagnoses her line as degraded at about -28 dBm, with high signal loss a reboot may clear", async () => {
      const diagnosis = await systems().network.diagnose(ANA);

      expect(diagnosis?.modemStatus).toBe("degraded");
      expect(diagnosis?.receivedPowerDbm).toBeCloseTo(-28, 0);
      expect(diagnosis?.fault).toBe("high signal loss on the fiber line");
      expect(diagnosis?.rebootMayClear).toBe(true);
    });

    it("still finds the signal loss once a remote reboot of at most three minutes is over", async () => {
      const world = systems();
      const reboot = await world.network.rebootModem(ANA, CALL_STARTED_AT);

      expect(reboot?.restartSeconds).toBeGreaterThan(0);
      expect(reboot?.restartSeconds).toBeLessThanOrEqual(180);
      expect(await world.network.diagnose(ANA)).toMatchObject({
        modemStatus: "degraded",
        fault: "high signal loss on the fiber line",
        rebootMayClear: false,
      });
    });

    it("clears Jose's hung modem with a reboot, so both outcomes are seeded", async () => {
      const world = systems();
      expect(await world.network.diagnose(JOSE)).toMatchObject({
        fault: expect.stringMatching(/hung/) as unknown,
        rebootMayClear: true,
      });

      await world.network.rebootModem(JOSE, CALL_STARTED_AT);

      expect(await world.network.diagnose(JOSE)).toMatchObject({ modemStatus: "online", fault: null });
    });

    it("has at least four open technician windows in San Antonio over the next few days", async () => {
      const slots = await systems().fieldService.availableSlots("san-antonio");

      expect(slots.length).toBeGreaterThanOrEqual(4);
      for (const slot of slots) {
        expect(slot.startsAt.getTime()).toBeGreaterThan(CALL_STARTED_AT.getTime());
        expect(slot.startsAt.getTime()).toBeLessThan(CALL_STARTED_AT.getTime() + 5 * DAY_MS);
      }
    });

    it("has a couple of open windows in each of the other barangays", async () => {
      const world = systems();

      expect(await world.fieldService.availableSlots("batasan-hills")).toHaveLength(2);
      expect(await world.fieldService.availableSlots("commonwealth")).toHaveLength(2);
    });
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
    cpSync(join(here, "help"), join(dir, "help"), { recursive: true });
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
