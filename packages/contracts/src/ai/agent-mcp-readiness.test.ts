import { describe, expect, it } from "vitest";
import { AgentReadinessFamilySchema, AGENT_READINESS_VERSION, type AgentReadinessFamily } from "./agent-readiness.js";
import {
  AGENT_MCP_READINESS_VERSION, AgentMcpReadinessCallSchema, AgentMcpReadinessDefinitionRequestSchema,
  AgentMcpReadinessV2DefinitionSchema, AgentMcpReadinessV2ExecuteSchema,
  AgentMcpReadinessStartupPolicySchema, AgentMcpReadinessResultSchema,
} from "./agent-mcp-readiness.js";
import { AgentMcpExecuteSchema } from "./agent-mcp.js";
import { AgentMcpV2ExecuteSchema, AgentMcpV2SavedResultSchema, AgentMcpV2UsageSchema } from "./agent-mcp-v2.js";

const families = AgentMcpReadinessCallSchema.shape.family.options;
const policy = () => ({ allowedFamilies: [...families], allowModelRun: false, maxCostUsd: 0, allowPrepare: false,
  allowNativeV3: false, allowedReads: ["knowledge.search"], allowedCommands: [], allowedResources: [], allowFulfillment: false });
function result(family: AgentReadinessFamily = "native_v3") {
  return { version: AGENT_MCP_READINESS_VERSION, family, contextAuthority: "synthetic-personal-authority",
    diagnostic: { version: AGENT_READINESS_VERSION, family, contextAuthority: "synthetic-personal-authority", workspaceVersion: "original-workspace",
      checkedAt: "2026-10-23T00:00:00.000Z", state: "no_known_blocker", blockers: [],
      checks: { runPermission: "granted", model: "available", originalCapability: "available", taskBudget: "positive", monthlyBudget: "available", concurrency: "available" },
      canConfigureModels: true, metadataOnly: true, notChecked: ["request_budget", "selected_sources", "provider_connection", "consumer_readiness"],
      effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 } },
    startupPolicy: policy(), startTransport: family === "native_v1" ? "original_native_v1" : "not_registered",
    paidSubmissionEnabledByStartup: false, advisoryOnly: true, selectedMcpStartInputsChecked: false };
}

describe("explicit MCP readiness v1 on the unchanged five-tool v2 transport", () => {
  it("accepts exactly five independent family calls and preserves all historical execute parsers", () => {
    for (const family of families) {
      const call = { version: AGENT_MCP_READINESS_VERSION, family }, key = { key: "readiness/" + family };
      expect(AgentMcpReadinessCallSchema.parse(call)).toEqual(call);
      expect(AgentMcpReadinessV2ExecuteSchema.parse(call)).toEqual(call);
      expect(AgentMcpReadinessDefinitionRequestSchema.parse(key)).toEqual(key);
      expect(AgentMcpReadinessV2DefinitionSchema.parse(key)).toEqual(key);
      expect(AgentMcpV2ExecuteSchema.safeParse(call).success).toBe(false);
      expect(AgentMcpExecuteSchema.safeParse(call).success).toBe(false);
    }
    const legacy = { operation: "read", id: null, itemId: null, requestJson: "{}" };
    expect(AgentMcpReadinessV2ExecuteSchema.parse(legacy)).toEqual(AgentMcpExecuteSchema.parse(legacy));
    expect(AgentMcpReadinessV2DefinitionSchema.parse({ key: "native-v3/start" })).toEqual({ key: "native-v3/start" });
  });

  it("rejects unknown families, mixed native requests and arbitrary destinations or private inputs", () => {
    expect(AgentReadinessFamilySchema.safeParse("native_v4").success).toBe(true);
    expect(families).toEqual(["loop", "plan", "native_v1", "native_v2", "native_v3"]);
    const call = { version: AGENT_MCP_READINESS_VERSION, family: "native_v3" };
    for (const changed of [{ ...call, family: "native_v4" }, { ...call, version: "erp-agent-native-v3" },
      { ...call, operation: "start" }, { ...call, requestJson: "{}" }, { ...call, maxCostUsd: 0.000001 },
      { ...call, tenantId: "synthetic-foreign" }, { ...call, modelId: "synthetic-model" }, { ...call, prompt: "synthetic-private" },
      { ...call, url: "https://foreign.invalid" }, { ...call, query: {} }, { ...call, allowedFamilies: ["native_v3"] }])
      expect(AgentMcpReadinessV2ExecuteSchema.safeParse(changed).success).toBe(false);
    for (const key of ["readiness/native_v4", "readiness/native_v3/extra", "readiness/native_v3?model=x", "readiness/Native_v3"])
      expect(AgentMcpReadinessDefinitionRequestSchema.safeParse({ key }).success).toBe(false);
    expect(AgentMcpReadinessDefinitionRequestSchema.safeParse({ key: "readiness/loop", authority: "synthetic" }).success).toBe(false);
    expect(AgentMcpV2SavedResultSchema.safeParse(call).success).toBe(false);
    expect(AgentMcpV2UsageSchema.safeParse(call).success).toBe(false);
  });

  it("keeps immutable startup permission separate from positive ERP metadata and unregistered start transports", () => {
    for (const family of families) {
      const actual = AgentMcpReadinessResultSchema.parse(result(family));
      expect(actual.startTransport).toBe(family === "native_v1" ? "original_native_v1" : "not_registered");
      expect(actual.paidSubmissionEnabledByStartup).toBe(false);
    }
    const enabled = { ...result(), startupPolicy: { ...policy(), allowNativeV3: true, allowModelRun: true, maxCostUsd: 0.000001 },
      startTransport: "explicit_native_v3", paidSubmissionEnabledByStartup: true };
    expect(AgentMcpReadinessResultSchema.safeParse(enabled).success).toBe(true);
    for (const changed of [{ ...policy(), allowedFamilies: [] }, { ...policy(), allowedFamilies: ["loop", "loop"] },
      { ...policy(), allowedFamilies: [...families, "native_v4"] },
      { ...policy(), allowedReads: ["knowledge.search", "knowledge.search"] }, { ...policy(), allowModelRun: true },
      { ...policy(), maxCostUsd: 0.000001 }, { ...policy(), allowPrepare: true },
      { ...policy(), allowedResources: ["catalog.sku", "catalog.sku"] }])
      expect(AgentMcpReadinessStartupPolicySchema.safeParse(changed).success).toBe(false);
    expect(AgentMcpReadinessResultSchema.safeParse({ ...enabled, startTransport: "original_native_v1" }).success).toBe(false);
    expect(AgentMcpReadinessResultSchema.safeParse({ ...enabled, paidSubmissionEnabledByStartup: false }).success).toBe(false);
  });

  it("rejects forged effects, changed identities or family and any claim that selected inputs were checked", () => {
    const original = result();
    for (const changed of [{ ...original, family: "loop" }, { ...original, contextAuthority: "synthetic-other" },
      { ...original, startupPolicy: { ...policy(), allowedFamilies: ["loop"] } }, { ...original, selectedMcpStartInputsChecked: true },
      { ...original, advisoryOnly: false }, { ...original, diagnostic: { ...original.diagnostic, maxCostUsd: 1 } },
      ...["modelCalls", "queueDispatches", "budgetReservations", "businessWrites"].map(key => ({ ...original,
        diagnostic: { ...original.diagnostic, effects: { ...original.diagnostic.effects, [key]: 1 } } }))])
      expect(AgentMcpReadinessResultSchema.safeParse(changed).success).toBe(false);
  });
});
