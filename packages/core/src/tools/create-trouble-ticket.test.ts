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
  const systems = createInMemorySystems(testWorld(), CALL_STARTED_AT);
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
