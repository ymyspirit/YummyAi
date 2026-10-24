import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessRegistry, HarnessContractError, type HarnessToolDefinition } from "./harness-registry.js";

const skill = { key: "test.review", version: "v1" };
function tool(key = "test.echo", changes: Partial<HarnessToolDefinition["descriptor"]> = {}): HarnessToolDefinition {
  return {
    descriptor: {
      key, version: "v1", label: "Synthetic echo", owner: "test.owner", effect: "read",
      inputSchemaKey: "test.input", outputSchemaKey: "test.output", permissionPolicyVersion: "policy-v1", requiredPermissions: ["test:read"],
      resourcePolicy: "test.current-owner", dataDomains: ["business"], timeout: { mode: "abort_signal", milliseconds: 1000 },
      maxInputBytes: 100, maxOutputBytes: 100, recovery: "owner_receipt", approval: "owning_business_flow", ...changes,
    }, inputSchema: z.object({ text: z.string() }).strict(), outputSchema: z.object({ accepted: z.boolean() }).strict(),
  };
}
function registry(tools = [tool()], instructions = "Read the current source and return a cited result") {
  return new HarnessRegistry("test.executor", tools, [{ ...skill, label: "Synthetic review", instructions, steps: ["authorize", "execute", "validate"], tools: [{ key: "test.echo", version: "v1" }] }]);
}
describe("code-owned tool and Skill contracts", () => {
  it("survives JSON object-key reordering and keeps returned audit metadata detached", () => {
    const owner = registry(), pin = owner.pin(skill);
    const reordered = JSON.parse(JSON.stringify(pin, (_key, value) => value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(owner.assertCurrent(reordered, skill)).toEqual(pin);
    owner.descriptor(pin, skill, "test.echo").requiredPermissions.length = 0;
    expect(owner.descriptor(pin, skill, "test.echo").requiredPermissions).toEqual(["test:read"]);
    pin.tools.length = 0;
    expect(owner.pin(skill).tools).toHaveLength(1);
  });
  it("rejects added registered tools, unsupported versions and a different method", () => {
    const owner = registry([tool(), tool("test.write", { effect: "internal_write" })]), pin = owner.pin(skill);
    expect(() => owner.checkInput(pin, skill, "test.write", { text: "Synthetic" })).toThrow("harness_tool_unavailable");
    expect(() => owner.assertCurrent({ ...pin, tools: [...pin.tools, { ...pin.tools[0]!, key: "test.write" }] }, skill)).toThrow("harness_contract_changed");
    expect(() => owner.assertCurrent({ ...pin, skill: { ...pin.skill, version: "v2" } }, skill)).toThrow("harness_contract_changed");
    expect(() => owner.assertCurrent({ ...pin, skill: { ...pin.skill, key: "test.other" } }, skill)).toThrow("harness_contract_changed");
  });
  it("detects changed effects, policies, schemas and method bodies without reinterpreting old pins", () => {
    const pin = registry().pin(skill);
    for (const changes of [{ effect: "external_request" as const }, { requiredPermissions: ["test:write"] }, { permissionPolicyVersion: "policy-v2" }])
      expect(() => registry([tool("test.echo", changes)]).assertCurrent(pin, skill)).toThrow("harness_contract_changed");
    expect(() => registry([{ ...tool(), inputSchema: z.object({ different: z.string() }).strict() }]).assertCurrent(pin, skill)).toThrow("harness_contract_changed");
    expect(() => registry([tool()], "A changed reviewed method").assertCurrent(pin, skill)).toThrow("harness_contract_changed");
  });
  it("checks strict arguments and Unicode byte limits without disclosing payloads", () => {
    const owner = registry(), pin = owner.pin(skill);
    owner.checkInput(pin, skill, "test.echo", { text: "Valid" });
    for (const value of [{ text: "secret", effect: "read" }, { text: "保密".repeat(20) }, { text: 1 }]) {
      try { owner.checkInput(pin, skill, "test.echo", value); throw new Error("Expected rejection"); }
      catch (error) { expect(error).toBeInstanceOf(HarnessContractError); expect((error as Error).message).toBe("harness_tool_input_invalid"); }
    }
    expect(() => owner.checkOutput(pin, skill, "test.echo", { accepted: "true" })).toThrow("harness_tool_output_invalid");
    owner.checkOutput(pin, skill, "test.echo", { accepted: true });
  });
  it("fails closed for missing contracts, duplicate registration and unknown Skill tools", () => {
    const owner = registry();
    expect(() => owner.assertCurrent(null, skill)).toThrow("harness_contract_missing");
    expect(() => owner.assertCurrent({ contractVersion: "native-harness-v1" }, skill)).toThrow("harness_contract_invalid");
    expect(() => registry([tool(), tool()])).toThrow("Duplicate registered tool");
    expect(() => new HarnessRegistry("test.executor", [], [{ ...skill, label: "Unknown", instructions: "Synthetic", steps: ["execute"], tools: [{ key: "missing.tool", version: "v1" }] }])).toThrow("unregistered tool");
  });
});
