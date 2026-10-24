import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, numeric, jsonb, uniqueIndex, index, foreignKey, check } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { orderWorkItems, orderWorkRevisions } from "./order-workspace.js";
import { productionEditorProjects, productionEditorVersions } from "./production-editor.js";

/** Infrastructure routing index only. Contains no order or execution data. */
export const orderDesignDispatchTenants = pgTable("order_design_dispatch_tenants", {
  tenantId: uuid("tenant_id").primaryKey().references(() => organizations.id, {onDelete:"cascade"}),
});

export const orderDesignAgentRuns = pgTable("order_design_agent_runs", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  workItemId: uuid("work_item_id").notNull(), workRevisionId: uuid("work_revision_id").notNull(),
  revision: integer("revision").notNull().default(1), status: text("status").notNull().default("queued"),
  executorKey: text("executor_key").notNull(), recipeVersion: text("recipe_version").notNull(), policyVersion: text("policy_version").notNull(),
  modelRouteId: uuid("model_route_id"), encryptedSnapshot: text("encrypted_snapshot").notNull(), inputChecksum: text("input_checksum").notNull(),
  methodSnapshot: jsonb("method_snapshot").$type<OrderDesignMethodSnapshot>(),
  completionEvidence: jsonb("completion_evidence").$type<OrderDesignCompletionV1>(), completionChecksum: text("completion_checksum"),
  projectId: uuid("project_id"), currentEditorVersionId: uuid("current_editor_version_id"),
  processingToken: uuid("processing_token"), leaseUntil: timestamp("lease_until", {mode:"date",withTimezone:true}),
  errorCode: text("error_code"), qualityDiagnostics: jsonb("quality_diagnostics").$type<Array<{code:string;severity:"error"|"warning"|"manual";message:string}>>().notNull().default([]),
  estimatedCostUsd: numeric("estimated_cost_usd", {precision:14,scale:6}), actualCostUsd: numeric("actual_cost_usd", {precision:20,scale:8}),
  costStatus: text("cost_status").notNull().default("unknown"), requestedBy: uuid("requested_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", {mode:"date",withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp("updated_at", {mode:"date",withTimezone:true}).notNull().defaultNow(),
}, t => [
  uniqueIndex("order_design_runs_tenant_id_unique").on(t.tenantId,t.id),
  uniqueIndex("order_design_runs_revision_unique").on(t.tenantId,t.workItemId,t.workRevisionId),
  foreignKey({columns:[t.tenantId,t.workItemId],foreignColumns:[orderWorkItems.tenantId,orderWorkItems.id],name:"order_design_runs_work_fk"}),
  foreignKey({columns:[t.tenantId,t.workItemId,t.workRevisionId],foreignColumns:[orderWorkRevisions.tenantId,orderWorkRevisions.workItemId,orderWorkRevisions.id],name:"order_design_runs_revision_fk"}),
  foreignKey({columns:[t.tenantId,t.projectId],foreignColumns:[productionEditorProjects.tenantId,productionEditorProjects.id],name:"order_design_runs_project_fk"}),
  foreignKey({columns:[t.tenantId,t.projectId,t.currentEditorVersionId],foreignColumns:[productionEditorVersions.tenantId,productionEditorVersions.projectId,productionEditorVersions.id],name:"order_design_runs_editor_version_fk"}),
  check("order_design_runs_status_check",sql`${t.status} in ('queued','running','awaiting_review','needs_attention','cancelled')`),
  check("order_design_runs_cost_status_check",sql`${t.costStatus} in ('not_required','estimated','unknown','reported')`),
  check("order_design_runs_revision_check",sql`${t.revision} > 0`),
  check("order_design_runs_input_checksum_check",sql`${t.inputChecksum} ~ '^[0-9a-f]{64}$'`),
  check("order_design_completion_pair_check",sql`(${t.completionEvidence} is null and ${t.completionChecksum} is null) or (${t.completionEvidence} is not null and ${t.completionChecksum} is not null and ${t.completionChecksum} ~ '^[a-f0-9]{64}$')`),
  check("order_design_native_review_completion_check",sql`${t.methodSnapshot} is null or ${t.status}<>'awaiting_review' or ${t.completionEvidence} is not null`),
  check("order_design_runs_estimated_cost_check",sql`${t.estimatedCostUsd} >= 0`),
  check("order_design_runs_actual_cost_check",sql`${t.actualCostUsd} >= 0`),
  index("order_design_runs_status_idx").on(t.tenantId,t.status,t.updatedAt),
]);

export const orderDesignAgentSteps = pgTable("order_design_agent_steps", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), runId: uuid("run_id").notNull(),
  key: text("key").notNull(), label: text("label").notNull(), position: integer("position").notNull(), status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(0), requestId: uuid("request_id").notNull(),
  encryptedInput: text("encrypted_input").notNull(), encryptedOutput: text("encrypted_output"), inputChecksum: text("input_checksum").notNull(),
  outputAssetId: uuid("output_asset_id"), outputVersionId: uuid("output_version_id"), errorCode: text("error_code"),
  startedAt: timestamp("started_at",{mode:"date",withTimezone:true}), completedAt: timestamp("completed_at",{mode:"date",withTimezone:true}),
  updatedAt: timestamp("updated_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex("order_design_steps_tenant_id_unique").on(t.tenantId,t.id),uniqueIndex("order_design_steps_key_unique").on(t.tenantId,t.runId,t.key),
  foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[orderDesignAgentRuns.tenantId,orderDesignAgentRuns.id],name:"order_design_steps_run_fk"}),
  check("order_design_steps_status_check",sql`${t.status} in ('pending','running','completed','failed','uncertain','skipped')`),
  check("order_design_steps_position_check",sql`${t.position} >= 0`),
  check("order_design_steps_attempt_check",sql`${t.attempt} >= 0`),
  check("order_design_steps_input_checksum_check",sql`${t.inputChecksum} ~ '^[0-9a-f]{64}$'`),
]);

export const orderDesignAgentOutbox = pgTable("order_design_agent_outbox", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(()=>organizations.id), runId: uuid("run_id").notNull(),
  requestedBy: uuid("requested_by").notNull().references(()=>users.id),
  dispatchedAt: timestamp("dispatched_at",{mode:"date",withTimezone:true}), nextAttemptAt: timestamp("next_attempt_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),
  createdAt: timestamp("created_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[orderDesignAgentRuns.tenantId,orderDesignAgentRuns.id],name:"order_design_outbox_run_fk"}),
  index("order_design_outbox_pending_idx").on(t.tenantId,t.dispatchedAt,t.nextAttemptAt),
]);

export const orderDesignAgentCommands = pgTable("order_design_agent_commands", {
  id: uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),runId:uuid("run_id").notNull(),
  idempotencyKey:uuid("idempotency_key").notNull(),action:text("action").notNull(),requestChecksum:text("request_checksum").notNull(),
  requestedBy:uuid("requested_by").notNull().references(()=>users.id),createdAt:timestamp("created_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),
},t=>[foreignKey({columns:[t.tenantId,t.runId],foreignColumns:[orderDesignAgentRuns.tenantId,orderDesignAgentRuns.id],name:"order_design_commands_run_fk"}),uniqueIndex("order_design_commands_idempotency_unique").on(t.tenantId,t.runId,t.idempotencyKey),check("order_design_commands_action_check",sql`${t.action} in ('resume','takeover','restore_response')`)]);
import type { OrderDesignMethodSnapshot, OrderDesignCompletionV1 } from "@yummyai/contracts/order/design-harness";
