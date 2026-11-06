/**
 * `book_technician_visit`: book the window the verified caller picked, for
 * the ticket opened on this call.
 *
 * A booking is always linked to its ticket: the visit is booked against a
 * ticket the ticketing system holds for this account, and the field-service
 * system keeps the ticket's reference with the visit. The slot must be one
 * still open in the account's own barangay. The model proposes the slot and
 * the ticket; the code checks both before anything is booked.
 */
import { z } from "zod";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatLocalWindow } from "./format-time";

export const bookTechnicianVisit = defineTalaTool({
  name: "book_technician_visit",
  description:
    "Books a technician visit to the caller's home in the window the caller picked, linked " +
    "to the ticket opened on this call for the problem. Use it only after the caller has " +
    "chosen one of the windows from get_technician_slots. It works only for the account " +
    "verified on this call with verify_identity, and refuses any other. It refuses a ticket " +
    "not opened for this account on this call, and a slot that is not open in the caller's " +
    "area. Returns booked true, the booking reference to give the caller, and the window as " +
    "it should be said. Calling it again books another visit.",
  input: z
    .object({
      account_number: accountNumberInput,
      slot_id: z
        .string()
        .min(1)
        .max(60)
        .describe(
          "The slot_id of the window the caller picked, exactly as get_technician_slots gave it.",
        ),
      ticket_reference: z
        .string()
        .min(1)
        .max(40)
        .describe("The reference create_trouble_ticket gave for the ticket opened on this call."),
    })
    .strict(),
  safetyClass: "auto_write",
  idempotent: false,
  handler: async (input, ctx) => {
    const account = await requireVerifiedAccount(ctx, input.account_number);
    const { systems, company } = ctx.data;
    const { accountNumber } = account;

    const ticket = await systems.tickets.findTicket(accountNumber, input.ticket_reference);
    if (ticket === null) {
      throw new Error(
        "Refused: no ticket with that reference was opened for this account on this call. " +
          "Open one with create_trouble_ticket first, then book the visit with its reference.",
      );
    }

    const open = await systems.fieldService.availableSlots(account.serviceArea.barangayId);
    const slot = open.find((s) => s.slotId === input.slot_id);
    if (!slot) {
      throw new Error(
        "Refused: that slot is not open in the caller's area. " +
          "Call get_technician_slots and offer the caller one of the windows it lists.",
      );
    }

    const { reference } = await systems.fieldService.bookVisit({
      accountNumber,
      slotId: slot.slotId,
      ticketReference: ticket.reference,
    });
    return {
      booked: true,
      booking_reference: reference,
      window: formatLocalWindow(slot.startsAt, slot.endsAt, company),
    };
  },
});
