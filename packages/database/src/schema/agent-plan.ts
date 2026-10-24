import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentPlanLimits, AgentPlanPinnedInput } from "@yummyai/contracts/ai/agent-plan";
import type { AgentCommandV2Key } from "@yummyai/contracts/ai/agent-command-v2-discovery";
import type { AgentNativeV3ReadKey } from "@yummyai/contracts/ai/agent-native-v3";
import type { HarnessExecutionContract } from "@yummyai/contracts/harness";
import { aiBudgetLedger } from "./ai.js";
import { organizations, users } from "./identity.js";
import { agentCommandRequests } from "./agent-command.js";
import { orderFulfillmentCommandIntents } from "./order-fulfillment-command.js";
import { orders } from "./order.js";

/** Planning owns model proposals and their provenance, never native business facts. */
export const agentPlanRuns=pgTable("agent_plan_runs",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),
 ownerId:uuid("owner_id").notNull().references(()=>users.id),requestId:uuid("request_id").notNull(),
 version:text("version").notNull().default("erp-agent-plan-v1"),requestChecksum:text("request_checksum").notNull(),
 inputChecksum:text("input_checksum").notNull(),encryptedInput:text("encrypted_input"),
 originCeiling:jsonb("origin_ceiling").$type<TenantContext>().notNull(),
 executionContract:jsonb("execution_contract").$type<HarnessExecutionContract>().notNull(),
 readExecutionContract:jsonb("read_execution_contract").$type<HarnessExecutionContract>().notNull(),
 modelSnapshot:jsonb("model_snapshot").$type<AgentPlanPinnedInput["model"]>().notNull(),
 allowedReads:jsonb("allowed_reads").$type<AgentNativeV3ReadKey[]>().notNull(),
 allowedCommands:jsonb("allowed_commands").$type<AgentCommandV2Key[]>().notNull(),
 limits:jsonb("limits").$type<AgentPlanLimits>().notNull(),budgetLedgerId:uuid("budget_ledger_id").notNull(),capUsd:numeric("cap_usd",{precision:14,scale:6}).notNull(),
 knownCostUsd:numeric("known_cost_usd",{precision:14,scale:6}).notNull().default("0"),unknownCost:integer("unknown_cost").notNull().default(0),
 status:text("status").$type<"queued"|"running"|"stopping"|"completed"|"partial"|"failed"|"uncertain"|"stopped"|"expired">().notNull().default("queued"),
 revision:integer("revision").notNull().default(1),modelTurns:integer("model_turns").notNull().default(0),toolCalls:integer("tool_calls").notNull().default(0),observedRows:integer("observed_rows").notNull().default(0),
 leaseToken:uuid("lease_token"),leaseExpiresAt:timestamp("lease_expires_at",{withTimezone:true,mode:"date"}),dispatchCount:integer("dispatch_count").notNull().default(0),
 lastDispatchedAt:timestamp("last_dispatched_at",{withTimezone:true,mode:"date"}),nextAttemptAt:timestamp("next_attempt_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),
 stopRequestedAt:timestamp("stop_requested_at",{withTimezone:true,mode:"date"}),stopTransactionId:text("stop_transaction_id"),encryptedResult:text("encrypted_result"),resultChecksum:text("result_checksum"),errorCode:text("error_code"),creationTransactionId:text("creation_transaction_id"),
 createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),updatedAt:timestamp("updated_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),
 completedAt:timestamp("completed_at",{withTimezone:true,mode:"date"}),deadlineAt:timestamp("deadline_at",{withTimezone:true,mode:"date"}).notNull(),expiresAt:timestamp("expires_at",{withTimezone:true,mode:"date"}).notNull(),
},t=>[
 uniqueIndex("agent_plan_runs_tenant_id_unique").on(t.tenantId,t.id),uniqueIndex("agent_plan_runs_request_unique").on(t.tenantId,t.ownerId,t.requestId),uniqueIndex("agent_plan_runs_ledger_unique").on(t.tenantId,t.budgetLedgerId),
 index("agent_plan_runs_owner_idx").on(t.tenantId,t.ownerId,t.createdAt),index("agent_plan_runs_dispatch_idx").on(t.tenantId,t.status,t.nextAttemptAt),
 foreignKey({columns:[t.tenantId,t.budgetLedgerId],foreignColumns:[aiBudgetLedger.tenantId,aiBudgetLedger.id],name:"agent_plan_run_ledger_fk"}),
 check("agent_plan_runs_version_check",sql`${t.version} in ('erp-agent-plan-v1','erp-agent-native-v1','erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4')`),check("agent_plan_runs_hash_check",sql`${t.requestChecksum}~'^[a-f0-9]{64}$' and ${t.inputChecksum}~'^[a-f0-9]{64}$'`),
 check("agent_plan_runs_status_check",sql`${t.status} in ('queued','running','stopping','completed','partial','failed','uncertain','stopped','expired')`),
 check("agent_plan_runs_count_check",sql`${t.revision}>0 and ${t.modelTurns} between 0 and (case when ${t.version} in ('erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') then 48 when ${t.version}='erp-agent-native-v1' then 16 else 8 end) and ${t.toolCalls} between 0 and (case when ${t.version} in ('erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') then 192 else 32 end) and ${t.observedRows} between 0 and (case when ${t.version} in ('erp-agent-native-v1','erp-agent-native-v2','erp-agent-native-v3','erp-agent-native-v4') then 10000 else 1000 end) and ${t.dispatchCount}>=0 and ${t.unknownCost} in (0,1)`),
 check("agent_plan_runs_cost_check",sql`${t.capUsd}>0 and ${t.knownCostUsd}>=0`),check("agent_plan_runs_lease_check",sql`(${t.leaseToken} is null)=(${t.leaseExpiresAt} is null)`),
 check("agent_plan_runs_result_check",sql`(${t.encryptedResult} is null and ${t.resultChecksum} is null) or (${t.encryptedResult} is not null and ${t.resultChecksum}~'^[a-f0-9]{64}$')`),
 check("agent_plan_runs_stop_transaction_check",sql`(${t.stopRequestedAt} is null and ${t.stopTransactionId} is null) or (${t.stopRequestedAt} is not null and ${t.stopTransactionId} is not null and ${t.stopTransactionId}~'^[0-9]+$')`),
 check("agent_plan_runs_time_check",sql`${t.deadlineAt}>${t.createdAt} and ${t.expiresAt}>${t.deadlineAt}`),
]);

