import { describe, expect, it } from "vitest";
import { createInMemorySystems } from "./in-memory";
import type { SeedWorld } from "./seed-world";

const CALL_STARTED_AT = new Date("2026-11-06T06:00:00Z");

/**
 * Two barangays; Batasan Hills has a fiber cut, Commonwealth has none.
 * Maria owes 1,299 pesos, past due, with a disconnection scheduled, and her
 * GCash payment from yesterday has not posted. Jun owes nothing.
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
    modems: [],
    technicianSlots: [],
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

  describe("billing.balanceOf", () => {
    it("anchors the due date and the disconnection to the call's start", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.balanceOf("1234567890")).toEqual({
        amountDueMinor: 129_900,
        dueAt: new Date("2026-10-27T06:00:00Z"),
        disconnectionAt: new Date("2026-11-07T06:00:00Z"),
      });
    });

    it("reports nulls for an account that owes nothing", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.balanceOf("2234567890")).toEqual({
        amountDueMinor: 0,
        dueAt: null,
        disconnectionAt: null,
      });
    });

    it("returns null for an account with no balance on record", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.balanceOf("9999999999")).toBeNull();
    });

    it("hands back a copy: mutating it changes nothing stored", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
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
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.billsFor("1234567890")).toEqual([
        { reference: "SOA-2610-7890", amountMinor: 129_900, issuedAt: new Date("2026-10-12T06:00:00Z") },
        { reference: "SOA-2609-7890", amountMinor: 129_900, issuedAt: new Date("2026-10-07T06:00:00Z") },
      ]);
    });

    it("lists only this account's payments, newest first, with whether each has posted", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
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
      const systems = createInMemorySystems(world, CALL_STARTED_AT);
      const refs = (await systems.billing.paymentsFor("1234567890")).map((p) => p.reference);
      expect(refs).toEqual(["BNK20261001", "1234567890123"]);
    });

    it("returns empty lists for an unknown account", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.billsFor("9999999999")).toEqual([]);
      expect(await systems.billing.paymentsFor("9999999999")).toEqual([]);
    });

    it("hands back copies: mutating a result changes nothing stored", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
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
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.findPayment("1234567890", "1234567890123")).toEqual({
        reference: "1234567890123",
        channel: "gcash",
        amountMinor: 129_900,
        paidAt: new Date("2026-11-05T06:00:00Z"),
        posted: false,
      });
    });

    it("does not find another account's payment", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.billing.findPayment("2234567890", "1234567890123")).toBeNull();
      expect(await systems.billing.findPayment("1234567890", "MAYA7K2Q9")).toBeNull();
    });

    it("returns null for an unknown reference and for a near miss", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
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

    it("numbers the call's tickets in order, in the call's year", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      expect(await systems.tickets.createTicket(BILLING_TICKET)).toEqual({ reference: "TKT-2026-00001" });
      expect(await systems.tickets.createTicket({ ...BILLING_TICKET, category: "other" })).toEqual({
        reference: "TKT-2026-00002",
      });
    });

    it("keeps what was opened, oldest first, as copies", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      await systems.tickets.createTicket(BILLING_TICKET);
      const [opened] = systems.openedTickets();
      opened.notes = "tampered";
      expect(systems.openedTickets()).toEqual([{ reference: "TKT-2026-00001", ...BILLING_TICKET }]);
    });

    it("starts each call's numbering afresh, and follows the call's start", async () => {
      const shared = seed();
      const one = createInMemorySystems(shared, CALL_STARTED_AT);
      await one.tickets.createTicket(BILLING_TICKET);
      const two = createInMemorySystems(shared, new Date("2031-02-14T22:15:00Z"));
      expect(await two.tickets.createTicket(BILLING_TICKET)).toEqual({ reference: "TKT-2031-00001" });
      expect(two.openedTickets()).toHaveLength(1);
    });
  });

  describe("sms.send", () => {
    it("puts the text in the outbox, addressed as given", async () => {
      const systems = createInMemorySystems(seed(), CALL_STARTED_AT);
      await systems.sms.send({ to: "+639175550101", message: "Your ticket is TKT-2026-00001." });
      expect(systems.outbox()).toEqual([
        { to: "+639175550101", message: "Your ticket is TKT-2026-00001." },
      ]);
    });

    it("hands back copies, and gives each call its own outbox", async () => {
      const shared = seed();
      const one = createInMemorySystems(shared, CALL_STARTED_AT);
      const two = createInMemorySystems(shared, CALL_STARTED_AT);
      await one.sms.send({ to: "+639175550101", message: "Hello po." });
      one.outbox()[0].to = "+639990000000";
      expect(one.outbox()).toEqual([{ to: "+639175550101", message: "Hello po." }]);
      expect(two.outbox()).toEqual([]);
    });
  });
});
