import { z } from "zod";
import { AgentToolKeySchema, type AgentToolSelection } from "@yummyai/contracts/ai/agent-tools";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";

/** The MCP adapter reuses original ERP requests; it never defines a business write. */
export const AGENT_MCP_VERSION = "erp-agent-mcp-v1" as const;
export const AGENT_MCP_TOOL_NAMES = {
  search: "erp_capabilities_search", schema: "erp_tool_schema", execute: "erp_execute",
  savedResult: "erp_saved_result", usage: "erp_usage",
} as const;
export const AGENT_MCP_NATIVE_OPERATIONS = ["start", "stop", "prepare", "run", "receipt", "item_receipt", "usage"] as const;
export type AgentMcpNativeOperation = typeof AGENT_MCP_NATIVE_OPERATIONS[number];
export type AgentMcpCapability = AgentToolSelection | { kind: "native"; operation: AgentMcpNativeOperation };

export function parseAgentMcpCapabilityKey(key: string): AgentMcpCapability {
  const parts = key.split("/");
  if (parts.length === 2 && parts[0] === "read") return { kind: "read", tool: AgentToolKeySchema.parse(parts[1]) };
  if (parts.length === 3 && parts[0] === "command") {
    return { kind: "command", command: AgentPlanCommandKeySchema.parse({ domain: parts[1], kind: parts[2] }) };
  }
  if (parts.length === 2 && parts[0] === "native") {
    return { kind: "native", operation: z.enum(AGENT_MCP_NATIVE_OPERATIONS).parse(parts[1]) };
  }
  throw new Error("agent_mcp_capability_invalid");
}
const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const CapabilityKey = z.string().min(1).max(160).refine(value => {
  try { parseAgentMcpCapabilityKey(value); return true; } catch { return false; }
}, "Unregistered ERP capability");
export const AgentMcpSearchSchema = z.object({
  query: z.string().trim().max(200).default(""), kind: z.enum(["all", "read", "command", "native"]).default("all"),
  limit: z.int().min(1).max(100).default(100),
}).strict();
export const AgentMcpDefinitionRequestSchema = z.object({ key: CapabilityKey }).strict();
export const AgentMcpExecuteSchema = z.object({
  operation: z.enum(["read", "start", "stop", "prepare"]), id: Id.nullable().default(null),
  itemId: Id.nullable().default(null), requestJson: z.string().min(2).max(1_048_576),
}).strict().superRefine((value, ctx) => {
  const valid = value.operation === "read" || value.operation === "start" ? value.id === null && value.itemId === null :
    value.operation === "stop" ? value.id !== null && value.itemId === null : value.id !== null && value.itemId !== null;
  if (!valid) ctx.addIssue({ code: "custom", message: "Operation must identify exactly its original object" });
});
export const AgentMcpSavedResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: Id }).strict(),
  z.object({ kind: z.literal("request_receipt"), requestId: z.uuid(), requestChecksum: Hash }).strict(),
  z.object({ kind: z.literal("item_receipt"), id: Id, itemId: Id, requestId: z.uuid(), proposalChecksum: Hash }).strict(),
  z.object({ kind: z.literal("command"), id: Id, originalChecksum: Hash }).strict(),
]);
export const AgentMcpUsageSchema = z.object({ id: Id }).strict();
export const AgentMcpPacketSchema = z.object({
  version: z.literal(AGENT_MCP_VERSION),
  kind: z.enum(["capabilities", "definition", "read", "run", "receipt", "item_receipt", "command_receipt", "usage", "error"]),
  contextAuthority: z.string().min(1).max(65_536).nullable(), data: z.record(z.string(), z.unknown()),
}).strict();
export type AgentMcpSearch = z.infer<typeof AgentMcpSearchSchema>;
export type AgentMcpDefinitionRequest = z.infer<typeof AgentMcpDefinitionRequestSchema>;
export type AgentMcpExecute = z.infer<typeof AgentMcpExecuteSchema>;
export type AgentMcpSavedResult = z.infer<typeof AgentMcpSavedResultSchema>;
export type AgentMcpUsage = z.infer<typeof AgentMcpUsageSchema>;
export type AgentMcpPacket = z.infer<typeof AgentMcpPacketSchema>;
