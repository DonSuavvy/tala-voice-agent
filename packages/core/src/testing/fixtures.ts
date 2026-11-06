/**
 * Shared test fixtures for core: a small seed world, a fixed call start, the
 * test company, and a tool context built from them.
 *
 * Core's tests never import a company pack (the pack depends on core, not the
 * other way round), so they get their own world here. It mirrors scenario 1,
 * a verified caller in Batasan Hills, where a fiber cut is in progress;
 * scenario 2, a caller in Commonwealth whose GCash payment has not posted; and
 * scenario 3, a caller in San Antonio whose line has lost signal, which a
 * remote reboot does not fix. Jose's modem has hung, which a reboot does fix.
 *
 * Test-only. Nothing outside `*.test.ts` files imports this module.
 */
import type { PackSource } from "../pack/load-pack";
import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems, type InMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import type { BusinessSystems } from "../systems/types";
import type { TalaToolContext } from "../tools/context";

/** 1:00 PM in Manila (UTC+8). Every time in these fixtures hangs off this. */
export const CALL_STARTED_AT = new Date("2026-11-06T05:00:00Z");

/** How the test company speaks times and money: its time zone, locale and currency. */
export const TEST_COMPANY = { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" } as const;

/** A wait that resolves at once, so no test sits through a modem's restart. */
export const noWait = (): Promise<void> => Promise.resolve();

/** A fresh in-memory world for a call that starts at `startedAt`, in the test company's zone. */
export function testSystems(
  world: SeedWorld = testWorld(),
  startedAt: Date = CALL_STARTED_AT,
): InMemorySystems {
  return createInMemorySystems(world, startedAt, TEST_COMPANY.timeZone);
}

/**
 * A tool context for one test call that started at `CALL_STARTED_AT`: nobody
 * verified yet, the test company, the test policy, and a wait that resolves at
 * once unless one is given. `now` defaults to the call's start.
 */
export function testToolContext(
  systems: BusinessSystems,
  options: { now?: Date; wait?: (ms: number) => Promise<void> } = {},
): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: options.now ?? CALL_STARTED_AT,
    data: {
      systems,
      identity: initialIdentityState(),
      company: { ...TEST_COMPANY },
      startedAt: CALL_STARTED_AT,
      wait: options.wait ?? noWait,
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

/** Maria's account: Batasan Hills, where the outage is. */
export const MARIA = {
  accountNumber: "8012345601",
  mobileLast4: "0101",
} as const;

/** Jose's account: Commonwealth, no outage. Scenario 2's caller. */
export const JOSE = {
  accountNumber: "8012345602",
  mobileLast4: "0102",
} as const;

/** The reference of Jose's GCash payment, which has not posted. */
export const JOSE_GCASH_REFERENCE = "1234567890123";

/** Ana's account: San Antonio, no outage, a line with high signal loss. Scenario 3's caller. */
export const ANA = {
  accountNumber: "8012345603",
  mobileLast4: "0103",
} as const;

/** A fresh copy on every call, so no test can leak state into another. */
export function testWorld(): SeedWorld {
  return {
    barangays: [
      { id: "batasan-hills", name: "Batasan Hills", city: "Quezon City" },
      { id: "commonwealth", name: "Commonwealth", city: "Quezon City" },
      { id: "san-antonio", name: "San Antonio", city: "Pasig" },
    ],
    accounts: [
      {
        accountNumber: MARIA.accountNumber,
        holderName: "Maria Santos",
        registeredMobile: "+639175550101",
        status: "active",
        planName: "Kidlat 300",
        barangayId: "batasan-hills",
      },
      {
        accountNumber: JOSE.accountNumber,
        holderName: "Jose Dela Cruz",
        registeredMobile: "+639175550102",
        status: "active",
        planName: "Kidlat 100",
        barangayId: "commonwealth",
      },
      {
        accountNumber: ANA.accountNumber,
        holderName: "Ana Reyes",
        registeredMobile: "+639175550103",
        status: "active",
        planName: "Kidlat 500",
        barangayId: "san-antonio",
      },
    ],
    outages: [
      {
        reference: "OUT-2026-0412",
        cause: "a fiber cable cut along Batasan Road during road works",
        barangayIds: ["batasan-hills"],
        // Started 10:30 AM Manila, back by 5:00 PM Manila.
        startedMinutesBeforeCall: 150,
        restorationMinutesAfterCall: 240,
      },
    ],
    // Scenario 2: Jose's October bill is past due and disconnection is
    // scheduled for tomorrow; his GCash payment from yesterday has not posted.
    // Maria is current and paid.
    balances: [
      {
        accountNumber: MARIA.accountNumber,
        amountDueMinor: 0,
        dueMinutesBeforeCall: null,
        disconnectionMinutesAfterCall: null,
      },
      {
        accountNumber: JOSE.accountNumber,
        amountDueMinor: 129_900,
        // Due Tue, Oct 27, 1:00 PM; disconnection Sat, Nov 7, 1:00 PM.
        dueMinutesBeforeCall: 14_400,
        disconnectionMinutesAfterCall: 1_440,
      },
    ],
    bills: [
      {
        reference: "SOA-2610-5601",
        accountNumber: MARIA.accountNumber,
        amountMinor: 169_900,
        issuedMinutesBeforeCall: 36_000,
      },
      {
        reference: "SOA-2610-5602",
        accountNumber: JOSE.accountNumber,
        amountMinor: 129_900,
        issuedMinutesBeforeCall: 36_000,
      },
    ],
    payments: [
      {
        reference: "MAYA7K2Q9",
        accountNumber: MARIA.accountNumber,
        channel: "maya",
        amountMinor: 169_900,
        paidMinutesBeforeCall: 20_160,
        posted: true,
      },
      {
        reference: JOSE_GCASH_REFERENCE,
        accountNumber: JOSE.accountNumber,
        channel: "gcash",
        amountMinor: 129_900,
        // Thu, Nov 5, 1:00 PM: the day before the call.
        paidMinutesBeforeCall: 1_440,
        posted: false,
      },
    ],
    // Maria has none on record: her area has the outage.
    modems: [
      {
        accountNumber: JOSE.accountNumber,
        status: "degraded",
        receivedPowerDbm: -19.5,
        // Last seen 12:55 PM.
        lastSeenMinutesBeforeCall: 5,
        fault: "the modem has hung and is not passing traffic",
        rebootMayClear: true,
        restartSeconds: 60,
        afterReboot: { status: "online", receivedPowerDbm: -19.4, fault: null, rebootMayClear: false },
      },
      {
        accountNumber: ANA.accountNumber,
        status: "degraded",
        receivedPowerDbm: -28.4,
        // Last seen 12:58 PM.
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
    ],
    // Five open windows in San Antonio over the four days after the call, one
    // each elsewhere. Out of order on purpose: the world lists them soonest
    // first.
    technicianSlots: [
      { id: "san-antonio-3", barangayId: "san-antonio", daysAfterCall: 2, startHour: 9, lengthHours: 3 },
      { id: "san-antonio-1", barangayId: "san-antonio", daysAfterCall: 1, startHour: 9, lengthHours: 3 },
      { id: "commonwealth-1", barangayId: "commonwealth", daysAfterCall: 1, startHour: 9, lengthHours: 3 },
      { id: "san-antonio-2", barangayId: "san-antonio", daysAfterCall: 1, startHour: 13, lengthHours: 3 },
      { id: "san-antonio-4", barangayId: "san-antonio", daysAfterCall: 3, startHour: 13, lengthHours: 3 },
      { id: "san-antonio-5", barangayId: "san-antonio", daysAfterCall: 4, startHour: 9, lengthHours: 3 },
      { id: "batasan-hills-1", barangayId: "batasan-hills", daysAfterCall: 2, startHour: 13, lengthHours: 3 },
    ],
  };
}

/** The test pack's SOP. Its one placeholder is filled from the policy. */
export const TEST_SOP_BODY =
  "You are the assistant on Test ISP's support line.\n\n" +
  "Verification is locked after {{maxFailedVerificationAttempts}} failed attempts.\n";

/**
 * A complete, valid company pack as raw input, before `loadPack` checks it.
 * A fresh object on every call, so a test can break one part of it freely.
 */
export function testPackSource(): PackSource {
  return {
    id: "test-isp",
    sop: { version: "v7", body: TEST_SOP_BODY },
    company: { name: "Test ISP", ...TEST_COMPANY },
    persona: {
      openingLine:
        "Hello po! Ako po si Tala, an AI assistant, at nire-record po ang call na ito.",
      fallbackLine: "Pasensya na po, may problema ang system. Tumawag po ulit mamaya.",
      fillerLine: "Sandali lang po, iche-check ko.",
      closingLine: "Salamat po sa pagtawag sa Test ISP. Ingat po!",
    },
    policy: { identity: { maxFailedAttempts: 3 } },
    world: testWorld(),
  };
}
