import { z } from "zod";
import {
  AgentMcpDefinitionRequestSchema, AgentMcpExecuteSchema, AgentMcpSavedResultSchema,
  AgentMcpUsageSchema, AgentMcpPacketSchema, AGENT_MCP_NATIVE_OPERATIONS,
} from "@yummyai/contracts/ai/agent-mcp";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { AgentResourceMcpDefinitionRequestSchema } from "@yummyai/contracts/ai/agent-resources";
import { AgentFulfillmentMcpDefinitionSchema } from "@yummyai/contracts/ai/agent-fulfillment";

/** Explicit adapter version. Historical native/ keys and unversioned requests
 * retain their original v1 meaning, including saved IDs and canonical bodies. */
export const AGENT_MCP_V2_VERSION = "erp-agent-mcp-v2" as const;
export const AgentMcpV2NativeOperationSchema = z.enum(AGENT_MCP_NATIVE_OPERATIONS);
export const AgentMcpV2NativeDefinitionSchema = z.object({
  key: z.templateLiteral(["native-v3/", AgentMcpV2NativeOperationSchema]),
}).strict();
export const AgentMcpV2DefinitionRequestSchema = z.union([
  AgentMcpDefinitionRequestSchema, AgentResourceMcpDefinitionRequestSchema,
  AgentFulfillmentMcpDefinitionSchema, AgentMcpV2NativeDefinitionSchema,
]);
export const AgentMcpV2NativeExecuteSchema = z.object({
  version: z.literal(AGENT_NATIVE_V3_VERSION), operation: z.enum(["start", "stop", "prepare"]),
  id: z.uuidv7().nullable().default(null), itemId: z.uuidv7().nullable().default(null),
  requestJson: z.string().min(2).max(1_048_576),
}).strict().superRefine((value, context) => {
  const valid = value.operation === "start" ? value.id === null && value.itemId === null :
    value.operation === "stop" ? value.id !== null && value.itemId === null : value.id !== null && value.itemId !== null;
  if (!valid) context.addIssue({ code: "custom", message: "Operation must identify exactly its original object" });
});
export const AgentMcpV2ExecuteSchema = z.union([AgentMcpExecuteSchema, AgentMcpV2NativeExecuteSchema]);
export const AgentMcpV2NativeSavedResultSchema = z.discriminatedUnion("kind", [
  AgentMcpSavedResultSchema.options[0].extend({ version: z.literal(AGENT_NATIVE_V3_VERSION) }),
  AgentMcpSavedResultSchema.options[1].extend({ version: z.literal(AGENT_NATIVE_V3_VERSION) }),
  AgentMcpSavedResultSchema.options[2].extend({ version: z.literal(AGENT_NATIVE_V3_VERSION) }),
  z.object({ version: z.literal(AGENT_NATIVE_V3_VERSION), kind: z.literal("request_receipt_from_request"),
    requestJson: z.string().min(2).max(1_048_576) }).strict(),
]);
export const AgentMcpV2SavedResultSchema = z.union([AgentMcpSavedResultSchema, AgentMcpV2NativeSavedResultSchema]);
export const AgentMcpV2NativeUsageSchema = AgentMcpUsageSchema.extend({ version: z.literal(AGENT_NATIVE_V3_VERSION) });
export const AgentMcpV2UsageSchema = z.union([AgentMcpUsageSchema, AgentMcpV2NativeUsageSchema]);
export const AgentMcpV2PacketSchema = AgentMcpPacketSchema.extend({ version: z.literal(AGENT_MCP_V2_VERSION) });

export type AgentMcpV2Execute = z.infer<typeof AgentMcpV2ExecuteSchema>;
export type AgentMcpV2NativeExecute = z.infer<typeof AgentMcpV2NativeExecuteSchema>;
export type AgentMcpV2SavedResult = z.infer<typeof AgentMcpV2SavedResultSchema>;
export type AgentMcpV2NativeSavedResult = z.infer<typeof AgentMcpV2NativeSavedResultSchema>;
export type AgentMcpV2Usage = z.infer<typeof AgentMcpV2UsageSchema>;
export type AgentMcpV2Packet = z.infer<typeof AgentMcpV2PacketSchema>;
