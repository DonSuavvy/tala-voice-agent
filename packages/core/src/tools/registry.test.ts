import { describe, expect, it } from "vitest";

import { initialIdentityState } from "../policy/identity";
import { createInMemorySystems } from "../systems/in-memory";
import { CALL_STARTED_AT, testWorld } from "../testing/fixtures";

import type { TalaToolContext } from "./context";
import { buildTalaRegistry } from "./index";

/**
 * Tala's tool set, as the call session builds it. Boot validation is the
 * engine's (`agent/registry`); this pins what #5, #10 and #11 register.
 */

describe("buildTalaRegistry", () => {
  it("passes boot validation", () => {
    expect(() => buildTalaRegistry()).not.toThrow();
  });

  it("holds exactly the tools #5, #10 and #11 add", () => {
    const names = buildTalaRegistry()
      .list()
      .map((tool) => tool.name);

    expect(names.sort()).toEqual([
      "check_area_outage",
      "create_trouble_ticket",
      "end_call",
      "get_account_overview",
      "get_billing_history",
      "get_technician_slots",
      "remote_reboot_modem",
      "run_line_diagnostics",
      "send_sms",
      "verify_identity",
      "verify_payment",
    ]);
  });

  it("declares each tool's safety class", () => {
    const classes = Object.fromEntries(
      buildTalaRegistry()
        .list()
        .map((tool) => [tool.name, tool.safetyClass]),
    );

    expect(classes).toEqual({
      verify_identity: "read",
      check_area_outage: "read",
      get_account_overview: "read",
      get_billing_history: "read",
      verify_payment: "read",
      run_line_diagnostics: "read",
      get_technician_slots: "read",
      create_trouble_ticket: "auto_write",
      remote_reboot_modem: "auto_write",
      send_sms: "auto_write",
      end_call: "auto_write",
    });
  });

  it("ends every call through end_call", () => {
    expect(buildTalaRegistry().terminalToolName).toBe("end_call");
  });

  it("has no tool that pauses for approval yet: in-call approvals are #13", () => {
    const registry = buildTalaRegistry();

    for (const tool of registry.list()) {
      expect(tool.safetyClass, tool.name).not.toBe("confirm_write");
      expect(registry.requiresApproval(tool.name), tool.name).toBe(false);
    }
  });

  it("names no company in what the model is told, because core serves any pack", () => {
    const wire = JSON.stringify(buildTalaRegistry().toAnthropicTools());

    expect(wire).not.toMatch(/kidlat/i);
  });
});

/**
 * The account gate, across the whole registry: every tool but the one that
 * verifies and the one that ends the call refuses before verification. A new
 * tool has to be given a valid input here, so nobody adds an account tool
 * without the gate being checked.
 */
describe("the account gate, on every account tool", () => {
  const NOT_ACCOUNT_TOOLS = ["verify_identity", "end_call"];
  const VALID_INPUT: Record<string, unknown> = {
    check_area_outage: { account_number: "8012345601" },
    get_account_overview: { account_number: "8012345601" },
    get_billing_history: { account_number: "8012345601" },
    verify_payment: { reference: "1234567890123" },
    create_trouble_ticket: { category: "billing", notes: "A payment has not posted yet." },
    send_sms: { message: "Salamat po." },
    run_line_diagnostics: { account_number: "8012345601" },
    remote_reboot_modem: { account_number: "8012345601" },
    get_technician_slots: { account_number: "8012345601" },
  };

  const accountTools = buildTalaRegistry()
    .list()
    .filter((tool) => !NOT_ACCOUNT_TOOLS.includes(tool.name));

  it.each(accountTools.map((tool) => [tool.name, tool] as const))(
    "%s refuses before the caller is verified",
    async (name, tool) => {
      const ctx: TalaToolContext = {
        workspaceId: "test-isp",
        runId: "call_1",
        callId: "call_1",
        now: CALL_STARTED_AT,
        data: {
          systems: createInMemorySystems(testWorld(), CALL_STARTED_AT, "Asia/Manila"),
          identity: initialIdentityState(),
          company: { timeZone: "Asia/Manila", locale: "en-PH", currency: "PHP" },
          wait: () => Promise.resolve(),
        },
        policyConfig: { identity: { maxFailedAttempts: 3 } },
      };
      expect(VALID_INPUT[name], `give ${name} a valid input here`).toBeDefined();

      await expect(tool.handler(tool.input.parse(VALID_INPUT[name]), ctx)).rejects.toThrow(
        /^Refused: the caller has not been verified on this call/,
      );
    },
  );
});
