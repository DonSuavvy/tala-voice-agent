/**
 * Shared test fixtures for core: a small seed world and a fixed call start.
 *
 * Core's tests never import a company pack (the pack depends on core, not the
 * other way round), so they get their own world here. It mirrors scenario 1,
 * a verified caller in Batasan Hills, where a fiber cut is in progress, and
 * scenario 2, a caller in Commonwealth whose GCash payment has not posted.
 *
 * Test-only. Nothing outside `*.test.ts` files imports this module.
 */
import type { PackSource } from "../pack/load-pack";
import type { SeedWorld } from "../systems/seed-world";

/** 1:00 PM in Manila (UTC+8). Every time in these fixtures hangs off this. */
export const CALL_STARTED_AT = new Date("2026-11-06T05:00:00Z");

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

/** A fresh copy on every call, so no test can leak state into another. */
export function testWorld(): SeedWorld {
  return {
    barangays: [
      { id: "batasan-hills", name: "Batasan Hills", city: "Quezon City" },
      { id: "commonwealth", name: "Commonwealth", city: "Quezon City" },
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
    modems: [],
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
    company: { name: "Test ISP", timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
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
