import { describe, expect, it } from "vitest";

import { toStrictJsonSchema } from "../agent/registry";
import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems, type InMemorySystems } from "../systems/in-memory";
import { ANA, CALL_STARTED_AT, JOSE, testWorld } from "../testing/fixtures";

import { bookTechnicianVisit } from "./book-technician-visit";
import type { TalaToolContext } from "./context";
import { createTroubleTicket } from "./create-trouble-ticket";
import { verifyIdentity } from "./verify-identity";

/**
 * `book_technician_visit`, driven through its public definition against a
 * real in-memory world and the real account gate. The world's own record of
 * booked visits is how a test sees what the tool did, and which ticket each
 * visit is linked to.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. San Antonio, where Ana's
 * line is, has open windows from Sat, Nov 7; Commonwealth has one too.
 */

function newCall(): { ctx: TalaToolContext; systems: InMemorySystems } {
  const systems = createInMemorySystems(testWorld(), CALL_STARTED_AT, "Asia/Manila");
  const ctx: TalaToolContext = {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems,
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
      wait: () => Promise.resolve(),
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
  return { ctx, systems };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function book(ctx: TalaToolContext, input: unknown) {
  return bookTechnicianVisit.handler(bookTechnicianVisit.input.parse(input), ctx);
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

/** Ana verified, with a connection ticket opened on the call; returns its reference. */
async function anaWithTicket(ctx: TalaToolContext): Promise<string> {
  await verifyAs(ctx, ANA);
  const opened = await createTroubleTicket.handler(
    createTroubleTicket.input.parse({
      category: "connection",
      notes: "High signal loss on the line; a remote reboot did not clear it.",
    }),
    ctx,
  );
  return (opened as { reference: string }).reference;
}

const NO_TICKET =
  "Refused: no ticket with that reference was opened for this account on this call. " +
  "Open one with create_trouble_ticket first, then book the visit with its reference.";
const NO_SLOT =
  "Refused: that slot is not open in the caller's area. " +
  "Call get_technician_slots and offer the caller one of the windows it lists.";

describe("book_technician_visit — the account gate", () => {
  it("refuses before the caller is verified, and books nothing", async () => {
    const { ctx, systems } = newCall();

    await expect(
      book(ctx, {
        account_number: ANA.accountNumber,
        slot_id: "san-antonio-1",
        ticket_reference: "TKT-2026-00001",
      }),
    ).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
    expect(systems.bookedVisits()).toEqual([]);
  });

  it("refuses any account but the one verified on this call, and books nothing", async () => {
    const { ctx, systems } = newCall();
    const ticket = await anaWithTicket(ctx);

    await expect(
      book(ctx, { account_number: JOSE.accountNumber, slot_id: "commonwealth-1", ticket_reference: ticket }),
    ).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
    expect(systems.bookedVisits()).toEqual([]);
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const { ctx } = newCall();
    const wrong = { accountNumber: ANA.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(
      book(ctx, {
        account_number: ANA.accountNumber,
        slot_id: "san-antonio-1",
        ticket_reference: "TKT-2026-00001",
      }),
    ).rejects.toThrow(/^Refused: verification is locked for this call/);
  });
});

describe("book_technician_visit — a visit, linked to its ticket", () => {
  /** Issue #11's acceptance test: a booking links to its ticket. */
  it("books the window Ana picks against her ticket, and gives its reference and window", async () => {
    const { ctx, systems } = newCall();
    const ticket = await anaWithTicket(ctx);

    const result = await book(ctx, {
      account_number: "801-234-5603",
      slot_id: "san-antonio-1",
      ticket_reference: ticket,
    });

    expect(result).toEqual({
      booked: true,
      booking_reference: "VIS-2026-00001",
      window: "Sat, Nov 7, 9:00 AM to 12:00 PM",
    });
    expect(systems.bookedVisits()).toEqual([
      {
        reference: "VIS-2026-00001",
        accountNumber: ANA.accountNumber,
        slotId: "san-antonio-1",
        ticketReference: "TKT-2026-00001",
      },
    ]);
    expect(
      (await systems.fieldService.availableSlots("san-antonio")).map((s) => s.slotId),
    ).not.toContain("san-antonio-1");
  });

  it("refuses a ticket that was not opened on this call, and books nothing", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, ANA);

    await expect(
      book(ctx, {
        account_number: ANA.accountNumber,
        slot_id: "san-antonio-1",
        ticket_reference: "TKT-2026-00001",
      }),
    ).rejects.toThrow(NO_TICKET);
    expect(systems.bookedVisits()).toEqual([]);
  });

  it("refuses another account's ticket, and books nothing", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, ANA);
    const { reference } = await systems.tickets.createTicket({
      accountNumber: JOSE.accountNumber,
      category: "connection",
      notes: "The modem has hung.",
    });

    await expect(
      book(ctx, { account_number: ANA.accountNumber, slot_id: "san-antonio-1", ticket_reference: reference }),
    ).rejects.toThrow(NO_TICKET);
    expect(systems.bookedVisits()).toEqual([]);
  });

  it.each([
    ["in another barangay", "commonwealth-1"],
    ["that does not exist", "atlantis-1"],
  ])("refuses a slot %s, and books nothing", async (_what, slotId) => {
    const { ctx, systems } = newCall();
    const ticket = await anaWithTicket(ctx);

    await expect(
      book(ctx, { account_number: ANA.accountNumber, slot_id: slotId, ticket_reference: ticket }),
    ).rejects.toThrow(NO_SLOT);
    expect(systems.bookedVisits()).toEqual([]);
  });

  it("refuses a window already booked, so one slot never holds two visits", async () => {
    const { ctx, systems } = newCall();
    const ticket = await anaWithTicket(ctx);
    const input = { account_number: ANA.accountNumber, slot_id: "san-antonio-1", ticket_reference: ticket };
    await book(ctx, input);

    await expect(book(ctx, input)).rejects.toThrow(NO_SLOT);
    expect(systems.bookedVisits()).toHaveLength(1);
  });
});

describe("book_technician_visit — its input", () => {
  const valid = {
    account_number: ANA.accountNumber,
    slot_id: "san-antonio-1",
    ticket_reference: "TKT-2026-00001",
  };
  const parses = (input: unknown) => bookTechnicianVisit.input.safeParse(input).success;

  it("takes the account number, a slot and a ticket reference, each required", () => {
    expect(parses(valid)).toBe(true);
    for (const field of Object.keys(valid)) {
      expect(parses({ ...valid, [field]: "" }), field).toBe(false);
    }
    expect(Object.keys(toStrictJsonSchema(bookTechnicianVisit.input).properties)).toEqual([
      "account_number",
      "slot_id",
      "ticket_reference",
    ]);
  });

  it("takes nothing else", () => {
    expect(parses({ ...valid, extra: 1 })).toBe(false);
  });

  it("is a write that is not safe to replay: a replay would book a second visit", () => {
    expect(bookTechnicianVisit.safetyClass).toBe("auto_write");
    expect(bookTechnicianVisit.idempotent).toBe(false);
  });
});
