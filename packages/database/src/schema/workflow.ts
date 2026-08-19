import type {
  WorkflowArtifactValidationStatus,
  WorkflowGraph,
  WorkflowNodeRunStatus,
  WorkflowRunEventType,
  WorkflowRunStatus,
  WorkflowValidationResult,
} from "@yummyai/contracts/workflow";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { productPlans } from "./catalog.js";
import { organizations, users } from "./identity.js";

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stableKey: text("stable_key").notNull(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    category: text("category").notNull(),
    scope: text("scope").$type<"official" | "team" | "personal">().notNull(),
    status: text("status").$type<"draft" | "published" | "archived">().notNull(),
    currentDraftVersionId: uuid("current_draft_version_id"),
    currentPublishedVersionId: uuid("current_published_version_id"),
    revision: integer("revision").default(0).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("workflow_definitions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_definitions_scope_check", sql`${table.scope} in ('official','team','personal')`),
    check("workflow_definitions_status_check", sql`${table.status} in ('draft','published','archived')`),
    check("workflow_definitions_revision_check", sql`${table.revision} >= 0`),
    uniqueIndex("workflow_definitions_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("workflow_definitions_stable_key_unique").on(table.tenantId, table.stableKey),
    index("workflow_definitions_catalog_idx").on(table.tenantId, table.scope, table.status, table.updatedAt),
  ],
);

export const workflowDefinitionVersions = pgTable(
  "workflow_definition_versions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").$type<"draft" | "published">().notNull(),
    graph: jsonb("graph").$type<WorkflowGraph>().notNull(),
    validation: jsonb("validation").$type<WorkflowValidationResult>().notNull(),
    checksum: text("checksum").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    check("workflow_definition_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_definition_versions_version_check", sql`${table.version} > 0`),
    check("workflow_definition_versions_status_check", sql`${table.status} in ('draft','published')`),
    check("workflow_definition_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      columns: [table.tenantId, table.definitionId],
      foreignColumns: [workflowDefinitions.tenantId, workflowDefinitions.id],
      name: "workflow_definition_versions_definition_fk",
    }).onDelete("cascade"),
    uniqueIndex("workflow_definition_versions_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("workflow_definition_versions_number_unique").on(table.tenantId, table.definitionId, table.version),
    index("workflow_definition_versions_status_idx").on(table.tenantId, table.definitionId, table.status),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id").notNull(),
    definitionVersionId: uuid("definition_version_id").notNull(),
    productPlanId: uuid("product_plan_id").notNull(),
    legacyAmazonWorkflowId: uuid("legacy_amazon_workflow_id"),
    title: text("title").notNull(),
    status: text("status").$type<WorkflowRunStatus>().notNull(),
    currentNodeId: text("current_node_id"),
    revision: integer("revision").default(1).notNull(),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("workflow_runs_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_runs_status_check", sql`${table.status} in ('not_started','active','blocked','failed','completed','cancelled')`),
    check("workflow_runs_revision_check", sql`${table.revision} > 0`),
    foreignKey({
      columns: [table.tenantId, table.definitionId],
      foreignColumns: [workflowDefinitions.tenantId, workflowDefinitions.id],
      name: "workflow_runs_definition_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.definitionVersionId],
      foreignColumns: [workflowDefinitionVersions.tenantId, workflowDefinitionVersions.id],
      name: "workflow_runs_definition_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.productPlanId],
      foreignColumns: [productPlans.tenantId, productPlans.id],
      name: "workflow_runs_product_plan_fk",
    }).onDelete("cascade"),
    uniqueIndex("workflow_runs_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("workflow_runs_legacy_amazon_unique").on(table.tenantId, table.legacyAmazonWorkflowId),
    index("workflow_runs_status_idx").on(table.tenantId, table.status, table.updatedAt),
    index("workflow_runs_product_idx").on(table.tenantId, table.productPlanId, table.updatedAt),
  ],
);

export const workflowNodeRuns = pgTable(
  "workflow_node_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    status: text("status").$type<WorkflowNodeRunStatus>().notNull(),
    note: text("note"),
    blockerReason: text("blocker_reason"),
    parameterSnapshot: jsonb("parameter_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workflow_node_runs_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_node_runs_status_check", sql`${table.status} in ('not_started','in_progress','blocked','failed','completed','skipped','cancelled')`),
    check("workflow_node_runs_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("workflow_node_runs_blocker_check", sql`${table.status} <> 'blocked' or length(${table.blockerReason}) > 0`),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
      name: "workflow_node_runs_run_fk",
    }).onDelete("cascade"),
    uniqueIndex("workflow_node_runs_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("workflow_node_runs_node_unique").on(table.tenantId, table.runId, table.nodeId),
    index("workflow_node_runs_status_idx").on(table.tenantId, table.runId, table.status, table.updatedAt),
  ],
);

export const workflowNodeAttempts = pgTable(
  "workflow_node_attempts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    nodeRunId: uuid("node_run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").$type<"queued" | "running" | "failed" | "completed" | "cancelled">().notNull(),
    queueJobId: text("queue_job_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    queuedAt: timestamp("queued_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    check("workflow_node_attempts_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_node_attempts_number_check", sql`${table.attemptNumber} > 0`),
    check("workflow_node_attempts_status_check", sql`${table.status} in ('queued','running','failed','completed','cancelled')`),
    foreignKey({
      columns: [table.tenantId, table.nodeRunId],
      foreignColumns: [workflowNodeRuns.tenantId, workflowNodeRuns.id],
      name: "workflow_node_attempts_node_run_fk",
    }).onDelete("cascade"),
    uniqueIndex("workflow_node_attempts_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("workflow_node_attempts_number_unique").on(table.tenantId, table.nodeRunId, table.attemptNumber),
    index("workflow_node_attempts_status_idx").on(table.tenantId, table.status, table.queuedAt),
  ],
);

export const workflowArtifactLinks = pgTable(
  "workflow_artifact_links",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    nodeRunId: uuid("node_run_id").notNull(),
    artifactType: text("artifact_type").notNull(),
    artifactId: text("artifact_id").notNull(),
    artifactVersion: text("artifact_version"),
    label: text("label").notNull(),
    validationStatus: text("validation_status").$type<WorkflowArtifactValidationStatus>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workflow_artifact_links_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_artifact_links_validation_check", sql`${table.validationStatus} in ('pending','valid','invalid')`),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
      name: "workflow_artifact_links_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.nodeRunId],
      foreignColumns: [workflowNodeRuns.tenantId, workflowNodeRuns.id],
      name: "workflow_artifact_links_node_run_fk",
    }).onDelete("cascade"),
    uniqueIndex("workflow_artifact_links_tenant_id_unique").on(table.tenantId, table.id),
    index("workflow_artifact_links_run_idx").on(table.tenantId, table.runId, table.createdAt),
  ],
);

export const workflowRunEvents = pgTable(
  "workflow_run_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    nodeId: text("node_id"),
    type: text("type").$type<WorkflowRunEventType>().notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    runRevision: integer("run_revision").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workflow_run_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("workflow_run_events_revision_check", sql`${table.runRevision} > 0`),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
      name: "workflow_run_events_run_fk",
    }).onDelete("cascade"),
    uniqueIndex("workflow_run_events_tenant_id_unique").on(table.tenantId, table.id),
    index("workflow_run_events_run_idx").on(table.tenantId, table.runId, table.occurredAt),
  ],
);
