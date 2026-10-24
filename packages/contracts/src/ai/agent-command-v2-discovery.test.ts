import { describe, expect, it } from "vitest";
import { ProcurementCommandKindSchema } from "../procurement/procurement-command.js";
import { IncomingCommandKindSchema } from "../procurement/incoming-command.js";
import { FinanceCommandKindSchema } from "../finance/finance-command.js";
import { AdCommandKindSchema } from "../customer-intelligence/advertising-command.js";
import { ProductionCommandKindSchema } from "../order/production-command.js";
import { FulfillmentCommandKindSchema } from "../order/fulfillment-command.js";
import { AGENT_COMMAND_VERSION } from "./agent-command.js";
import { AgentPlanCommandKeySchema, agentPlanCommandKey } from "./agent-plan.js";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AgentCommandV2CatalogSchema } from "./agent-fulfillment-command.js";
import { agentFulfillmentOperatorChecks } from "./agent-fulfillment-proposal.js";
import {
  AGENT_COMMAND_V2_DEFINITION_VERSION, AgentCommandV2DefinitionRequestSchema, AgentCommandV2DefinitionSchema,
  AgentCommandV2DefinitionWorkspaceSchema, AgentCommandV2KeySchema, AgentCommandV2SelectionSchema, agentCommandV2Key,
  type AgentCommandV2Key,
} from "./agent-command-v2-discovery.js";

const authority = "synthetic-current-original-authority", checksum = "a".repeat(64);
const oldKeys = [
  ...ProcurementCommandKindSchema.options.map(kind => ({ domain: "procurement", kind })),
  ...IncomingCommandKindSchema.options.map(kind => ({ domain: "incoming", kind })),
  ...ProductionCommandKindSchema.options.map(kind => ({ domain: "production", kind })),
  ...FinanceCommandKindSchema.options.map(kind => ({ domain: "finance", kind })),
  ...AdCommandKindSchema.options.map(kind => ({ domain: "advertising", kind })),
].map(value => AgentPlanCommandKeySchema.parse(value));
const keys = [...oldKeys, ...FulfillmentCommandKindSchema.options.map(kind => AgentCommandV2KeySchema.parse({ domain: "fulfillment", kind }))];
function selection(command: AgentCommandV2Key) { return { kind: "command" as const, command }; }
function definition(command: AgentCommandV2Key) {
  const fulfillment = command.domain === "fulfillment";
  return { version: AGENT_COMMAND_V2_DEFINITION_VERSION, selection: selection(command),
    protocol: fulfillment ? AGENT_FULFILLMENT_COMMAND_VERSION : AGENT_COMMAND_VERSION,
    contextAuthority: authority, available: true, blockReason: null, inputSchema: { type: "object", additionalProperties: false },
    effect: "suggest_original_command", execution: "separate_original_preparation_and_confirmation",
    completion: fulfillment ? "operator_completed_original_request" : "legacy_original_request",
    operatorChecks: fulfillment ? agentFulfillmentOperatorChecks(command.kind) : [],
    limitations: ["Synthetic discovery metadata cannot execute or prove a person's actions"], definitionChecksum: checksum };
}
function capabilities() {
  return keys.map(key => ({ ...key, protocol: key.domain === "fulfillment" ? AGENT_FULFILLMENT_COMMAND_VERSION : AGENT_COMMAND_VERSION,
    label: "Synthetic original owner", effect: "prepare_original_command", preparation: "registered_original_owner",
    execution: "exact_operator_confirmation", externalEffect: "internal_record_only", available: true, blockReason: null }));
}

