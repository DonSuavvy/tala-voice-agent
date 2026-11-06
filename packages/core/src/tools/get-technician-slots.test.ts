import { describe, expect, it } from "vitest";

import type { InMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import { ANA, JOSE, testSystems, testToolContext, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { getTechnicianSlots } from "./get-technician-slots";
import { verifyIdentity } from "./verify-identity";

/**
 * `get_technician_slots`, driven through its public definition against a real
 * in-memory world and the real account gate. Nothing is mocked.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. San Antonio, where Ana's
 * line is, has five open windows over the next four days; Commonwealth and
 * Batasan Hills have one each. The tool gives three at most.
 */

function newCall(world: SeedWorld = testWorld()): { ctx: TalaToolContext; systems: InMemorySystems } {
  const systems = testSystems(world);
  return { ctx: testToolContext(systems), systems };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function slots(ctx: TalaToolContext, accountNumber: string) {
  return getTechnicianSlots.handler(
    getTechnicianSlots.input.parse({ account_number: accountNumber }),
    ctx,
  );
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("get_technician_slots — the account gate", () => {
  it("refuses before the caller is verified", async () => {
    await expect(slots(newCall().ctx, ANA.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  it("refuses any account but the one verified on this call", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, ANA);

    await expect(slots(ctx, JOSE.accountNumber)).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const { ctx } = newCall();
    const wrong = { accountNumber: ANA.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(slots(ctx, ANA.accountNumber)).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
  });
});

describe("get_technician_slots — the verified account's area", () => {
  it("offers the three soonest open windows in Ana's barangay, as they are spoken", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, ANA);

    expect(await slots(ctx, ANA.accountNumber)).toEqual({
      service_area: "San Antonio, Pasig",
      slots: [
        { slot_id: "san-antonio-1", window: "Sat, Nov 7, 9:00 AM to 12:00 PM" },
        { slot_id: "san-antonio-2", window: "Sat, Nov 7, 1:00 PM to 4:00 PM" },
        { slot_id: "san-antonio-3", window: "Sun, Nov 8, 9:00 AM to 12:00 PM" },
      ],
    });
  });

  it("leaves out a window already booked", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, ANA);
    await systems.fieldService.bookVisit({
      accountNumber: ANA.accountNumber,
      slotId: "san-antonio-1",
      ticketReference: "TKT-2026-00001",
    });

    expect(await slots(ctx, ANA.accountNumber)).toMatchObject({
      slots: [
        { slot_id: "san-antonio-2" },
        { slot_id: "san-antonio-3" },
        { slot_id: "san-antonio-4", window: "Mon, Nov 9, 1:00 PM to 4:00 PM" },
      ],
    });
  });

  it("gives an empty list, not an error, when no window is open in the area", async () => {
    const world = testWorld();
    world.technicianSlots = world.technicianSlots.filter((s) => s.barangayId !== "san-antonio");
    const { ctx } = newCall(world);
    await verifyAs(ctx, ANA);

    expect(await slots(ctx, ANA.accountNumber)).toEqual({
      service_area: "San Antonio, Pasig",
      slots: [],
    });
  });
});

describe("get_technician_slots — its description", () => {
  /** What the model is told it gets is what it gets: three windows at most. */
  it("states the most windows it gives, which is how many it gives when more are open", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, ANA);

    expect(getTechnicianSlots.description).toMatch(/\bat most 3\b/);
    expect(await slots(ctx, ANA.accountNumber)).toMatchObject({ slots: [{}, {}, {}] });
  });
});

describe("get_technician_slots — its input", () => {
  it("takes the account number and nothing else", () => {
    expect(getTechnicianSlots.input.safeParse({ account_number: "" }).success).toBe(false);
    expect(
      getTechnicianSlots.input.safeParse({ account_number: ANA.accountNumber, extra: 1 }).success,
    ).toBe(false);
  });

  it("is a read", () => {
    expect(getTechnicianSlots.safetyClass).toBe("read");
    expect(getTechnicianSlots.idempotent).toBe(true);
  });
});
