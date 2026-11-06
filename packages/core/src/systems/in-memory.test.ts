import { describe, expect, it } from "vitest";
import { TEST_COMPANY, testPlans } from "../testing/fixtures";

import { createInMemorySystems } from "./in-memory";
import type { SeedWorld } from "./seed-world";

/** 2:00 PM, Fri, Nov 6 in Manila. */
const CALL_STARTED_AT = new Date("2026-11-06T06:00:00Z");
/** The company's time zone, which technician slots are stated in. */
const MANILA = TEST_COMPANY.timeZone;

/**
 * Two barangays; Batasan Hills has a fiber cut, Commonwealth has none.
 * Maria owes 1,299 pesos, past due, with a disconnection scheduled, and her
 * GCash payment from yesterday has not posted. Jun owes nothing. A technician
 * can visit Batasan Hills on the two days after the call, Commonwealth on one.
 */
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
      {
        accountNumber: "2234567890",
        holderName: "Jun Reyes",
        registeredMobile: "+639175550102",
        status: "active",
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
    balances: [
      {
        accountNumber: "1234567890",
        amountDueMinor: 129_900,
        dueMinutesBeforeCall: 14_400,
        disconnectionMinutesAfterCall: 1_440,
      },
      {
        accountNumber: "2234567890",
        amountDueMinor: 0,
        dueMinutesBeforeCall: null,
        disconnectionMinutesAfterCall: null,
      },
    ],
    bills: [
      { reference: "SOA-2609-7890", accountNumber: "1234567890", amountMinor: 129_900, issuedMinutesBeforeCall: 43_200 },
      { reference: "SOA-2610-8890", accountNumber: "2234567890", amountMinor: 99_900, issuedMinutesBeforeCall: 36_000 },
      { reference: "SOA-2610-7890", accountNumber: "1234567890", amountMinor: 129_900, issuedMinutesBeforeCall: 36_000 },
    ],
    payments: [
      {
        reference: "BNK20261001",
        accountNumber: "1234567890",
        channel: "bank",
        amountMinor: 129_900,
        paidMinutesBeforeCall: 30_000,
        posted: true,
      },
      {
        reference: "MAYA7K2Q9",
        accountNumber: "2234567890",
        channel: "maya",
        amountMinor: 99_900,
        paidMinutesBeforeCall: 20_160,
        posted: true,
      },
      {
        reference: "1234567890123",
        accountNumber: "1234567890",
        channel: "gcash",
        amountMinor: 129_900,
        paidMinutesBeforeCall: 1_440,
        posted: false,
      },
    ],
    // Maria's line has lost signal, and a reboot leaves it so; Jun's modem has
    // hung, and a reboot clears it.
    modems: [
      {
        accountNumber: "1234567890",
        status: "degraded",
        receivedPowerDbm: -28.4,
        lastSeenMinutesBeforeCall: 2,
        fault: "high signal loss on the fiber line",
        rebootMayClear: true,
        restartSeconds: 90,
        afterReboot: {
          status: "degraded",
          receivedPowerDbm: -28.3,
          fault: "high signal loss on the fiber line",
          rebootMayClear: false,
        },
      },
      {
        accountNumber: "2234567890",
        status: "degraded",
        receivedPowerDbm: -19.5,
        lastSeenMinutesBeforeCall: 5,
        fault: "the modem has hung and is not passing traffic",
        rebootMayClear: true,
        restartSeconds: 60,
        afterReboot: { status: "online", receivedPowerDbm: -19.4, fault: null, rebootMayClear: false },
      },
    ],
    // Out of order on purpose: the world lists them soonest first.
    technicianSlots: [
      { id: "batasan-hills-2", barangayId: "batasan-hills", daysAfterCall: 2, startHour: 13, lengthHours: 3 },
      { id: "commonwealth-1", barangayId: "commonwealth", daysAfterCall: 1, startHour: 9, lengthHours: 3 },
      { id: "batasan-hills-1", barangayId: "batasan-hills", daysAfterCall: 1, startHour: 9, lengthHours: 3 },
    ],
  };
}

