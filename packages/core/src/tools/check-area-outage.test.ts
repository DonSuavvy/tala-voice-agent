import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import { CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import { checkAreaOutage } from "./check-area-outage";
import type { TalaToolContext } from "./context";
import { verifyIdentity } from "./verify-identity";

/**
 * `check_area_outage`, driven through its public definition against a real
 * in-memory world and the real account gate. Nothing is mocked.
 *
 * The call starts at 1:00 PM Manila. The fixture's Batasan Hills outage
 * started 150 minutes earlier and is due back 240 minutes later.
 */

function newContext(world: SeedWorld = testWorld()): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems: createInMemorySystems(world, CALL_STARTED_AT),
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH" },
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function checkOutage(ctx: TalaToolContext, accountNumber: string) {
  return checkAreaOutage.handler(
    checkAreaOutage.input.parse({ account_number: accountNumber }),
    ctx,
  );
}

/** Verified the way a call gets there: through verify_identity itself. */
async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("check_area_outage — the account gate", () => {
  it("refuses before the caller is verified", async () => {
    const ctx = newContext();

    await expect(checkOutage(ctx, MARIA.accountNumber)).rejects.toThrow(/not been verified/);
    await expect(checkOutage(ctx, MARIA.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  it("with an attempt still left, still tells the model to verify first", async () => {
    const ctx = newContext();
    const wrong = { accountNumber: MARIA.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(checkOutage(ctx, MARIA.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  // verify_identity and the SOP both say "do not try again" once locked; this
  // refusal must not send the model back to verify_identity.
  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const ctx = newContext();
    const wrong = { accountNumber: MARIA.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(checkOutage(ctx, MARIA.accountNumber)).rejects.toThrow(
      "Refused: verification is locked for this call, so no account can be checked. " +
        "Do not call verify_identity again; tell the caller you cannot access the account " +
        "on this call.",
    );
  });

  it("refuses any account but the one verified on this call", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    await expect(checkOutage(ctx, MARIA.accountNumber)).rejects.toThrow(/different account/);
    await expect(checkOutage(ctx, MARIA.accountNumber)).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
  });
});

describe("check_area_outage — the verified caller's area", () => {
  it("reports the outage in Maria's barangay, with its times in Manila time", async () => {
    const ctx = newContext();
    await verifyAs(ctx, MARIA);

    const result = await checkOutage(ctx, "801-234-5601");

    expect(result).toEqual({
      service_area: "Batasan Hills, Quezon City",
      checked_at: "Fri, Nov 6, 1:00 PM",
      outages: [
        {
          reference: "OUT-2026-0412",
          cause: "a fiber cable cut along Batasan Road during road works",
          started: "Fri, Nov 6, 10:30 AM",
          estimated_restoration: "Fri, Nov 6, 5:00 PM",
        },
      ],
    });
  });

  it("says there is no outage in Jose's barangay with an empty list", async () => {
    const ctx = newContext();
    await verifyAs(ctx, JOSE);

    const result = await checkOutage(ctx, JOSE.accountNumber);

    expect(result).toEqual({
      service_area: "Commonwealth, Quezon City",
      checked_at: "Fri, Nov 6, 1:00 PM",
      outages: [],
    });
  });

  it("gives null for the restoration time when the network team has not given one", async () => {
    const world = testWorld();
    world.outages[0].restorationMinutesAfterCall = null;
    const ctx = newContext(world);
    await verifyAs(ctx, MARIA);

    const result = await checkOutage(ctx, MARIA.accountNumber);

    expect(result).toEqual({
      service_area: "Batasan Hills, Quezon City",
      checked_at: "Fri, Nov 6, 1:00 PM",
      outages: [
        {
          reference: "OUT-2026-0412",
          cause: "a fiber cable cut along Batasan Road during road works",
          started: "Fri, Nov 6, 10:30 AM",
          estimated_restoration: null,
        },
      ],
    });
  });
});

/** The result shape the handler returns, which the tool type leaves as unknown. */
interface OutageResult {
  checked_at: string;
  outages: { started: string; estimated_restoration: string | null }[];
}

/**
 * The model says a restoration time aloud and rounds it itself, sometimes down,
 * which promises service back earlier than estimated (#36). The tool rounds it
 * up to the next quarter hour so the model only reads it out. The call starts
 * at 1:00 PM Manila, so 461 minutes after it is 8:41 PM.
 */
describe("check_area_outage — restoration times are rounded up to the quarter hour", () => {
  async function restorationFor(minutesAfterCall: number | null): Promise<string | null> {
    const world = testWorld();
    world.outages[0].restorationMinutesAfterCall = minutesAfterCall;
    const ctx = newContext(world);
    await verifyAs(ctx, MARIA);
    const result = (await checkOutage(ctx, MARIA.accountNumber)) as OutageResult;
    return result.outages[0].estimated_restoration;
  }

  it("says an estimate of 8:41 PM as 8:45 PM", async () => {
    expect(await restorationFor(461)).toBe("Fri, Nov 6, 8:45 PM");
  });

  it("says an estimate of 10:47 PM as 11:00 PM", async () => {
    expect(await restorationFor(587)).toBe("Fri, Nov 6, 11:00 PM");
  });

  it("leaves an estimate already on a quarter hour alone", async () => {
    expect(await restorationFor(450)).toBe("Fri, Nov 6, 8:30 PM");
  });

  it("carries 11:50 PM to 12:00 AM on the next day, with that day's weekday and date", async () => {
    expect(await restorationFor(650)).toBe("Sat, Nov 7, 12:00 AM");
  });

  it("keeps no estimate as null", async () => {
    expect(await restorationFor(null)).toBeNull();
  });

  it("rounds only the estimate, not when the outage started or when it was checked", async () => {
    const world = testWorld();
    world.outages[0].startedMinutesBeforeCall = 143;
    world.outages[0].restorationMinutesAfterCall = 461;
    const ctx = { ...newContext(world), now: new Date("2026-11-06T05:07:00Z") };
    await verifyAs(ctx, MARIA);

    const result = (await checkOutage(ctx, MARIA.accountNumber)) as OutageResult;

    expect(result.checked_at).toBe("Fri, Nov 6, 1:07 PM");
    expect(result.outages[0].started).toBe("Fri, Nov 6, 10:37 AM");
    expect(result.outages[0].estimated_restoration).toBe("Fri, Nov 6, 8:45 PM");
  });
});
