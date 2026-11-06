import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems, type InMemorySystems } from "../systems/in-memory";
import { ANA, CALL_STARTED_AT, JOSE, MARIA, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { remoteRebootModem } from "./remote-reboot-modem";
import { verifyIdentity } from "./verify-identity";

/**
 * `remote_reboot_modem`, driven through its public definition against a real
 * in-memory world and the real account gate. The wait is the context's own,
 * as the call session supplies it; here it records what it was asked to wait
 * and resolves at once.
 *
 * The call starts at 1:00 PM Manila on Fri, Nov 6. Ana's line has high signal
 * loss, which a reboot does not clear, and her modem takes 90 seconds to
 * restart. Jose's modem has hung, which a reboot clears, in 60 seconds.
 */

function newCall(now: Date = CALL_STARTED_AT) {
  const systems: InMemorySystems = createInMemorySystems(testWorld(), CALL_STARTED_AT, "Asia/Manila");
  const waits: number[] = [];
  const ctx: TalaToolContext = {
    workspaceId: "test-isp",
    runId: "call_1",
    callId: "call_1",
    now,
    data: {
      systems,
      identity: initialIdentityState(),
      company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
    policyConfig: { identity: { maxFailedAttempts: 3 } },
  };
  return { ctx, systems, waits };
}

/** As the loop does it: parse with the tool's own schema, then run the handler. */
function reboot(ctx: TalaToolContext, accountNumber: string) {
  return remoteRebootModem.handler(
    remoteRebootModem.input.parse({ account_number: accountNumber }),
    ctx,
  );
}

async function verifyAs(ctx: TalaToolContext, who: { accountNumber: string; mobileLast4: string }) {
  await verifyIdentity.handler(
    verifyIdentity.input.parse({ account_number: who.accountNumber, mobile_last4: who.mobileLast4 }),
    ctx,
  );
}

describe("remote_reboot_modem — the account gate", () => {
  it("refuses before the caller is verified, and reboots nothing", async () => {
    const { ctx, systems, waits } = newCall();

    await expect(reboot(ctx, ANA.accountNumber)).rejects.toThrow(
      "Refused: the caller has not been verified on this call. " +
        "Verify them with verify_identity first.",
    );
    expect(waits).toEqual([]);
    expect((await systems.network.diagnose(ANA.accountNumber))?.receivedPowerDbm).toBe(-28.4);
  });

  it("refuses any account but the one verified on this call, and reboots nothing", async () => {
    const { ctx, systems } = newCall();
    await verifyAs(ctx, ANA);

    await expect(reboot(ctx, JOSE.accountNumber)).rejects.toThrow(
      "Refused: this call is verified for a different account, " +
        "and only that account can be checked.",
    );
    expect((await systems.network.diagnose(JOSE.accountNumber))?.modemStatus).toBe("degraded");
  });

  it("once verification is locked, refuses without telling the model to verify again", async () => {
    const { ctx } = newCall();
    const wrong = { accountNumber: ANA.accountNumber, mobileLast4: "9999" };
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);
    await verifyAs(ctx, wrong);

    await expect(reboot(ctx, ANA.accountNumber)).rejects.toThrow(
      /^Refused: verification is locked for this call/,
    );
  });
});

describe("remote_reboot_modem — a reboot, then a re-check", () => {
  it("waits Ana's restart out, then gives the re-check: the signal loss is still there", async () => {
    const { ctx, waits } = newCall();
    await verifyAs(ctx, ANA);

    expect(await reboot(ctx, ANA.accountNumber)).toEqual({
      rebooted: true,
      waited_seconds: 90,
      modem_status: "degraded",
      received_power_dbm: -28.3,
      // 1:00 PM plus the 90-second restart.
      last_seen: "Fri, Nov 6, 1:01 PM",
      fault: "high signal loss on the fiber line",
      reboot_may_clear: false,
    });
    expect(waits).toEqual([90_000]);
  });

  it("gives the re-check of a fault the reboot clears: Jose's modem is back online", async () => {
    const { ctx, waits } = newCall();
    await verifyAs(ctx, JOSE);

    expect(await reboot(ctx, JOSE.accountNumber)).toEqual({
      rebooted: true,
      waited_seconds: 60,
      modem_status: "online",
      received_power_dbm: -19.4,
      last_seen: "Fri, Nov 6, 1:01 PM",
      fault: null,
      reboot_may_clear: false,
    });
    expect(waits).toEqual([60_000]);
  });

  it("dates the re-check from the call's now, which the context gives, plus the wait", async () => {
    // 1:10 PM: a later caller turn of the same call.
    const { ctx } = newCall(new Date("2026-11-06T05:10:00Z"));
    await verifyAs(ctx, ANA);

    expect(await reboot(ctx, ANA.accountNumber)).toMatchObject({ last_seen: "Fri, Nov 6, 1:11 PM" });
  });

  it("gives no result until the wait is over", async () => {
    const { ctx } = newCall();
    let release = () => {};
    ctx.data.wait = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await verifyAs(ctx, ANA);

    let settled = false;
    const rebooting = reboot(ctx, ANA.accountNumber).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    expect(await rebooting).toMatchObject({ rebooted: true, waited_seconds: 90 });
  });

  it("says plainly when the verified account has no modem on record, and waits for nothing", async () => {
    const { ctx, waits } = newCall();
    await verifyAs(ctx, MARIA);

    await expect(reboot(ctx, MARIA.accountNumber)).rejects.toThrow(
      "no modem is on record for the account verified on this call",
    );
    expect(waits).toEqual([]);
  });
});

describe("remote_reboot_modem — its input", () => {
  it("takes the account number and nothing else", () => {
    expect(remoteRebootModem.input.safeParse({ account_number: "" }).success).toBe(false);
    expect(
      remoteRebootModem.input.safeParse({ account_number: ANA.accountNumber, extra: 1 }).success,
    ).toBe(false);
  });

  it("is a write that is not safe to replay: a replay restarts the modem again", () => {
    expect(remoteRebootModem.safetyClass).toBe("auto_write");
    expect(remoteRebootModem.idempotent).toBe(false);
  });
});