/** The pack's data the world is built from, around this seed. */
const dataFor = (world: SeedWorld) => ({ world, plans: testPlans() });

describe("createInMemorySystems", () => {
  describe("accounts.findAccount", () => {
    it("returns the account with its service area resolved", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.accounts.findAccount("1234567890")).toEqual({
        accountNumber: "1234567890",
        holderName: "Maria Santos",
        registeredMobile: "+639175550101",
        status: "active",
        planId: "kidlat-300",
        serviceArea: {
          barangayId: "batasan-hills",
          barangayName: "Batasan Hills",
          city: "Quezon City",
        },
      });
    });
    it("returns null for an unknown number and for a near miss", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.accounts.findAccount("9999999999")).toBeNull();
      expect(await systems.accounts.findAccount("123456789")).toBeNull();
      expect(await systems.accounts.findAccount("1234567890 ")).toBeNull();
    });

    it("hands back a copy: mutating it changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const first = await systems.accounts.findAccount("1234567890");
      first!.holderName = "Someone Else";
      first!.serviceArea.city = "Manila";
      const second = await systems.accounts.findAccount("1234567890");
      expect(second!.holderName).toBe("Maria Santos");
      expect(second!.serviceArea.city).toBe("Quezon City");
    });

    /** The pack's boot check makes every seeded plan name a catalog plan; the world matches ids after. */
    it("refuses to build from a seed whose plan name is not in the catalog", () => {
      const world = seed();
      world.accounts[1].planName = "Kidlat 200";
      expect(() => createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA)).toThrow(
        'account 2234567890 names unknown plan "Kidlat 200"',
      );
    });

    it("rejects, rather than serving a half record, when a seed skipped the schema and dangles", async () => {
      const world = seed();
      world.accounts[0].barangayId = "payatas";
      const systems = createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA);
      await expect(systems.accounts.findAccount("1234567890")).rejects.toThrow(/payatas/);
    });

    it("gives each call a fresh world: two systems from one seed share nothing", async () => {
      const shared = seed();
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      const two = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
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
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
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
      const systems = createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA);
      const refs = (await systems.network.outagesAffecting("batasan-hills")).map((o) => o.reference);
      expect(refs).toEqual(["OLDEST", "TIE-A", "TIE-B", "RECENT"]);
    });

    it("reports a null restoration time when the network team has none", async () => {
      const world = seed();
      world.outages[0].restorationMinutesAfterCall = null;
      const systems = createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA);
      const [outage] = await systems.network.outagesAffecting("batasan-hills");
      expect(outage.estimatedRestorationAt).toBeNull();
      expect(outage.startedAt).toEqual(new Date("2026-11-06T03:30:00Z"));
    });

    it("returns an empty list for a barangay with no outage and for an unknown one", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.network.outagesAffecting("commonwealth")).toEqual([]);
      expect(await systems.network.outagesAffecting("atlantis")).toEqual([]);
    });

    it("lists a multi-barangay outage under each of its barangays", async () => {
      const world = seed();
      world.outages[0].barangayIds = ["batasan-hills", "commonwealth"];
      const systems = createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA);
      expect(await systems.network.outagesAffecting("commonwealth")).toHaveLength(1);
      expect(await systems.network.outagesAffecting("batasan-hills")).toHaveLength(1);
    });

    it("hands back copies: mutating a result changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
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
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      shared.outages[0].cause = "edited after creation";
      const two = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      expect((await one.network.outagesAffecting("batasan-hills"))[0].cause).toBe(
        "fiber cut along Batasan Road from road works",
      );
      expect((await two.network.outagesAffecting("batasan-hills"))[0].cause).toBe("edited after creation");
    });

    it("follows the call's start, not the wall clock", async () => {
      const later = new Date("2031-02-14T22:15:00Z");
      const systems = createInMemorySystems(dataFor(seed()), later, MANILA);
      const [outage] = await systems.network.outagesAffecting("batasan-hills");
      expect(outage.startedAt).toEqual(new Date("2031-02-14T19:45:00Z"));
      expect(outage.estimatedRestorationAt).toEqual(new Date("2031-02-14T23:45:00Z"));
    });
  });

  /**
   * The network's own diagnosis of a connection, and a remote reboot. The
   * world never reads a clock: it is told when the reboot was asked for, and
   * a diagnosis afterwards reads the modem as it came back.
   */
  describe("network.diagnose and network.rebootModem", () => {
    it("diagnoses a modem as the seed states it, last seen relative to the call's start", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.network.diagnose("1234567890")).toEqual({
        modemStatus: "degraded",
        receivedPowerDbm: -28.4,
        lastSeenAt: new Date("2026-11-06T05:58:00Z"),
        fault: "high signal loss on the fiber line",
        rebootMayClear: true,
      });
    });

    it("returns null for an account with no modem on record, to diagnose or to reboot", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.network.diagnose("9999999999")).toBeNull();
      expect(await systems.network.rebootModem("9999999999", CALL_STARTED_AT)).toBeNull();
    });

    it("says how long a restart takes, then reads the modem as it came back, with the fault cleared", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const askedAt = new Date("2026-11-06T06:03:00Z");

      expect(await systems.network.rebootModem("2234567890", askedAt)).toEqual({ restartSeconds: 60 });
      expect(await systems.network.diagnose("2234567890")).toEqual({
        modemStatus: "online",
        receivedPowerDbm: -19.4,
        lastSeenAt: new Date("2026-11-06T06:04:00Z"),
        fault: null,
        rebootMayClear: false,
      });
    });

    it("still reads a fault the reboot does not clear once the modem is back", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const askedAt = new Date("2026-11-06T06:03:00Z");

      expect(await systems.network.rebootModem("1234567890", askedAt)).toEqual({ restartSeconds: 90 });
      expect(await systems.network.diagnose("1234567890")).toEqual({
        modemStatus: "degraded",
        receivedPowerDbm: -28.3,
        lastSeenAt: new Date("2026-11-06T06:04:30Z"),
        fault: "high signal loss on the fiber line",
        rebootMayClear: false,
      });
    });

    it("reboots only the account it is asked to", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      await systems.network.rebootModem("2234567890", CALL_STARTED_AT);
      expect((await systems.network.diagnose("1234567890"))?.receivedPowerDbm).toBe(-28.4);
    });

    it("hands back copies: mutating a diagnosis changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const first = await systems.network.diagnose("1234567890");
      first!.fault = "tampered";
      first!.lastSeenAt.setUTCFullYear(1999);
      const second = await systems.network.diagnose("1234567890");
      expect(second!.fault).toBe("high signal loss on the fiber line");
      expect(second!.lastSeenAt).toEqual(new Date("2026-11-06T05:58:00Z"));
    });

    it("keeps a reboot on one call out of another call from the same seed", async () => {
      const shared = seed();
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      const two = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      await one.network.rebootModem("2234567890", CALL_STARTED_AT);
      expect((await two.network.diagnose("2234567890"))?.modemStatus).toBe("degraded");
    });
  });

  describe("billing.balanceOf", () => {
    it("anchors the due date and the disconnection to the call's start", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.balanceOf("1234567890")).toEqual({
        amountDueMinor: 129_900,
        dueAt: new Date("2026-10-27T06:00:00Z"),
        disconnectionAt: new Date("2026-11-07T06:00:00Z"),
      });
    });

    it("reports nulls for an account that owes nothing", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.balanceOf("2234567890")).toEqual({
        amountDueMinor: 0,
        dueAt: null,
        disconnectionAt: null,
      });
    });

    it("returns null for an account with no balance on record", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.balanceOf("9999999999")).toBeNull();
    });

    it("hands back a copy: mutating it changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const first = await systems.billing.balanceOf("1234567890");
      first!.amountDueMinor = 0;
      first!.disconnectionAt!.setUTCFullYear(1999);
      expect(await systems.billing.balanceOf("1234567890")).toEqual({
        amountDueMinor: 129_900,
        dueAt: new Date("2026-10-27T06:00:00Z"),
        disconnectionAt: new Date("2026-11-07T06:00:00Z"),
      });
    });
  });

  describe("billing.billsFor and billing.paymentsFor", () => {
    it("lists only this account's bills, newest first", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.billsFor("1234567890")).toEqual([
        { reference: "SOA-2610-7890", amountMinor: 129_900, issuedAt: new Date("2026-10-12T06:00:00Z") },
        { reference: "SOA-2609-7890", amountMinor: 129_900, issuedAt: new Date("2026-10-07T06:00:00Z") },
      ]);
    });

    it("lists only this account's payments, newest first, with whether each has posted", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.paymentsFor("1234567890")).toEqual([
        {
          reference: "1234567890123",
          channel: "gcash",
          amountMinor: 129_900,
          paidAt: new Date("2026-11-05T06:00:00Z"),
          posted: false,
        },
        {
          reference: "BNK20261001",
          channel: "bank",
          amountMinor: 129_900,
          paidAt: new Date("2026-10-16T10:00:00Z"),
          posted: true,
        },
      ]);
    });

    it("keeps seed order for equal times", async () => {
      const world = seed();
      world.payments[0].paidMinutesBeforeCall = 1_440;
      const systems = createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA);
      const refs = (await systems.billing.paymentsFor("1234567890")).map((p) => p.reference);
      expect(refs).toEqual(["BNK20261001", "1234567890123"]);
    });

    it("returns empty lists for an unknown account", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.billsFor("9999999999")).toEqual([]);
      expect(await systems.billing.paymentsFor("9999999999")).toEqual([]);
    });

    it("hands back copies: mutating a result changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const [bill] = await systems.billing.billsFor("1234567890");
      bill.amountMinor = 1;
      bill.issuedAt.setUTCFullYear(1999);
      const [payment] = await systems.billing.paymentsFor("1234567890");
      payment.posted = true;
      payment.paidAt.setUTCFullYear(1999);
      expect((await systems.billing.billsFor("1234567890"))[0]).toEqual({
        reference: "SOA-2610-7890",
        amountMinor: 129_900,
        issuedAt: new Date("2026-10-12T06:00:00Z"),
      });
      const [again] = await systems.billing.paymentsFor("1234567890");
      expect(again.posted).toBe(false);
      expect(again.paidAt).toEqual(new Date("2026-11-05T06:00:00Z"));
    });
  });

  describe("billing.findPayment", () => {
    it("finds a payment by its exact reference on the account it was made to", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.findPayment("1234567890", "1234567890123")).toEqual({
        reference: "1234567890123",
        channel: "gcash",
        amountMinor: 129_900,
        paidAt: new Date("2026-11-05T06:00:00Z"),
        posted: false,
      });
    });

    it("does not find another account's payment", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.findPayment("2234567890", "1234567890123")).toBeNull();
      expect(await systems.billing.findPayment("1234567890", "MAYA7K2Q9")).toBeNull();
    });

    it("returns null for an unknown reference and for a near miss", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.billing.findPayment("1234567890", "9999999999999")).toBeNull();
      expect(await systems.billing.findPayment("1234567890", "123456789012")).toBeNull();
      expect(await systems.billing.findPayment("1234567890", "1234 567890123")).toBeNull();
    });
  });

  describe("tickets.createTicket", () => {
    const BILLING_TICKET = {
      accountNumber: "1234567890",
      category: "billing",
      notes: "GCash payment from yesterday has not posted; please post it.",
    } as const;
    /** 2:05 PM in Manila, five minutes into the call. */
    const OPENED_AT = new Date("2026-11-06T06:05:00Z");

    it("numbers the call's tickets in order, in the call's year", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.tickets.createTicket(BILLING_TICKET, OPENED_AT)).toEqual({
        reference: "TKT-2026-00001",
      });
      expect(
        await systems.tickets.createTicket({ ...BILLING_TICKET, category: "other" }, OPENED_AT),
      ).toEqual({ reference: "TKT-2026-00002" });
    });

    it("keeps what was opened, and when, oldest first, as copies", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      await systems.tickets.createTicket(BILLING_TICKET, OPENED_AT);
      const [opened] = systems.openedTickets();
      opened.notes = "tampered";
      opened.openedAt.setUTCFullYear(1999);
      expect(systems.openedTickets()).toEqual([
        { reference: "TKT-2026-00001", ...BILLING_TICKET, openedAt: OPENED_AT },
      ]);
    });

    it("starts each call's numbering afresh, and follows the call's start", async () => {
      const shared = seed();
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      await one.tickets.createTicket(BILLING_TICKET, OPENED_AT);
      const two = createInMemorySystems(dataFor(shared), new Date("2031-02-14T22:15:00Z"), MANILA);
      expect(await two.tickets.createTicket(BILLING_TICKET, OPENED_AT)).toEqual({
        reference: "TKT-2031-00001",
      });
      expect(two.openedTickets()).toHaveLength(1);
    });

    /** 12:30 AM on New Year's Day in Manila is still the old year in UTC. */
    it("numbers tickets and visits in the year of the call's start in the company's time zone", async () => {
      const newYear = new Date("2026-12-31T16:30:00Z");
      const systems = createInMemorySystems(dataFor(seed()), newYear, MANILA);

      expect(await systems.tickets.createTicket(BILLING_TICKET, newYear)).toEqual({
        reference: "TKT-2027-00001",
      });
      expect(
        await systems.fieldService.bookVisit({
          accountNumber: "1234567890",
          slotId: "batasan-hills-1",
          ticketReference: "TKT-2027-00001",
        }),
      ).toEqual({ reference: "VIS-2027-00001" });
    });
  });

  describe("tickets.findTicket", () => {
    const CONNECTION_TICKET = {
      accountNumber: "1234567890",
      category: "connection",
      notes: "Signal loss on the line; a remote reboot did not clear it.",
    } as const;

    it("finds a ticket by its exact reference, with when it was opened", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const openedAt = new Date("2026-11-06T06:05:00Z");
      const { reference } = await systems.tickets.createTicket(CONNECTION_TICKET, openedAt);

      expect(await systems.tickets.findTicket("1234567890", reference)).toEqual({
        reference: "TKT-2026-00001",
        category: "connection",
        notes: "Signal loss on the line; a remote reboot did not clear it.",
        openedAt,
      });
    });

    it("does not find another account's ticket, or a reference never given", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.tickets.createTicket(CONNECTION_TICKET, CALL_STARTED_AT);

      expect(await systems.tickets.findTicket("2234567890", reference)).toBeNull();
      expect(await systems.tickets.findTicket("1234567890", "TKT-2026-00002")).toBeNull();
    });

    it("hands back a copy: mutating it changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.tickets.createTicket(CONNECTION_TICKET, CALL_STARTED_AT);
      const found = await systems.tickets.findTicket("1234567890", reference);
      found!.openedAt.setUTCFullYear(1999);

      expect((await systems.tickets.findTicket("1234567890", reference))?.openedAt).toEqual(
        CALL_STARTED_AT,
      );
    });
  });

  /** Quotes for plan changes, and the changes made with them. */
  describe("plans", () => {
    /** Maria, from Kidlat 300 to Kidlat 500, priced five minutes into the call. */
    const QUOTE = {
      accountNumber: "1234567890",
      currentPlanId: "kidlat-300",
      newPlanId: "kidlat-500",
      newMonthlyPriceMinor: 209_900,
      proratedAmountMinor: 7_742,
      effectiveAt: new Date("2026-11-06T06:05:00Z"),
    };
    const QUOTED_AT = new Date("2026-11-06T06:05:00Z");

    it("numbers the call's quotes in order, in the call's year", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);

      expect(await systems.plans.createQuote(QUOTE, QUOTED_AT)).toEqual({
        reference: "QTE-2026-00001",
      });
      expect(await systems.plans.createQuote(QUOTE, QUOTED_AT)).toEqual({
        reference: "QTE-2026-00002",
      });
    });

    /** 12:30 AM on New Year's Day in Manila is still the old year in UTC. */
    it("numbers quotes in the year of the call's start in the company's time zone", async () => {
      const newYear = new Date("2026-12-31T16:30:00Z");
      const systems = createInMemorySystems(dataFor(seed()), newYear, MANILA);

      expect(await systems.plans.createQuote(QUOTE, newYear)).toEqual({ reference: "QTE-2027-00001" });
    });

    it("finds a quote by its exact reference, with when it was made, not yet used", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(QUOTE, QUOTED_AT);

      expect(await systems.plans.findQuote("1234567890", reference)).toEqual({
        reference: "QTE-2026-00001",
        ...QUOTE,
        quotedAt: QUOTED_AT,
        used: false,
      });
    });

    it("does not find another account's quote, or a reference never given", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(QUOTE, QUOTED_AT);

      expect(await systems.plans.findQuote("2234567890", reference)).toBeNull();
      expect(await systems.plans.findQuote("1234567890", "QTE-2026-00002")).toBeNull();
    });

    it("hands back a copy, and keeps one: mutating either changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const given = { ...QUOTE, effectiveAt: new Date(QUOTE.effectiveAt) };
      const { reference } = await systems.plans.createQuote(given, QUOTED_AT);
      given.effectiveAt.setUTCFullYear(1999);
      const found = await systems.plans.findQuote("1234567890", reference);
      found!.quotedAt.setUTCFullYear(1999);
      found!.newPlanId = "kidlat-1000";

      expect(await systems.plans.findQuote("1234567890", reference)).toMatchObject({
        newPlanId: "kidlat-500",
        effectiveAt: QUOTE.effectiveAt,
        quotedAt: QUOTED_AT,
      });
    });

    it("moves the account to the quote's plan at once when the quote is in effect, and marks it used", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(QUOTE, QUOTED_AT);

      await systems.plans.applyQuote("1234567890", reference, QUOTED_AT);

      expect((await systems.accounts.findAccount("1234567890"))?.planId).toBe("kidlat-500");
      expect(await systems.plans.findQuote("1234567890", reference)).toMatchObject({ used: true });
      expect(await systems.plans.scheduledChange("1234567890")).toBeNull();
    });

    /** Maria, from Kidlat 300 down to Kidlat 100, starting with her next billing cycle. */
    const LATER = { ...QUOTE, newPlanId: "kidlat-100", effectiveAt: new Date("2026-11-12T06:00:00Z") };

    it("schedules a quote that takes effect later, and keeps the account on its plan until then", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(LATER, QUOTED_AT);

      await systems.plans.applyQuote("1234567890", reference, QUOTED_AT);

      expect((await systems.accounts.findAccount("1234567890"))?.planId).toBe("kidlat-300");
      expect(await systems.plans.scheduledChange("1234567890")).toEqual({
        planId: "kidlat-100",
        effectiveAt: new Date("2026-11-12T06:00:00Z"),
      });
      expect(await systems.plans.findQuote("1234567890", reference)).toMatchObject({ used: true });
    });

    it("has no scheduled change for an account until one is made, nor for anyone else", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      expect(await systems.plans.scheduledChange("1234567890")).toBeNull();

      const { reference } = await systems.plans.createQuote(LATER, QUOTED_AT);
      await systems.plans.applyQuote("1234567890", reference, QUOTED_AT);

      expect(await systems.plans.scheduledChange("2234567890")).toBeNull();
    });

    /** One change at a time: the latest one made is the one that holds. */
    it("drops a scheduled change when a change is made at once", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const later = await systems.plans.createQuote(LATER, QUOTED_AT);
      await systems.plans.applyQuote("1234567890", later.reference, QUOTED_AT);
      const now = await systems.plans.createQuote(QUOTE, QUOTED_AT);

      await systems.plans.applyQuote("1234567890", now.reference, QUOTED_AT);

      expect((await systems.accounts.findAccount("1234567890"))?.planId).toBe("kidlat-500");
      expect(await systems.plans.scheduledChange("1234567890")).toBeNull();
    });

    it("hands back a copy of the scheduled change: mutating it changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(LATER, QUOTED_AT);
      await systems.plans.applyQuote("1234567890", reference, QUOTED_AT);
      const scheduled = await systems.plans.scheduledChange("1234567890");
      scheduled!.effectiveAt.setUTCFullYear(1999);
      scheduled!.planId = "kidlat-1000";

      expect(await systems.plans.scheduledChange("1234567890")).toEqual({
        planId: "kidlat-100",
        effectiveAt: new Date("2026-11-12T06:00:00Z"),
      });
    });

    it("rejects a quote already used, so one quote changes a plan once", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(QUOTE, QUOTED_AT);
      await systems.plans.applyQuote("1234567890", reference, QUOTED_AT);
      await systems.plans.createQuote(
        { ...QUOTE, currentPlanId: "kidlat-500", newPlanId: "kidlat-100" },
        QUOTED_AT,
      );

      await expect(systems.plans.applyQuote("1234567890", reference, QUOTED_AT)).rejects.toThrow(
        'quote "QTE-2026-00001" cannot be applied',
      );
      expect((await systems.accounts.findAccount("1234567890"))?.planId).toBe("kidlat-500");
    });

    it("rejects another account's quote, or a reference never given, and changes no plan", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const { reference } = await systems.plans.createQuote(QUOTE, QUOTED_AT);

      await expect(systems.plans.applyQuote("2234567890", reference, QUOTED_AT)).rejects.toThrow(
        'quote "QTE-2026-00001" cannot be applied',
      );
      await expect(systems.plans.applyQuote("1234567890", "QTE-2026-00009", QUOTED_AT)).rejects.toThrow(
        'quote "QTE-2026-00009" cannot be applied',
      );
      expect((await systems.accounts.findAccount("1234567890"))?.planId).toBe("kidlat-300");
      expect((await systems.accounts.findAccount("2234567890"))?.planId).toBe("kidlat-100");
    });

    it("changes the plan in this call's copy only, never in the seed", async () => {
      const shared = seed();
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      const { reference } = await one.plans.createQuote(QUOTE, QUOTED_AT);
      await one.plans.applyQuote("1234567890", reference, QUOTED_AT);

      const two = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      expect(shared.accounts[0].planName).toBe("Kidlat 300");
      expect((await two.accounts.findAccount("1234567890"))?.planId).toBe("kidlat-300");
      expect(await two.plans.findQuote("1234567890", reference)).toBeNull();
    });
  });

  /**
   * The technician calendar, stated in the seed by the day after the call's
   * local date, and the visits booked from it.
   */
  describe("fieldService", () => {
    const VISIT = {
      accountNumber: "1234567890",
      slotId: "batasan-hills-1",
      ticketReference: "TKT-2026-00001",
    };

    it("lists a barangay's open slots, soonest first, in the company's time zone", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);

      expect(await systems.fieldService.availableSlots("batasan-hills")).toEqual([
        {
          slotId: "batasan-hills-1",
          barangayId: "batasan-hills",
          // 9:00 AM to 12:00 PM, Sat, Nov 7 in Manila.
          startsAt: new Date("2026-11-07T01:00:00Z"),
          endsAt: new Date("2026-11-07T04:00:00Z"),
        },
        {
          slotId: "batasan-hills-2",
          barangayId: "batasan-hills",
          // 1:00 PM to 4:00 PM, Sun, Nov 8 in Manila.
          startsAt: new Date("2026-11-08T05:00:00Z"),
          endsAt: new Date("2026-11-08T08:00:00Z"),
        },
      ]);
    });

    it("anchors the slots to the call's date in the time zone it is given", async () => {
      // 1:00 AM, Fri, Nov 6 in New York: 9:00 AM the next day is 2:00 PM UTC.
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, "America/New_York");

      const [first] = await systems.fieldService.availableSlots("commonwealth");
      expect(first.startsAt).toEqual(new Date("2026-11-07T14:00:00Z"));
    });

    it("returns an empty list for a barangay with no slots and for an unknown one", async () => {
      const world = seed();
      world.technicianSlots = world.technicianSlots.filter((s) => s.barangayId !== "commonwealth");
      const systems = createInMemorySystems(dataFor(world), CALL_STARTED_AT, MANILA);

      expect(await systems.fieldService.availableSlots("commonwealth")).toEqual([]);
      expect(await systems.fieldService.availableSlots("atlantis")).toEqual([]);
    });

    it("books a slot for its ticket, numbers the call's visits, and takes the slot off the list", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);

      expect(await systems.fieldService.bookVisit(VISIT)).toEqual({ reference: "VIS-2026-00001" });
      expect(
        await systems.fieldService.bookVisit({ ...VISIT, slotId: "batasan-hills-2" }),
      ).toEqual({ reference: "VIS-2026-00002" });
      expect(systems.bookedVisits()).toEqual([
        { reference: "VIS-2026-00001", ...VISIT },
        { reference: "VIS-2026-00002", ...VISIT, slotId: "batasan-hills-2" },
      ]);
      expect(await systems.fieldService.availableSlots("batasan-hills")).toEqual([]);
    });

    it("refuses a slot already booked or unknown, so two visits never share one", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      await systems.fieldService.bookVisit(VISIT);

      await expect(systems.fieldService.bookVisit(VISIT)).rejects.toThrow(
        'technician slot "batasan-hills-1" is not available',
      );
      await expect(
        systems.fieldService.bookVisit({ ...VISIT, slotId: "atlantis-1" }),
      ).rejects.toThrow('technician slot "atlantis-1" is not available');
      expect(systems.bookedVisits()).toHaveLength(1);
    });

    it("hands back copies: mutating a slot or a booking changes nothing stored", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      const [slot] = await systems.fieldService.availableSlots("batasan-hills");
      slot.startsAt.setUTCFullYear(1999);
      const [again] = await systems.fieldService.availableSlots("batasan-hills");
      expect(again.startsAt).toEqual(new Date("2026-11-07T01:00:00Z"));

      await systems.fieldService.bookVisit(VISIT);
      systems.bookedVisits()[0].ticketReference = "tampered";
      expect(systems.bookedVisits()[0].ticketReference).toBe("TKT-2026-00001");
    });

    it("finds the visit booked for a ticket, on its own account only", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      await systems.fieldService.bookVisit(VISIT);

      expect(await systems.fieldService.visitForTicket("1234567890", "TKT-2026-00001")).toEqual({
        reference: "VIS-2026-00001",
      });
      expect(await systems.fieldService.visitForTicket("2234567890", "TKT-2026-00001")).toBeNull();
      expect(await systems.fieldService.visitForTicket("1234567890", "TKT-2026-00002")).toBeNull();
    });

    it("keeps one call's bookings out of another call from the same seed", async () => {
      const shared = seed();
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      const two = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      await one.fieldService.bookVisit(VISIT);

      expect(two.bookedVisits()).toEqual([]);
      expect(await two.fieldService.availableSlots("batasan-hills")).toHaveLength(2);
    });
  });

  describe("sms.send", () => {
    it("puts the text in the outbox, addressed as given", async () => {
      const systems = createInMemorySystems(dataFor(seed()), CALL_STARTED_AT, MANILA);
      await systems.sms.send({ to: "+639175550101", message: "Your ticket is TKT-2026-00001." });
      expect(systems.outbox()).toEqual([
        { to: "+639175550101", message: "Your ticket is TKT-2026-00001." },
      ]);
    });

    it("hands back copies, and gives each call its own outbox", async () => {
      const shared = seed();
      const one = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      const two = createInMemorySystems(dataFor(shared), CALL_STARTED_AT, MANILA);
      await one.sms.send({ to: "+639175550101", message: "Hello po." });
      one.outbox()[0].to = "+639990000000";
      expect(one.outbox()).toEqual([{ to: "+639175550101", message: "Hello po." }]);
      expect(two.outbox()).toEqual([]);
    });
  });
});
