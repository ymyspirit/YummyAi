import { z } from "zod";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AgentPlanCommandKeySchema, agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AgentCommandV2CatalogSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AgentFulfillmentOperatorCheckSchema } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { FulfillmentCommandKindSchema } from "@yummyai/contracts/order/fulfillment-command";

export const AGENT_COMMAND_V2_DEFINITION_VERSION = "erp-agent-command-definition-v2" as const;
export const AgentCommandV2KeySchema = z.discriminatedUnion("domain", [
  ...AgentPlanCommandKeySchema.options, z.object({ domain: z.literal("fulfillment"), kind: FulfillmentCommandKindSchema }).strict(),
]);
export type AgentCommandV2Key = z.infer<typeof AgentCommandV2KeySchema>;
export const agentCommandV2Key = agentPlanCommandKey;
export const AgentCommandV2SelectionSchema = z.object({ kind: z.literal("command"), command: AgentCommandV2KeySchema }).strict();
export const AgentCommandV2DefinitionRequestSchema = z.object({ version: z.literal(AGENT_COMMAND_V2_DEFINITION_VERSION), selection: AgentCommandV2SelectionSchema }).strict();
export const AgentCommandV2DefinitionSchema = z.object({ version: z.literal(AGENT_COMMAND_V2_DEFINITION_VERSION), selection: AgentCommandV2SelectionSchema,
  protocol: z.enum([AGENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_VERSION]), contextAuthority: z.string().min(1).max(65536),
  available: z.boolean(), blockReason: z.string().max(200).nullable(), inputSchema: z.record(z.string(), z.unknown()),
  effect: z.literal("suggest_original_command"), execution: z.literal("separate_original_preparation_and_confirmation"),
  completion: z.enum(["legacy_original_request", "operator_completed_original_request"]),
  operatorChecks: z.array(AgentFulfillmentOperatorCheckSchema).max(3), limitations: z.array(z.string().min(1).max(1000)).min(1).max(20),
  definitionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, ctx) => {
  const fulfillment = value.selection.command.domain === "fulfillment";
  if (fulfillment ? value.protocol !== AGENT_FULFILLMENT_COMMAND_VERSION || value.completion !== "operator_completed_original_request"
    : value.protocol !== AGENT_COMMAND_VERSION || value.completion !== "legacy_original_request" || value.operatorChecks.length !== 0)
    ctx.addIssue({ code: "custom", message: "Definition must retain its original preparation protocol and completion rules" });
  if (value.available !== (value.blockReason === null)) ctx.addIssue({ code: "custom", message: "Unavailable definitions require an explicit reason" });
});
export type AgentCommandV2Definition = z.infer<typeof AgentCommandV2DefinitionSchema>;
/** Availability belongs to the current session; the contract seal does not. */
export function agentCommandV2DefinitionPayload(value: Pick<AgentCommandV2Definition,
  "version" | "selection" | "protocol" | "inputSchema" | "effect" | "execution" | "completion" | "operatorChecks" | "limitations">) {
  return { version: value.version, selection: value.selection, protocol: value.protocol, inputSchema: value.inputSchema,
    effect: value.effect, execution: value.execution, completion: value.completion, operatorChecks: value.operatorChecks, limitations: value.limitations };
}
export const AgentCommandV2DefinitionWorkspaceSchema = z.object({ version: z.literal(AGENT_COMMAND_V2_DEFINITION_VERSION),
  contextAuthority: z.string().min(1).max(65536), capabilities: AgentCommandV2CatalogSchema }).strict();
export type AgentCommandV2DefinitionWorkspace = z.infer<typeof AgentCommandV2DefinitionWorkspaceSchema>;
