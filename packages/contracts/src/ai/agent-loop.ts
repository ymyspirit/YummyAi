import { z } from "zod";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { AssistModelSchema } from "@yummyai/contracts/ai/assist";
import { AgentReadToolKeySchema, AgentReadWorkspaceSchema, AgentExceptionItemSchema, AgentBalanceItemSchema } from "@yummyai/contracts/ai/agent-read";

export const AGENT_LOOP_VERSION = "erp-agent-loop-v1" as const;
export const AGENT_LOOP_INTENT_PREFIX = "yummyai.agent-loop.intent.v1:";
export const AGENT_LOOP_INTENT_CLEAR_EVENT = "yummyai.agent-loop-intents-cleared";
const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime();
const Money = z.string().max(30).regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const Version = { version: z.literal(AGENT_LOOP_VERSION) };
export const AgentLoopLimitsSchema = z.object({
  maxModelTurns: z.int().min(2).max(8), maxToolCalls: z.int().min(2).max(32),
  maxRows: z.int().min(1).max(1000), maxOutputTokens: z.int().min(128).max(4096),
  maxPromptBytes: z.int().min(4096).max(1_048_576), deadlineSeconds: z.int().min(30).max(600),
}).strict();
export const defaultAgentLoopLimits = () => AgentLoopLimitsSchema.parse({ maxModelTurns: 4, maxToolCalls: 16,
  maxRows: 500, maxOutputTokens: 2048, maxPromptBytes: 1_048_576, deadlineSeconds: 600 });
export const maximumAgentLoopLimits = () => AgentLoopLimitsSchema.parse({ maxModelTurns: 8, maxToolCalls: 32,
  maxRows: 1000, maxOutputTokens: 4096, maxPromptBytes: 1_048_576, deadlineSeconds: 600 });
export const AgentLoopReadRequestSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("orders.exceptions.page"), query: z.object({
    status: z.enum(["all", "open", "resolved"]), orderId: Id.nullable(),
  }).strict() }).strict(),
  z.object({ tool: z.literal("inventory.balances.page"), query: z.object({
    stockItemId: Id.nullable(), locationId: Id.nullable(),
  }).strict() }).strict(),
]);
const BaseCollection = {
  stepId: Id, queryChecksum: Hash, collectionFingerprint: Hash, checkedAt: Time,
  total: z.int().nonnegative(), readCount: z.int().nonnegative(), complete: z.boolean(),
  limitReason: z.enum(["row_limit", "tool_limit"]).nullable(),
};
const Collection = z.discriminatedUnion("tool", [
  z.object({ ...BaseCollection, tool: z.literal("orders.exceptions.page"), query: AgentLoopReadRequestSchema.options[0].shape.query,
    rows: z.array(z.object({ sourceId: Id, sourceChecksum: Hash, data: AgentExceptionItemSchema }).strict()).max(1000) }).strict(),
  z.object({ ...BaseCollection, tool: z.literal("inventory.balances.page"), query: AgentLoopReadRequestSchema.options[1].shape.query,
    rows: z.array(z.object({ sourceId: Id, sourceChecksum: Hash, data: AgentBalanceItemSchema }).strict()).max(1000) }).strict(),
]);
export const AgentLoopCollectionSchema = Collection.superRefine((value, ctx) => {
  if (value.readCount !== value.rows.length || value.readCount > value.total ||
    value.complete !== (value.readCount === value.total) || value.complete !== (value.limitReason === null) ||
    new Set(value.rows.map(row => row.sourceId)).size !== value.rows.length || value.rows.some(row => row.sourceId !== row.data.id))
    ctx.addIssue({ code: "custom", message: "Invalid bounded collection evidence" });
});
export const AgentLoopClaimSchema = z.object({
  stepId: Id, sourceId: z.union([Id, z.literal("$collection")]), sourceChecksum: Hash,
  field: z.enum(["total", "category", "status", "eventMissing", "sequence", "orderSequence", "openedAt", "resolvedAt",
    "unit", "physicalQuantity", "reservedQuantity", "availableQuantity", "inTransitQuantity", "providerQuantity", "virtualQuantity", "projectionVersion", "updatedAt"]),
  value: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
}).strict();
export const AgentLoopResultSchema = z.object({
  summary: z.string().min(1).max(4000), claims: z.array(AgentLoopClaimSchema).max(100),
  missingInformation: z.array(z.string().min(1).max(500)).max(30),
}).strict();
/** A typed model decision drives real registered tools. This is independent of
 * provider-native function-call wire formats and all nine legacy Assist kinds. */
