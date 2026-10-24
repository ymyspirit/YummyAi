import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentLoopLimits, AgentLoopPinnedInput } from "@yummyai/contracts/ai/agent-loop";
import type { AgentReadToolKey } from "@yummyai/contracts/ai/agent-read";
import type { HarnessExecutionContract } from "@yummyai/contracts/harness";
import { aiBudgetLedger } from "./ai.js";
import { organizations, users } from "./identity.js";

export const agentLoopRuns = pgTable("agent_loop_runs", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id), requestId: uuid("request_id").notNull(),
  version: text("version").notNull().default("erp-agent-loop-v1"), requestChecksum: text("request_checksum").notNull(),
  inputChecksum: text("input_checksum").notNull(), encryptedInput: text("encrypted_input"),
  originCeiling: jsonb("origin_ceiling").$type<TenantContext>().notNull(),
  executionContract: jsonb("execution_contract").$type<HarnessExecutionContract>().notNull(),
  readExecutionContract: jsonb("read_execution_contract").$type<HarnessExecutionContract>().notNull(),
  modelSnapshot: jsonb("model_snapshot").$type<AgentLoopPinnedInput["model"]>().notNull(),
  allowedTools: jsonb("allowed_tools").$type<AgentReadToolKey[]>().notNull(),
  limits: jsonb("limits").$type<AgentLoopLimits>().notNull(),
  budgetLedgerId: uuid("budget_ledger_id").notNull(), capUsd: numeric("cap_usd", { precision: 14, scale: 6 }).notNull(),
  knownCostUsd: numeric("known_cost_usd", { precision: 14, scale: 6 }).notNull().default("0"),
  unknownCost: integer("unknown_cost").notNull().default(0),
  status: text("status").$type<"queued" | "running" | "stopping" | "completed" | "partial" | "failed" | "uncertain" | "stopped" | "expired">().notNull().default("queued"),
  revision: integer("revision").notNull().default(1), modelTurns: integer("model_turns").notNull().default(0),
  toolCalls: integer("tool_calls").notNull().default(0), observedRows: integer("observed_rows").notNull().default(0),
  leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
  dispatchCount: integer("dispatch_count").notNull().default(0),
  lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true, mode: "date" }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true, mode: "date" }),
  encryptedResult: text("encrypted_result"), resultChecksum: text("result_checksum"), errorCode: text("error_code"),
  creationTransactionId: text("creation_transaction_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: "date" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
}, t => [
  uniqueIndex("agent_loop_runs_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("agent_loop_runs_request_unique").on(t.tenantId, t.ownerId, t.requestId),
  uniqueIndex("agent_loop_runs_ledger_unique").on(t.tenantId, t.budgetLedgerId),
  index("agent_loop_runs_owner_idx").on(t.tenantId, t.ownerId, t.createdAt),
  index("agent_loop_runs_dispatch_idx").on(t.tenantId, t.status, t.nextAttemptAt),
  foreignKey({ columns: [t.tenantId, t.budgetLedgerId], foreignColumns: [aiBudgetLedger.tenantId, aiBudgetLedger.id], name: "agent_loop_run_ledger_fk" }),
  check("agent_loop_runs_version_check", sql`${t.version}='erp-agent-loop-v1'`),
  check("agent_loop_runs_hash_check", sql`${t.requestChecksum}~'^[a-f0-9]{64}$' and ${t.inputChecksum}~'^[a-f0-9]{64}$'`),
  check("agent_loop_runs_status_check", sql`${t.status} in ('queued','running','stopping','completed','partial','failed','uncertain','stopped','expired')`),
  check("agent_loop_runs_count_check", sql`${t.revision}>0 and ${t.modelTurns} between 0 and 8 and ${t.toolCalls} between 0 and 32 and ${t.observedRows} between 0 and 1000 and ${t.dispatchCount}>=0 and ${t.unknownCost} in (0,1)`),
  check("agent_loop_runs_cost_check", sql`${t.capUsd}>0 and ${t.knownCostUsd}>=0`),
  check("agent_loop_runs_lease_check", sql`(${t.leaseToken} is null)=(${t.leaseExpiresAt} is null)`),
  check("agent_loop_runs_result_check", sql`(${t.encryptedResult} is null and ${t.resultChecksum} is null) or (${t.encryptedResult} is not null and ${t.resultChecksum}~'^[a-f0-9]{64}$')`),
  check("agent_loop_runs_time_check", sql`${t.deadlineAt}>${t.createdAt} and ${t.expiresAt}>${t.deadlineAt}`),
]);

export const agentLoopSteps = pgTable("agent_loop_steps", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull(), runId: uuid("run_id").notNull(),
  sequence: integer("sequence").notNull(), kind: text("kind").$type<"model" | "read">().notNull(),
  phase: text("phase").$type<"preparing" | "submitted" | "response_ready" | "completed" | "failed" | "uncertain">().notNull().default("preparing"),
  label: text("label").notNull(), tool: text("tool").$type<AgentReadToolKey | null>(),
  inputChecksum: text("input_checksum").notNull(), previousChecksum: text("previous_checksum").notNull(), encryptedInput: text("encrypted_input"),
  submissionState: text("submission_state").$type<"not_submitted" | "submitted" | "received">().notNull().default("not_submitted"),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }),
  encryptedResponse: text("encrypted_response"), responseChecksum: text("response_checksum"), providerRequestId: text("provider_request_id"),
  inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"), costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
  encryptedOutput: text("encrypted_output"), outputChecksum: text("output_checksum"), errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
}, t => [
  uniqueIndex("agent_loop_steps_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("agent_loop_steps_sequence_unique").on(t.tenantId, t.runId, t.sequence),
  foreignKey({ columns: [t.tenantId, t.runId], foreignColumns: [agentLoopRuns.tenantId, agentLoopRuns.id], name: "agent_loop_step_run_fk" }),
  check("agent_loop_steps_sequence_check", sql`${t.sequence} between 1 and 16`),
  check("agent_loop_steps_kind_check", sql`(${t.kind}='model' and ${t.tool} is null) or (${t.kind}='read' and ${t.tool} in ('orders.exceptions.page','inventory.balances.page'))`),
  check("agent_loop_steps_phase_check", sql`${t.phase} in ('preparing','submitted','response_ready','completed','failed','uncertain')`),
  check("agent_loop_steps_hash_check", sql`${t.inputChecksum}~'^[a-f0-9]{64}$' and ${t.previousChecksum}~'^[a-f0-9]{64}$'`),
  check("agent_loop_steps_submission_check", sql`${t.submissionState} in ('not_submitted','submitted','received') and (${t.kind}='model' or ${t.submissionState}='not_submitted')`),
  check("agent_loop_steps_response_check", sql`${t.encryptedResponse} is null or (${t.kind}='model' and ${t.submissionState}='received' and ${t.receivedAt} is not null and ${t.responseChecksum}~'^[a-f0-9]{64}$')`),
  check("agent_loop_steps_output_check", sql`(${t.encryptedOutput} is null or ${t.outputChecksum} is not null) and (${t.outputChecksum} is null or ${t.outputChecksum}~'^[a-f0-9]{64}$')`),
  check("agent_loop_steps_usage_check", sql`(${t.inputTokens} is null or ${t.inputTokens}>=0) and (${t.outputTokens} is null or ${t.outputTokens}>=0) and (${t.costUsd} is null or ${t.costUsd}>=0)`),
]);