export const agentPlanSteps=pgTable("agent_plan_steps",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull(),runId:uuid("run_id").notNull(),sequence:integer("sequence").notNull(),
 kind:text("kind").$type<"model"|"read"|"definition">().notNull(),phase:text("phase").$type<"preparing"|"submitted"|"response_ready"|"completed"|"failed"|"uncertain">().notNull().default("preparing"),
 label:text("label").notNull(),tool:text("tool").$type<AgentNativeV3ReadKey|null>(),inputChecksum:text("input_checksum").notNull(),previousChecksum:text("previous_checksum").notNull(),encryptedInput:text("encrypted_input"),
 submissionState:text("submission_state").$type<"not_submitted"|"submitted"|"received">().notNull().default("not_submitted"),submittedAt:timestamp("submitted_at",{withTimezone:true,mode:"date"}),receivedAt:timestamp("received_at",{withTimezone:true,mode:"date"}),
 encryptedResponse:text("encrypted_response"),responseChecksum:text("response_checksum"),providerRequestId:text("provider_request_id"),inputTokens:integer("input_tokens"),outputTokens:integer("output_tokens"),costUsd:numeric("cost_usd",{precision:14,scale:6}),
 encryptedOutput:text("encrypted_output"),outputChecksum:text("output_checksum"),errorCode:text("error_code"),createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),completedAt:timestamp("completed_at",{withTimezone:true,mode:"date"}),
},t=>[
 uniqueIndex("agent_plan_steps_tenant_id_unique").on(t.tenantId,t.id),uniqueIndex("agent_plan_steps_sequence_unique").on(t.tenantId,t.runId,t.sequence),
 foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[agentPlanRuns.tenantId,agentPlanRuns.id],name:"agent_plan_step_run_fk"}),
 check("agent_plan_steps_sequence_check",sql`${t.sequence} between 1 and 96`),check("agent_plan_steps_kind_check",sql`(${t.kind}='model' and ${t.tool} is null) or (${t.kind}='definition' and (${t.tool} is null or ${t.tool} in ('orders.exceptions.page','inventory.balances.page','knowledge.search','creative.history','factory.capacity','research.evidence','catalog.sku','listing.version','orders.order','finance.profit_run','advertising.analysis','orders.fulfillment'))) or (${t.kind}='read' and ${t.tool} in ('orders.exceptions.page','inventory.balances.page','knowledge.search','creative.history','factory.capacity','research.evidence','catalog.sku','listing.version','orders.order','finance.profit_run','advertising.analysis','orders.fulfillment'))`),
 check("agent_plan_steps_phase_check",sql`${t.phase} in ('preparing','submitted','response_ready','completed','failed','uncertain')`),check("agent_plan_steps_hash_check",sql`${t.inputChecksum}~'^[a-f0-9]{64}$' and ${t.previousChecksum}~'^[a-f0-9]{64}$'`),
 check("agent_plan_steps_submission_check",sql`${t.submissionState} in ('not_submitted','submitted','received') and (${t.kind}='model' or ${t.submissionState}='not_submitted')`),
 check("agent_plan_steps_response_check",sql`${t.encryptedResponse} is null or (${t.kind}='model' and ${t.submissionState}='received' and ${t.receivedAt} is not null and ${t.responseChecksum}~'^[a-f0-9]{64}$')`),
 check("agent_plan_steps_output_check",sql`(${t.encryptedOutput} is null or ${t.outputChecksum} is not null) and (${t.outputChecksum} is null or ${t.outputChecksum}~'^[a-f0-9]{64}$')`),check("agent_plan_steps_usage_check",sql`(${t.inputTokens} is null or ${t.inputTokens}>=0) and (${t.outputTokens} is null or ${t.outputTokens}>=0) and (${t.costUsd} is null or ${t.costUsd}>=0)`),
]);

