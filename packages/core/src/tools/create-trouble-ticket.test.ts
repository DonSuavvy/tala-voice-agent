import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems, type InMemorySystems } from "../systems/in-memory";
import { CALL_STARTED_AT, JOSE, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { createTroubleTicket } from "./create-trouble-ticket";
import { verifyIdentity } from "./verify-identity";

/**
 * `create_trouble_ticket`, driven through its public definition against a
 * real in-memory world and the real account gate. The world's own record of
 * opened tickets is how a test sees what the tool did.
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
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
  return { ctx, systems };
}

const NOTES = "GCash payment of 1,299 pesos made yesterday has not posted. Please post it.";

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function openTicket(ctx: TalaToolContext, input: unknown) {
  return createTroubleTicket.handler(createTroubleTicket.input.parse(input), ctx);
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("create_trouble_ticket — the account gate", () => {
  it("refuses before the caller is verified, and opens nothing", async () => {
    const { ctx, systems } = newCall();

    await expect(openTicket(ctx, { category: "billing", notes: NOTES })).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
    expect(systems.openedTickets()).toEqual([]);
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const { ctx, systems } = newCall();
    const wrong = { accountNumber: JOSE.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(openTicket(ctx, { category: "billing", notes: NOTES })).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
    expect(systems.openedTickets()).toEqual([]);
  });
});

describe("create_trouble_ticket — on the verified account", () => {
  it("opens a billing ticket on the verified account and gives its reference", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    const result = await openTicket(ctx, { category: "billing", notes: NOTES });

    expect(result).toEqual({ created: true, reference: "TKT-2026-00001" });
    expect(systems.openedTickets()).toEqual([
      { reference: "TKT-2026-00001", accountNumber: JOSE.accountNumber, category: "billing", notes: NOTES },
    ]);
  });

  it("gives a second ticket on the call the next reference", async () => {
    const { ctx } = newCall();
    await verifyAs(ctx, JOSE);
    await openTicket(ctx, { category: "billing", notes: NOTES });

    expect(await openTicket(ctx, { category: "connection", notes: "No internet since this morning." })).toEqual({
      created: true,
      reference: "TKT-2026-00002",
    });
  });
});

/**
 * The tool's own description says the notes hold no account or phone
 * numbers; the handler makes sure. The ticket is on the account already, so
 * the account's own numbers never need to be in it.
 */
describe("create_trouble_ticket — never the account's own numbers", () => {
  it.each([
    ["the account number", "Account 8012345602: GCash payment has not posted."],
    ["the account number, spaced", "Account 801 234 5602: GCash payment has not posted."],
    ["the mobile in E.164", "Call back on +639175550102 once posted."],
    ["the mobile with its 0 prefix", "Call back on 09175550102 once posted."],
    ["the mobile's last ten digits, spaced", "Call back on 917-555-0102 once posted."],
  ])("refuses notes holding %s, and opens nothing", async (_what, notes) => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);

    await expect(openTicket(ctx, { category: "billing", notes })).rejects.toThrow(
      "Refused: the notes contain the account number or the registered mobile number. " +
        "Leave out the account and mobile numbers; the ticket is already on the account.",
    );
    expect(systems.openedTickets()).toEqual([]);
  });

  it("keeps a payment reference in the notes: billing needs it to post the payment", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, JOSE);
    const notes =
      "GCash payment 1234567890123 of 1,299 pesos, paid Thu, Nov 5, has not posted. " +
      "Disconnection is scheduled for Sat, Nov 7.";

    await openTicket(ctx, { category: "billing", notes });

    expect(systems.openedTickets().map((t) => t.notes)).toEqual([notes]);
  });
});

describe("create_trouble_ticket — its input", () => {
  const valid = { category: "billing", notes: NOTES };
  const parses = (input: unknown) => createTroubleTicket.input.safeParse(input).success;

  it("takes billing, connection or other as the category, and nothing else", () => {
    for (const category of ["billing", "connection", "other"]) {
      expect(parses({ ...valid, category }), category).toBe(true);
    }
    expect(parses({ ...valid, category: "refund" })).toBe(false);
  });

  it("takes notes of 10 to 500 characters", () => {
    expect(parses({ ...valid, notes: "x".repeat(9) })).toBe(false);
    expect(parses({ ...valid, notes: "x".repeat(10) })).toBe(true);
    expect(parses({ ...valid, notes: "x".repeat(500) })).toBe(true);
    expect(parses({ ...valid, notes: "x".repeat(501) })).toBe(false);
  });

  it("has no account number to point it at another account", () => {
    expect(parses({ ...valid, account_number: "8012345601" })).toBe(false);
  });

  it("is a write that is not safe to replay: a replay opens a second ticket", () => {
    expect(createTroubleTicket.safetyClass).toBe("auto_write");
    expect(createTroubleTicket.idempotent).toBe(false);
  });
});
