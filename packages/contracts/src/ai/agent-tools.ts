import { z } from "zod";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { AgentExceptionPageInputSchema, AgentBalancePageInputSchema, AgentExceptionPageViewSchema, AgentBalancePageViewSchema } from "@yummyai/contracts/ai/agent-read";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentCommandCapabilitySchema, AgentCommandOriginalSchema } from "@yummyai/contracts/ai/agent-command";
import { KnowledgeSearchSchema, KnowledgeSearchResultSchema } from "@yummyai/contracts/knowledge";
import { CreativeHistoryScopeSchema, CreativeExecutionHistorySchema } from "@yummyai/contracts/harness/creative-operator";
import { FactoryCapacityQuerySchema, FactoryCapacityWorkspaceSchema } from "@yummyai/contracts/suppliers/factory-capacity";

/** Independent protocol. Existing read/loop/plan pins and saved inputs stay unchanged. */
export const AGENT_TOOLS_VERSION = "erp-agent-tools-v1" as const;
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Authority = z.string().min(1).max(65_536);
export const AgentToolKeySchema = z.enum(["orders.exceptions.page", "inventory.balances.page", "knowledge.search", "creative.history", "factory.capacity"]);
export type AgentToolKey = z.infer<typeof AgentToolKeySchema>;
export const AgentCreativeHistoryInputSchema = z.object({ scope: CreativeHistoryScopeSchema, ownerId: z.uuidv7(), after: z.uuidv7().optional() }).strict();
export const AgentFactoryCapacityInputSchema = z.object({ factoryId: z.uuidv7(), query: FactoryCapacityQuerySchema }).strict();
export const agentToolInputSchemas = {
  "orders.exceptions.page": AgentExceptionPageInputSchema,
  "inventory.balances.page": AgentBalancePageInputSchema,
  "knowledge.search": KnowledgeSearchSchema,
  "creative.history": AgentCreativeHistoryInputSchema,
  "factory.capacity": AgentFactoryCapacityInputSchema,
} as const;
export const agentToolOutputSchemas = {
  "orders.exceptions.page": AgentExceptionPageViewSchema,
  "inventory.balances.page": AgentBalancePageViewSchema,
  "knowledge.search": KnowledgeSearchResultSchema,
  "creative.history": CreativeExecutionHistorySchema,
  "factory.capacity": FactoryCapacityWorkspaceSchema,
} as const;
export type AgentToolInput<K extends AgentToolKey> = z.infer<(typeof agentToolInputSchemas)[K]>;
export type AgentToolOutput<K extends AgentToolKey> = z.infer<(typeof agentToolOutputSchemas)[K]>;
const Version = { version: z.literal(AGENT_TOOLS_VERSION) };
const Call = { ...Version, executionContract: HarnessExecutionContractSchema, definitionChecksum: Hash };
export const AgentToolCallSchema = z.discriminatedUnion("tool", [
  z.object({ ...Call, tool: z.literal("orders.exceptions.page"), input: AgentExceptionPageInputSchema }).strict(),
  z.object({ ...Call, tool: z.literal("inventory.balances.page"), input: AgentBalancePageInputSchema }).strict(),
  z.object({ ...Call, tool: z.literal("knowledge.search"), input: KnowledgeSearchSchema }).strict(),
  z.object({ ...Call, tool: z.literal("creative.history"), input: AgentCreativeHistoryInputSchema }).strict(),
  z.object({ ...Call, tool: z.literal("factory.capacity"), input: AgentFactoryCapacityInputSchema }).strict(),
]);
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;
export const AgentToolSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), tool: AgentToolKeySchema }).strict(),
  z.object({ kind: z.literal("command"), command: AgentPlanCommandKeySchema }).strict(),
]);
export type AgentToolSelection = z.infer<typeof AgentToolSelectionSchema>;
export const AgentToolDefinitionRequestSchema = z.object({ ...Version, selection: AgentToolSelectionSchema }).strict();
export const AgentToolDefinitionSchema = z.object({
  ...Version, contextAuthority: Authority, selection: AgentToolSelectionSchema, definitionChecksum: Hash,
  inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()),
  effect: z.enum(["read", "prepare_original_command"]), available: z.boolean(), blockReason: z.string().max(160).nullable(),
  execution: z.enum(["registered_native_reader", "separate_original_preparation_and_confirmation"]),
  limitations: z.array(z.string().max(500)).max(10),
}).strict();
export type AgentToolDefinition = z.infer<typeof AgentToolDefinitionSchema>;
/** The exact payload hashed by the gateway and browser. Availability is checked afresh. */
export function agentToolDefinitionPayload(definition: Pick<AgentToolDefinition, "version" | "selection" | "inputSchema" | "outputSchema" | "effect" | "execution" | "limitations">) {
  const { version, selection, inputSchema, outputSchema, effect, execution, limitations } = definition;
  return { version, selection, inputSchema, outputSchema, effect, execution, limitations };
}
export const AgentToolObjectQuerySchema = z.object({ ...Version, kind: z.literal("creative"), scope: z.enum(["design_batch", "inspection", "mockup_batch"]) }).strict();
export const AgentToolObjectsSchema = z.object({ ...Version, contextAuthority: Authority, query: AgentToolObjectQuerySchema,
  items: z.array(z.object({ id: z.uuidv7(), label: z.string().min(1).max(500) }).strict()).max(500),
  limit: z.union([z.literal(200), z.literal(500)]), complete: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.limit !== (value.query.scope === "inspection" ? 500 : 200) || value.items.length > value.limit || new Set(value.items.map(item => item.id)).size !== value.items.length)
    ctx.addIssue({ code: "custom", message: "Candidates must preserve the native bounded object list" });
});
export const AgentToolWorkspaceSchema = z.object({
  ...Version, contextAuthority: Authority, executionContract: HarnessExecutionContractSchema,
  tools: z.array(z.object({ key: AgentToolKeySchema, label: z.string().max(120), available: z.boolean(),
    blockReason: z.string().max(160).nullable(), effect: z.literal("read"), limitations: z.array(z.string().max(500)).max(10) }).strict()).length(5),
  commands: z.array(AgentCommandCapabilitySchema).length(37),
  modelExecution: z.literal("not_connected_to_legacy_loops"), mcpState: z.literal("not_connected"),
}).strict();
export type AgentToolWorkspace = z.infer<typeof AgentToolWorkspaceSchema>;
export const AgentToolCoverageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paged_collection"), complete: z.boolean(), total: z.int().nonnegative(), readCount: z.int().nonnegative(), nextCursor: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("ranked_subset"), complete: z.literal(false), scanned: z.int().nonnegative(), returned: z.int().min(0).max(6) }).strict(),
  z.object({ kind: z.literal("bounded_history"), complete: z.literal(false), returned: z.int().min(0).max(20), nextCursor: z.uuidv7().nullable(), eventsMayBeTruncated: z.boolean() }).strict(),
  z.object({ kind: z.literal("bounded_snapshot"), complete: z.literal(false), from: z.iso.date(), days: z.int().min(1).max(31), pools: z.int().min(0).max(200) }).strict(),
]);
const Result = { ...Version, callId: z.uuidv7(), contextAuthority: Authority, definitionChecksum: Hash,
  checkedAt: z.iso.datetime(), inputChecksum: Hash, dataChecksum: Hash, coverage: AgentToolCoverageSchema };