describe("strict version2 original-command discovery", () => {
  it("retains all old37 keys and exactly fourteen additional fulfillment keys with no protocol aliasing", () => {
    expect(oldKeys).toHaveLength(37); expect(keys).toHaveLength(51);
    expect(new Set(keys.map(agentCommandV2Key)).size).toBe(51);
    for (const key of oldKeys) {
      expect(AgentCommandV2KeySchema.parse(key)).toEqual(key);
      expect(agentCommandV2Key(key)).toBe(agentPlanCommandKey(key));
    }
    for (const key of keys) {
      expect(AgentCommandV2SelectionSchema.parse(selection(key))).toEqual(selection(key));
      const request = { version: AGENT_COMMAND_V2_DEFINITION_VERSION, selection: selection(key) };
      expect(AgentCommandV2DefinitionRequestSchema.parse(request)).toEqual(request);
      expect(AgentCommandV2DefinitionSchema.parse(definition(key))).toEqual(definition(key));
    }
    expect(AgentPlanCommandKeySchema.safeParse({ domain: "fulfillment", kind: "shipment_review" }).success).toBe(false);
  });

  it("requires the complete strict51 catalog rather than a length-only list or mixed original protocol", () => {
    const original = capabilities(), workspace = { version: AGENT_COMMAND_V2_DEFINITION_VERSION, contextAuthority: authority, capabilities: original };
    expect(AgentCommandV2CatalogSchema.parse(original)).toHaveLength(51);
    expect(AgentCommandV2DefinitionWorkspaceSchema.parse(workspace).capabilities).toHaveLength(51);
    for (const values of [original.slice(1), [...original, original[0]], [...original.slice(0, -1), original[0]],
      original.map(value => value.domain === "fulfillment" ? { ...value, protocol: AGENT_COMMAND_VERSION } : value),
      original.map(value => value.domain !== "fulfillment" ? { ...value, protocol: AGENT_FULFILLMENT_COMMAND_VERSION } : value)])
      expect(AgentCommandV2DefinitionWorkspaceSchema.safeParse({ ...workspace, capabilities: values }).success).toBe(false);
    for (const extra of [{ version: "erp-agent-command-definition-v1" }, { execute: true }, { autonomousWrites: true }, { operatorConfirmed: true }])
      expect(AgentCommandV2DefinitionWorkspaceSchema.safeParse({ ...workspace, ...extra }).success).toBe(false);
  });

  it("rejects unknown cross-domain keys alternate selections and caller execution or credential fields", () => {
    const first = keys[0]; if (!first) throw new Error("synthetic_legacy_key_missing");
    for (const key of [{ domain: "fulfillment", kind: "bill_record" }, { domain: "finance", kind: "shipment_review" },
      { domain: "fulfillment", kind: "marketplace_submit" }, { domain: "arbitrary", kind: "shipment_review" }, { ...first, targetId: "synthetic" }])
      expect(AgentCommandV2KeySchema.safeParse(key).success).toBe(false);
    const request = { version: AGENT_COMMAND_V2_DEFINITION_VERSION, selection: selection(first) };
    for (const extra of [{ version: AGENT_COMMAND_VERSION }, { execute: true }, { confirmationToken: "synthetic-token" },
      { requestId: "synthetic-parent-id" }, { selection: { kind: "read", command: first } },
      { selection: { ...selection(first), original: {} } }])
      expect(AgentCommandV2DefinitionRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  });

  it("pairs each definition with its exact original completion protocol and keeps checks pending", () => {
    for (const key of keys) {
      const value = definition(key), fulfillment = key.domain === "fulfillment";
      for (const extra of [{ protocol: fulfillment ? AGENT_COMMAND_VERSION : AGENT_FULFILLMENT_COMMAND_VERSION },
        { completion: fulfillment ? "legacy_original_request" : "operator_completed_original_request" },
        { effect: "execute_original_command" }, { execution: "automatic_execution" }, { autoConfirm: true }, { confirmationToken: "synthetic" }])
        expect(AgentCommandV2DefinitionSchema.safeParse({ ...value, ...extra }).success).toBe(false);
      if (!fulfillment) expect(AgentCommandV2DefinitionSchema.safeParse({ ...value, operatorChecks: agentFulfillmentOperatorChecks("delivery_feedback") }).success).toBe(false);
      for (const check of value.operatorChecks) for (const state of [true, false, "done", "verified", "approved"])
        expect(AgentCommandV2DefinitionSchema.safeParse({ ...value, operatorChecks: [{ ...check, state }] }).success).toBe(false);
    }
  });

  it("requires explicit availability reason bounded definition data and valid authority/checksum without claiming provider readiness", () => {
    const key = AgentCommandV2KeySchema.parse({ domain: "fulfillment", kind: "delivery_feedback" }), value = definition(key);
    expect(AgentCommandV2DefinitionSchema.parse({ ...value, available: false, blockReason: "current_original_read_unavailable" }).available).toBe(false);
    for (const extra of [{ available: false }, { blockReason: "current_original_read_unavailable" }, { contextAuthority: "" },
      { contextAuthority: "a".repeat(65537) }, { definitionChecksum: checksum.toUpperCase() }, { definitionChecksum: "a".repeat(63) },
      { limitations: [] }, { inputSchema: [] }, { providerConnected: true }, { executionReady: true }])
      expect(AgentCommandV2DefinitionSchema.safeParse({ ...value, ...extra }).success).toBe(false);
  });
});
