import { z } from "zod";
import { AgentReadinessFamilySchema, AgentReadinessSchema } from "@yummyai/contracts/ai/agent-readiness";
import { AgentMcpV2DefinitionRequestSchema, AgentMcpV2ExecuteSchema } from "@yummyai/contracts/ai/agent-mcp-v2";
import { AgentToolKeySchema } from "@yummyai/contracts/ai/agent-tools";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentResourceKeySchema } from "@yummyai/contracts/ai/agent-resources";

/** A separately versioned, metadata-only input on the existing MCP v2 transport.
 * No historical native operation or saved identifier changes meaning. */
export const AGENT_MCP_READINESS_VERSION = "erp-agent-mcp-readiness-v1" as const;
// Native-v4 host authorization is a separate capability, not inherited from the current web sidecar.
const McpReadinessFamilySchema = AgentReadinessFamilySchema.exclude(["native_v4"]);
export const AgentMcpReadinessKeySchema = z.templateLiteral(["readiness/", McpReadinessFamilySchema]);
export const AgentMcpReadinessDefinitionRequestSchema = z.object({ key: AgentMcpReadinessKeySchema }).strict();
export const AgentMcpReadinessCallSchema = z.object({
  version: z.literal(AGENT_MCP_READINESS_VERSION), family: McpReadinessFamilySchema,
}).strict();
export const AgentMcpReadinessV2DefinitionSchema = z.union([AgentMcpV2DefinitionRequestSchema, AgentMcpReadinessDefinitionRequestSchema]);
export const AgentMcpReadinessV2ExecuteSchema = z.union([AgentMcpV2ExecuteSchema, AgentMcpReadinessCallSchema]);

export const AgentMcpReadinessStartupPolicySchema = z.object({
  allowedFamilies: z.array(McpReadinessFamilySchema).min(1).max(5),
  allowModelRun: z.boolean(), maxCostUsd: z.number().finite().min(0).max(100),
  allowPrepare: z.boolean(), allowNativeV3: z.boolean(),
  allowedReads: z.array(AgentToolKeySchema).min(1).max(5),
  allowedCommands: z.array(AgentPlanCommandKeySchema).max(37),
  allowedResources: z.array(AgentResourceKeySchema).max(6), allowFulfillment: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.allowedFamilies).size !== value.allowedFamilies.length || new Set(value.allowedReads).size !== value.allowedReads.length
    || new Set(value.allowedResources).size !== value.allowedResources.length
    || new Set(value.allowedCommands.map(item => item.domain + "/" + item.kind)).size !== value.allowedCommands.length
    || value.allowModelRun !== (value.maxCostUsd > 0) || value.allowPrepare && value.allowedCommands.length === 0) {
    context.addIssue({ code: "custom", message: "MCP readiness requires a consistent immutable startup policy" });
  }
});
export const AgentMcpReadinessResultSchema = z.object({
  version: z.literal(AGENT_MCP_READINESS_VERSION), family: McpReadinessFamilySchema,
  contextAuthority: AgentReadinessSchema.shape.contextAuthority,
  diagnostic: AgentReadinessSchema, startupPolicy: AgentMcpReadinessStartupPolicySchema,
  startTransport: z.enum(["original_native_v1", "explicit_native_v3", "not_registered"]),
  paidSubmissionEnabledByStartup: z.boolean(),
  advisoryOnly: z.literal(true), selectedMcpStartInputsChecked: z.literal(false),
}).strict().superRefine((value, context) => {
  const transport = value.family === "native_v1" ? "original_native_v1" :
    value.family === "native_v3" && value.startupPolicy.allowNativeV3 ? "explicit_native_v3" : "not_registered";
  if (value.family !== value.diagnostic.family || value.contextAuthority !== value.diagnostic.contextAuthority
    || !value.startupPolicy.allowedFamilies.includes(value.family) || value.startTransport !== transport
    || value.paidSubmissionEnabledByStartup !== (transport !== "not_registered" && value.startupPolicy.allowModelRun)) {
    context.addIssue({ code: "custom", message: "Original diagnosis and MCP startup authority must remain distinct and consistent" });
  }
});
export type AgentMcpReadinessCall = z.infer<typeof AgentMcpReadinessCallSchema>;
export type AgentMcpReadinessStartupPolicy = z.infer<typeof AgentMcpReadinessStartupPolicySchema>;
export type AgentMcpReadinessResult = z.infer<typeof AgentMcpReadinessResultSchema>;