export const AgentToolResultSchema = z.discriminatedUnion("tool", [
  z.object({ ...Result, tool: z.literal("orders.exceptions.page"), data: AgentExceptionPageViewSchema }).strict(),
  z.object({ ...Result, tool: z.literal("inventory.balances.page"), data: AgentBalancePageViewSchema }).strict(),
  z.object({ ...Result, tool: z.literal("knowledge.search"), data: KnowledgeSearchResultSchema }).strict(),
  z.object({ ...Result, tool: z.literal("creative.history"), data: CreativeExecutionHistorySchema }).strict(),
  z.object({ ...Result, tool: z.literal("factory.capacity"), data: FactoryCapacityWorkspaceSchema }).strict(),
]).superRefine((value, ctx) => {
  const expected = value.tool === "knowledge.search" ? "ranked_subset" : value.tool === "creative.history" ? "bounded_history" : value.tool === "factory.capacity" ? "bounded_snapshot" : "paged_collection";
  if (value.coverage.kind !== expected) ctx.addIssue({ code: "custom", path: ["coverage"], message: "Coverage must describe this native owner" });
  if (value.coverage.kind === "paged_collection" && (value.coverage.complete !== (value.coverage.readCount === value.coverage.total) || value.coverage.complete !== (value.coverage.nextCursor === null)))
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "A prefix cannot prove the entire collection" });
  let bound = false;
  switch (value.tool) {
    case "knowledge.search": bound = value.coverage.kind === "ranked_subset" && value.coverage.scanned === value.data.scanned && value.coverage.returned === value.data.references.length; break;
    case "creative.history": bound = value.coverage.kind === "bounded_history" && value.coverage.returned === value.data.entries.length && value.coverage.nextCursor === value.data.nextCursor && value.coverage.eventsMayBeTruncated === value.data.entries.some(entry => entry.hasMoreEvents); break;
    case "factory.capacity": bound = value.coverage.kind === "bounded_snapshot" && value.coverage.from === value.data.from && value.coverage.days === value.data.days && value.coverage.pools === value.data.pools.length; break;
    default: bound = value.coverage.kind === "paged_collection" && value.coverage.complete === value.data.complete && value.coverage.total === value.data.total && value.coverage.readCount === value.data.readCount && value.coverage.nextCursor === value.data.nextCursor;
  }
  if (!bound) ctx.addIssue({ code: "custom", path: ["coverage"], message: "Coverage must equal the actual native response" });
});
export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;

/** Load exactly one original branch. Transform/refinement validation remains the native parser's job. */
export function agentToolCommandInput(selection: z.infer<typeof AgentPlanCommandKeySchema>) {
  const selected = AgentPlanCommandKeySchema.parse(selection);
  const owner = AgentCommandOriginalSchema.options.find(option => option.shape.domain.value === selected.domain)!;
  const union = owner.shape.command instanceof z.ZodPipe ? owner.shape.command.in : owner.shape.command;
  const native = union.options.find(option => option.shape.kind.value === selected.kind);
  if (!native) throw new Error("Original command branch not registered");
  return z.object({ domain: z.literal(selected.domain), command: native }).strict();
}
