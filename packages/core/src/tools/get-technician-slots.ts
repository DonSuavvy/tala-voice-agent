/**
 * `get_technician_slots`: when a technician can visit the verified caller's
 * home.
 *
 * The windows come from the field-service calendar for the account's own
 * barangay, soonest first. The model offers some of them and books the one
 * the caller picks with `book_technician_visit`, by its `slot_id`.
 */
import { z } from "zod";

import { accountNumberInput, requireVerifiedAccount } from "./account-gate";
import { defineTalaTool } from "./context";
import { formatLocalWindow } from "./format-time";

/** The most windows one answer lists: enough to choose from, few enough to say. */
const MAX_SLOTS = 4;

export const getTechnicianSlots = defineTalaTool({
  name: "get_technician_slots",
  description:
    "Lists the next open windows in which a technician can visit the caller's home, in the " +
    "service area (barangay) of the caller's account: soonest first, at most four, each with " +
    "a slot_id and its window as it should be said, in local time. Use it when a verified " +
    "caller needs a technician visit, once a ticket for the problem is open. It works only " +
    "for the account verified on this call with verify_identity, and refuses any other. An " +
    "empty list means no window is open: say so, never guess one.",
  input: z
    .object({
      account_number: accountNumberInput,
    })
    .strict(),
  safetyClass: "read",
  idempotent: true,
  handler: async (input, ctx) => {
    const account = await requireVerifiedAccount(ctx, input.account_number);
    const { systems, company } = ctx.data;
    const open = await systems.fieldService.availableSlots(account.serviceArea.barangayId);

    return {
      service_area: `${account.serviceArea.barangayName}, ${account.serviceArea.city}`,
      slots: open.slice(0, MAX_SLOTS).map((slot) => ({
        slot_id: slot.slotId,
        window: formatLocalWindow(slot.startsAt, slot.endsAt, company),
      })),
    };
  },
});
