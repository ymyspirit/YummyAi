import type {
  AmazonCustomWorkflowEventAction,
  AmazonCustomWorkflowStepKey,
  AmazonCustomWorkflowStepStatus,
  AmazonCustomWorkflowStatus,
} from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { productPlans } from "./catalog.js";
import { organizations, users } from "./identity.js";

export const amazonCustomWorkflows = pgTable(
  "amazon_custom_workflows",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productPlanId: uuid("product_plan_id").notNull(),
    status: text("status").$type<Exclude<AmazonCustomWorkflowStatus, "not_started">>().notNull(),
    currentStepKey: text("current_step_key").$type<AmazonCustomWorkflowStepKey>(),
    revision: integer("revision").default(1).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "amazon_custom_workflows_id_uuidv7_check",
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      "amazon_custom_workflows_status_check",
      sql`${table.status} in ('active','blocked','completed')`,
    ),
    check(
      "amazon_custom_workflows_current_step_check",
      sql`(${table.status} = 'completed' and ${table.currentStepKey} is null) or (${table.status} <> 'completed' and ${table.currentStepKey} in ('research_capture','research_review','product_plan','provisional_facts','seller_facts','customization_schema','spu_sku','design_proof','authorized_assets','studio_draft','studio_content','content_review','seller_central','online_qa'))`,
    ),
    check("amazon_custom_workflows_revision_check", sql`${table.revision} > 0`),
    foreignKey({
      columns: [table.tenantId, table.productPlanId],
      foreignColumns: [productPlans.tenantId, productPlans.id],
      name: "amazon_custom_workflows_product_plan_fk",
    }).onDelete("cascade"),
    uniqueIndex("amazon_custom_workflows_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("amazon_custom_workflows_plan_unique").on(
      table.tenantId,
      table.productPlanId,
    ),
    index("amazon_custom_workflows_status_idx").on(
      table.tenantId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const amazonCustomWorkflowSteps = pgTable(
  "amazon_custom_workflow_steps",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull(),
    stepKey: text("step_key").$type<AmazonCustomWorkflowStepKey>().notNull(),
    status: text("status").$type<AmazonCustomWorkflowStepStatus>().notNull(),
    note: text("note"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "amazon_custom_workflow_steps_id_uuidv7_check",
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      "amazon_custom_workflow_steps_status_check",
      sql`${table.status} in ('not_started','in_progress','blocked','completed')`,
    ),
    check(
      "amazon_custom_workflow_steps_key_check",
      sql`${table.stepKey} in ('research_capture','research_review','product_plan','provisional_facts','seller_facts','customization_schema','spu_sku','design_proof','authorized_assets','studio_draft','studio_content','content_review','seller_central','online_qa')`,
    ),
    check(
      "amazon_custom_workflow_steps_blocker_check",
      sql`${table.status} <> 'blocked' or length(${table.note}) > 0`,
    ),
    check(
      "amazon_custom_workflow_steps_started_check",
      sql`${table.status} = 'not_started' or ${table.startedAt} is not null`,
    ),
    check(
      "amazon_custom_workflow_steps_completed_check",
      sql`${table.status} <> 'completed' or ${table.completedAt} is not null`,
    ),
    foreignKey({
      columns: [table.tenantId, table.workflowId],
      foreignColumns: [amazonCustomWorkflows.tenantId, amazonCustomWorkflows.id],
      name: "amazon_custom_workflow_steps_workflow_fk",
    }).onDelete("cascade"),
    uniqueIndex("amazon_custom_workflow_steps_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("amazon_custom_workflow_steps_key_unique").on(
      table.tenantId,
      table.workflowId,
      table.stepKey,
    ),
    index("amazon_custom_workflow_steps_workflow_idx").on(
      table.tenantId,
      table.workflowId,
      table.updatedAt,
    ),
  ],
);

export const amazonCustomWorkflowEvents = pgTable(
  "amazon_custom_workflow_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull(),
    stepKey: text("step_key").$type<AmazonCustomWorkflowStepKey>().notNull(),
    action: text("action").$type<AmazonCustomWorkflowEventAction>().notNull(),
    fromStatus: text("from_status").$type<AmazonCustomWorkflowStepStatus>().notNull(),
    toStatus: text("to_status").$type<AmazonCustomWorkflowStepStatus>().notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    workflowRevision: integer("workflow_revision").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "amazon_custom_workflow_events_id_uuidv7_check",
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      "amazon_custom_workflow_events_action_check",
      sql`${table.action} in ('workflow_started','step_started','step_blocked','step_unblocked','step_completed','step_note_updated','step_reopened')`,
    ),
    check(
      "amazon_custom_workflow_events_step_key_check",
      sql`${table.stepKey} in ('research_capture','research_review','product_plan','provisional_facts','seller_facts','customization_schema','spu_sku','design_proof','authorized_assets','studio_draft','studio_content','content_review','seller_central','online_qa')`,
    ),
    check(
      "amazon_custom_workflow_events_from_status_check",
      sql`${table.fromStatus} in ('not_started','in_progress','blocked','completed')`,
    ),
    check(
      "amazon_custom_workflow_events_to_status_check",
      sql`${table.toStatus} in ('not_started','in_progress','blocked','completed')`,
    ),
    check(
      "amazon_custom_workflow_events_revision_check",
      sql`${table.workflowRevision} > 0`,
    ),
    foreignKey({
      columns: [table.tenantId, table.workflowId],
      foreignColumns: [amazonCustomWorkflows.tenantId, amazonCustomWorkflows.id],
      name: "amazon_custom_workflow_events_workflow_fk",
    }).onDelete("cascade"),
    uniqueIndex("amazon_custom_workflow_events_tenant_id_unique").on(table.tenantId, table.id),
    index("amazon_custom_workflow_events_workflow_idx").on(
      table.tenantId,
      table.workflowId,
      table.occurredAt,
    ),
  ],
);
