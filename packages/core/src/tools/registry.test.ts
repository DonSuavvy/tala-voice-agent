import { describe, expect, it } from "vitest";

import { buildTalaRegistry } from "./index";

/**
 * Tala's tool set, as the call session builds it. Boot validation is the
 * engine's (`agent/registry`); this pins what #5 registers.
 */

describe("buildTalaRegistry", () => {
  it("passes boot validation", () => {
    expect(() => buildTalaRegistry()).not.toThrow();
  });

  it("holds exactly verify_identity, check_area_outage and end_call", () => {
    const names = buildTalaRegistry()
      .list()
      .map((tool) => tool.name);

    expect(names.sort()).toEqual(["check_area_outage", "end_call", "verify_identity"]);
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
