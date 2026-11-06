import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import type { SeedWorld } from "../systems/seed-world";
import { ANA, CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { runLineDiagnostics } from "./run-line-diagnostics";
import { verifyIdentity } from "./verify-identity";

/**
 * `run_line_diagnostics`, driven through its public definition against a real
 * in-memory world and the real account gate. Nothing is mocked.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. Ana's line has high signal
 * loss, last seen at 12:58 PM; Jose's modem has hung. Maria has no modem on
 * record: her area has the outage.
 */

function newContext(world: SeedWorld = testWorld()): TalaToolContext {
  return {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now: CALL_STARTED_AT,
    data: {
      systems: createInMemorySystems(world, CALL_STARTED_AT, "Asia/Manila"),
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
      wait: () => Promise.resolve(),
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function diagnose(ctx: TalaToolContext, accountNumber: string) {
  return runLineDiagnostics.handler(
    runLineDiagnostics.input.parse({ account_number: accountNumber }),
    ctx,
  );
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("run_line_diagnostics — the account gate", () => {
  it("refuses before the caller is verified", async () => {
    await expect(diagnose(newContext(), ANA.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
  });

  it("refuses any account but the one verified on this call", async () => {
    const ctx = newContext();
    await verifyAs(ctx, ANA);

    await expect(diagnose(ctx, JOSE.accountNumber)).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const ctx = newContext();
    const wrong = { accountNumber: ANA.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(diagnose(ctx, ANA.accountNumber)).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
  });
});

describe("run_line_diagnostics — the verified account's connection", () => {
  it("gives Ana's diagnosis as the system states it, with times as they are spoken", async () => {
    const ctx = newContext();
    await verifyAs(ctx, ANA);

    expect(await diagnose(ctx, "801 234 5603")).toEqual({
      checked_at: "Fri, Nov 6, 1:00 PM",
      modem_status: "degraded",
      received_power_dbm: -28.4,
      last_seen: "Fri, Nov 6, 12:58 PM",
      fault: "high signal loss on the fiber line",
      reboot_may_clear: true,
    });
  });

  it("gives a null fault when the system found none", async () => {
    const world = testWorld();
    const jose = world.modems.find((m) => m.accountNumber === JOSE.accountNumber)!;
    Object.assign(jose, { status: "online", fault: null, rebootMayClear: false });
    const ctx = newContext(world);
    await verifyAs(ctx, JOSE);

    expect(await diagnose(ctx, JOSE.accountNumber)).toMatchObject({
      modem_status: "online",
      fault: null,
      reboot_may_clear: false,
    });
  });

  it("says plainly when the verified account has no modem on record", async () => {
    const ctx = newContext();
    await verifyAs(ctx, MARIA);

    await expect(diagnose(ctx, MARIA.accountNumber)).rejects.toThrow(
      "no modem is on record for the account verified on this call",
    );
  });
});

describe("run_line_diagnostics — its input", () => {
  it("takes the account number and nothing else", () => {
    expect(runLineDiagnostics.input.safeParse({ account_number: "" }).success).toBe(false);
    expect(
      runLineDiagnostics.input.safeParse({ account_number: ANA.accountNumber, extra: 1 }).success,
    ).toBe(false);
  });

  it("is a read", () => {
    expect(runLineDiagnostics.safetyClass).toBe("read");
    expect(runLineDiagnostics.idempotent).toBe(true);
  });
});