export const AgentLoopDecisionSchema = z.object({
  action: z.enum(["read", "finish"]), label: z.string().min(1).max(160),
  read: AgentLoopReadRequestSchema.nullable(), result: AgentLoopResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "read" ? !value.read || value.result !== null : !value.result || value.read !== null)
    ctx.addIssue({ code: "custom", message: "Decision action and payload disagree" });
});
export const CreateAgentLoopSchema = z.object({ ...Version, requestId: z.uuid(), goal: z.string().trim().min(2).max(2000),
  modelId: Id, allowedTools: z.array(AgentReadToolKeySchema).min(1).max(2), limits: AgentLoopLimitsSchema,
  maxCostUsd: z.number().finite().min(0.000001).max(100).multipleOf(0.000001), executionContract: HarnessExecutionContractSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allowedTools).size !== value.allowedTools.length) ctx.addIssue({ code: "custom", message: "Duplicate selected tool" });
});
export const AgentLoopStatusSchema = z.enum(["queued", "running", "stopping", "completed", "partial", "failed", "uncertain", "stopped", "expired"]);
export const AgentLoopStepPhaseSchema = z.enum(["preparing", "submitted", "response_ready", "completed", "failed", "uncertain"]);
export const AgentLoopStepViewSchema = z.object({
  id: Id, sequence: z.int().min(1).max(16), kind: z.enum(["model", "read"]), phase: AgentLoopStepPhaseSchema,
  label: z.string().max(160), tool: AgentReadToolKeySchema.nullable(), inputChecksum: Hash,
  outputChecksum: Hash.nullable(), submissionState: z.enum(["not_submitted", "submitted", "received"]),
  providerRequestId: z.string().max(512).nullable(), inputTokens: z.int().nonnegative().nullable(),
  outputTokens: z.int().nonnegative().nullable(), costUsd: Money.nullable(), errorCode: z.string().max(100).nullable(),
  createdAt: Time, completedAt: Time.nullable(),
}).strict();
export const AgentLoopCostSchema = z.object({
  capUsd: Money, knownCostUsd: Money, reservedUsd: Money,
  coverage: z.enum(["known", "partial", "unknown"]), modelTurns: z.int().min(0).max(8),
}).strict();
export const AgentLoopRunViewSchema = z.object({ ...Version, id: Id, requestId: z.uuid(), requestChecksum: Hash,
  contextAuthority: z.string().min(1).max(65_536), revision: z.int().positive(), status: AgentLoopStatusSchema,
  goal: z.string().max(2000).nullable(), modelLabel: z.string().max(200), allowedTools: z.array(AgentReadToolKeySchema).min(1).max(2),
  executionContract: HarnessExecutionContractSchema, limits: AgentLoopLimitsSchema, cost: AgentLoopCostSchema,
  toolCalls: z.int().nonnegative(), observedRows: z.int().nonnegative(), stopRequestedAt: Time.nullable(),
  errorCode: z.string().max(100).nullable(), createdAt: Time, updatedAt: Time, deadlineAt: Time, expiresAt: Time,
  privateAvailable: z.boolean(), stepsComplete: z.literal(true), steps: z.array(AgentLoopStepViewSchema).max(16),
  collections: z.array(AgentLoopCollectionSchema).max(7), result: AgentLoopResultSchema.nullable(),
  verification: z.enum(["pending", "field_values_and_collection_versions", "not_adopted"]),
}).strict();
export const AgentLoopReceiptQuerySchema = z.object({ requestId: z.uuid(), requestChecksum: Hash }).strict();
export const AgentLoopReceiptSchema = z.object({ ...Version, requestId: z.uuid(), requestChecksum: Hash,
  disposition: z.enum(["known", "not_found"]), runId: Id.nullable(), status: AgentLoopStatusSchema.nullable(),
  contextAuthority: z.string().min(1).max(65_536), privateAvailable: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? !value.runId || !value.status : value.runId !== null || value.status !== null || value.privateAvailable)
    ctx.addIssue({ code: "custom", message: "Receipt disposition and identity disagree" });
});
/** Stop is monotone for this immutable original request; a lost read permission
 * must not require recovering a private run revision merely to halt later work. */
export const StopAgentLoopSchema = z.object({ ...Version, requestId: z.uuid() }).strict();
export const AgentLoopWorkspaceSchema = z.object({ ...Version, contextAuthority: z.string().min(1).max(65_536),
  executionContract: HarnessExecutionContractSchema, readWorkspace: AgentReadWorkspaceSchema,
  models: z.array(AssistModelSchema).max(200), limits: AgentLoopLimitsSchema, canStart: z.boolean(),
  recent: z.array(z.object({ id: Id, requestId: z.uuid(), status: AgentLoopStatusSchema, createdAt: Time }).strict()).max(20),
  recentLimit: z.literal(20), recentHasMore: z.boolean(), mcpState: z.literal("not_connected"),
}).strict();
/** Seven scalar fields only. No goal, model prompt, cursor or business body. */
export const AgentLoopIntentSchema = z.object({ version: z.literal(1), ownerScope: Hash,
  requestId: z.uuid(), requestChecksum: Hash, runId: Id.nullable(), state: z.enum(["prepared", "unknown", "known"]), createdAt: Time,
}).strict();
export const AgentLoopPinnedInputSchema = z.object({ ...Version, request: CreateAgentLoopSchema,
  ceiling: TenantContextSchema, model: AssistModelSchema.extend({ providerConfigId: Id, routeFingerprint: Hash }),
  readExecutionContract: HarnessExecutionContractSchema,
}).strict();
export type CreateAgentLoop = z.infer<typeof CreateAgentLoopSchema>;
export type AgentLoopLimits = z.infer<typeof AgentLoopLimitsSchema>;
export type AgentLoopReadRequest = z.infer<typeof AgentLoopReadRequestSchema>;
export type AgentLoopCollection = z.infer<typeof AgentLoopCollectionSchema>;
export type AgentLoopDecision = z.infer<typeof AgentLoopDecisionSchema>;
export type AgentLoopResult = z.infer<typeof AgentLoopResultSchema>;
export type AgentLoopPinnedInput = z.infer<typeof AgentLoopPinnedInputSchema>;
export type AgentLoopRunView = z.infer<typeof AgentLoopRunViewSchema>;
export type AgentLoopStepView = z.infer<typeof AgentLoopStepViewSchema>;
export type AgentLoopWorkspace = z.infer<typeof AgentLoopWorkspaceSchema>;
export type AgentLoopReceipt = z.infer<typeof AgentLoopReceiptSchema>;
export type AgentLoopIntent = z.infer<typeof AgentLoopIntentSchema>;