/** Explicit preparation metadata binds one immutable proposal to its original command request. */
export const agentPlanItems=pgTable("agent_plan_items",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull(),runId:uuid("run_id").notNull(),modelStepId:uuid("model_step_id").notNull(),position:integer("position").notNull(),
 proposalChecksum:text("proposal_checksum").notNull(),originalChecksum:text("original_checksum"),preparationRequestChecksum:text("preparation_request_checksum"),
 originalProtocol:text("original_protocol").$type<"erp-agent-command-v1"|"erp-agent-fulfillment-command-v1">(),originalOrderId:uuid("original_order_id"),
 fulfillmentIntentId:uuid("fulfillment_intent_id"),encryptedCompletion:text("encrypted_completion"),completionChecksum:text("completion_checksum"),
 completionBoundAt:timestamp("completion_bound_at",{withTimezone:true,mode:"date"}),completionTransactionId:text("completion_transaction_id"),
 completionRedactedAt:timestamp("completion_redacted_at",{withTimezone:true,mode:"date"}),
 creationTransactionId:text("creation_transaction_id"),preparationTransactionId:text("preparation_transaction_id"),linkTransactionId:text("link_transaction_id"),
 preparationRequestedAt:timestamp("preparation_requested_at",{withTimezone:true,mode:"date"}),agentCommandId:uuid("agent_command_id"),createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),
},t=>[
 uniqueIndex("agent_plan_items_tenant_id_unique").on(t.tenantId,t.id),uniqueIndex("agent_plan_items_position_unique").on(t.tenantId,t.runId,t.position),uniqueIndex("agent_plan_items_command_unique").on(t.tenantId,t.agentCommandId),
 foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[agentPlanRuns.tenantId,agentPlanRuns.id],name:"agent_plan_item_run_fk"}),
 foreignKey({columns:[t.tenantId,t.modelStepId],foreignColumns:[agentPlanSteps.tenantId,agentPlanSteps.id],name:"agent_plan_item_model_fk"}),
 foreignKey({columns:[t.tenantId,t.agentCommandId],foreignColumns:[agentCommandRequests.tenantId,agentCommandRequests.id],name:"agent_plan_item_command_fk"}),
 uniqueIndex("agent_plan_items_fulfillment_unique").on(t.tenantId,t.fulfillmentIntentId),
 foreignKey({columns:[t.tenantId,t.fulfillmentIntentId],foreignColumns:[orderFulfillmentCommandIntents.tenantId,orderFulfillmentCommandIntents.id],name:"agent_plan_item_fulfillment_fk"}),
 foreignKey({columns:[t.tenantId,t.originalOrderId],foreignColumns:[orders.tenantId,orders.id],name:"agent_plan_item_order_fk"}),
 check("agent_plan_items_original_protocol_check",sql`${t.originalProtocol} is null or ${t.originalProtocol} in ('erp-agent-command-v1','erp-agent-fulfillment-command-v1')`),
 check("agent_plan_items_original_xor_check",sql`not (${t.agentCommandId} is not null and ${t.fulfillmentIntentId} is not null) and (${t.fulfillmentIntentId} is null or (${t.originalProtocol} is not distinct from 'erp-agent-fulfillment-command-v1' and ${t.completionChecksum} is not null))`),
 check("agent_plan_items_completion_check",sql`(${t.completionChecksum} is null and ${t.encryptedCompletion} is null and ${t.completionBoundAt} is null and ${t.completionTransactionId} is null and ${t.completionRedactedAt} is null) or (${t.completionChecksum} is not null and ${t.completionChecksum}~'^[a-f0-9]{64}$' and ${t.originalProtocol} is not distinct from 'erp-agent-fulfillment-command-v1' and ${t.originalOrderId} is not null and ${t.originalChecksum} is not null and ${t.preparationRequestChecksum} is not null and ${t.preparationRequestedAt} is not null and ${t.completionBoundAt} is not null and ${t.completionTransactionId} is not null and ${t.completionTransactionId}~'^[0-9]+$' and ((${t.encryptedCompletion} is not null and ${t.completionRedactedAt} is null) or (${t.encryptedCompletion} is null and ${t.completionRedactedAt} is not null)))`),
 check("agent_plan_items_position_check",sql`${t.position} between 0 and 7`),check("agent_plan_items_hash_check",sql`${t.proposalChecksum}~'^[a-f0-9]{64}$' and ((${t.originalChecksum} is null and ${t.preparationRequestChecksum} is null) or (${t.originalChecksum} is not null and ${t.preparationRequestChecksum} is not null and ${t.originalChecksum}~'^[a-f0-9]{64}$' and ${t.preparationRequestChecksum}~'^[a-f0-9]{64}$'))`),
]);
