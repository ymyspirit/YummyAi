import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { orderLines } from "./order.js";
import { amazonOrderReportLines, amazonOrderReportVersions } from "./order-report.js";
import { productionEditorProjects, productionEditorVersions } from "./production-editor.js";
import { shipments, shipmentVersions } from "./order-shipment.js";

export const orderWorkItems = pgTable(
  "order_work_items",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    reportLineId: uuid("report_line_id"),
    sourceVersionId: uuid("source_version_id"),
    encryptedDataKey: text("encrypted_data_key"),
    revision: integer("revision").notNull().default(0),
    projectionVersion: integer("projection_version").notNull().default(1),
    preparation: text("preparation").notNull().default("pending_review"),
    artwork: text("artwork").notNull().default("not_pushed"),
    proof: text("proof").notNull().default("not_required"),
    held: boolean("held").notNull().default(false),
    printSku: text("print_sku"),
    searchRevision: integer("search_revision").notNull().default(-1),
    searchSpecificationVersionId: uuid("search_specification_version_id"),
    searchDesignExecutor: text("search_design_executor"),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
    pushedRevisionId: uuid("pushed_revision_id"),
    editorProjectId: uuid("editor_project_id"),
    approvedEditorVersionId: uuid("approved_editor_version_id"),
    proofEditorVersionId: uuid("proof_editor_version_id"),
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }),
    platformShipByAt: timestamp("platform_ship_by_at", { mode: "date", withTimezone: true }),
    platformDeadlineVerifiedAt: timestamp("platform_deadline_verified_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex("order_work_items_tenant_id_unique").on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.id],
      foreignColumns: [orderLines.tenantId, orderLines.id],
      name: "order_work_items_line_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.reportLineId],
      foreignColumns: [amazonOrderReportLines.tenantId, amazonOrderReportLines.id],
      name: "order_work_items_report_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.reportLineId, t.sourceVersionId],
      foreignColumns: [
        amazonOrderReportVersions.tenantId,
        amazonOrderReportVersions.reportLineId,
        amazonOrderReportVersions.id,
      ],
      name: "order_work_items_source_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.editorProjectId],
      foreignColumns: [productionEditorProjects.tenantId, productionEditorProjects.id],
      name: "order_work_items_editor_fk",
    }),
    index("order_work_items_queue_idx").on(t.tenantId, t.preparation, t.artwork, t.dueAt),
    index("order_work_platform_deadline_idx").on(t.tenantId, t.platformShipByAt),
  ],
);
export const orderWorkRevisions = pgTable(
  "order_work_revisions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    workItemId: uuid("work_item_id").notNull(),
    revision: integer("revision").notNull(),
    sourceVersionId: uuid("source_version_id"),
    profileVersionId: uuid("profile_version_id"),
    encryptedDraft: text("encrypted_draft").notNull(),
    checksum: text("checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex("order_work_revisions_scope_unique").on(t.tenantId, t.workItemId, t.id),
    uniqueIndex("order_work_revisions_number_unique").on(t.tenantId, t.workItemId, t.revision),
    foreignKey({
      columns: [t.tenantId, t.workItemId],
      foreignColumns: [orderWorkItems.tenantId, orderWorkItems.id],
      name: "order_work_revisions_work_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.profileVersionId],
      foreignColumns: [printProfileVersions.tenantId, printProfileVersions.id],
      name: "order_work_revisions_profile_fk",
    }),
  ],
);
export const orderWorkAssets = pgTable(
  "order_work_assets",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    workItemId: uuid("work_item_id").notNull(),
    objectKey: text("object_key").notNull(),
    previewObjectKey: text("preview_object_key").notNull(),
    encryptedMetadata: text("encrypted_metadata").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_work_assets_scope_unique").on(t.tenantId, t.workItemId, t.id),
    foreignKey({
      columns: [t.tenantId, t.workItemId],
      foreignColumns: [orderWorkItems.tenantId, orderWorkItems.id],
      name: "order_work_assets_work_fk",
    }),
  ],
);
export const orderWorkEvents = pgTable(
  "order_work_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    workItemId: uuid("work_item_id").notNull(),
    action: text("action").notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    revision: integer("revision").notNull(),
    encryptedReason: text("encrypted_reason").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("order_work_events_request_unique").on(t.tenantId, t.workItemId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.workItemId],
      foreignColumns: [orderWorkItems.tenantId, orderWorkItems.id],
      name: "order_work_events_work_fk",
    }),
    index("order_work_events_history_idx").on(t.tenantId, t.workItemId, t.occurredAt),
  ],
);
/** A manual platform check is distinct from an API acknowledgement and physical handover. */
export const shipmentManualConfirmations = pgTable("shipment_manual_confirmations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  shipmentId: uuid("shipment_id").notNull(),
  shipmentVersionId: uuid("shipment_version_id").notNull(),
  confirmedAt: timestamp("confirmed_at", { mode: "date", withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
}, (t) => [
  foreignKey({ columns: [t.tenantId, t.shipmentId], foreignColumns: [shipments.tenantId, shipments.id], name: "shipment_manual_confirmation_shipment_fk" }),
  foreignKey({ columns: [t.tenantId, t.shipmentVersionId], foreignColumns: [shipmentVersions.tenantId, shipmentVersions.id], name: "shipment_manual_confirmation_version_fk" }),
  uniqueIndex("shipment_manual_confirmation_request_unique").on(t.tenantId, t.shipmentId, t.idempotencyKey),
  index("shipment_manual_confirmation_version_idx").on(t.tenantId, t.shipmentVersionId),
]);

export const printProfiles = pgTable(
  "print_profiles",
  {
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("print_profiles_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("print_profiles_code_unique").on(t.tenantId, sql`lower(${t.code})`),
  ],
);
export const printProfileVersions = pgTable(
  "print_profile_versions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    profileId: uuid("profile_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    name: text("name").notNull(),
    productType: text("product_type").notNull(),
    projectId: uuid("project_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    instructions: text("instructions").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("print_profile_versions_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("print_profile_versions_number_unique").on(
      t.tenantId,
      t.profileId,
      t.versionNumber,
    ),
    uniqueIndex("print_profile_versions_request_unique").on(t.tenantId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.profileId],
      foreignColumns: [printProfiles.tenantId, printProfiles.id],
      name: "print_profile_versions_profile_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.sourceVersionId],
      foreignColumns: [
        productionEditorVersions.tenantId,
        productionEditorVersions.projectId,
        productionEditorVersions.id,
      ],
      name: "print_profile_versions_editor_fk",
    }),
  ],
);
