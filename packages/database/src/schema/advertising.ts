import type {
  AdFact,
  AdGoalFields,
  AdAnalysisResult,
  AdRecommendation,
  AdObservation,
  AdExportView,
  AdDiagnostic,
  AdImportInput,
  AdAnalysisInput,
  AdActionEventInput,
  AdFileMeasurement,
} from "@yummyai/contracts/advertising";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { marketplaceAccounts } from "./marketplace.js";

const base = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => organizations.id),
  accountId: uuid("account_id").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export const adImportBatches = pgTable(
  "ad_import_batches",
  {
    ...base(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputChecksum: text("input_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("ad_batches_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_batches_request").on(t.tenantId, t.accountId, t.idempotencyKey),
    uniqueIndex("ad_batches_content").on(t.tenantId, t.accountId, t.inputChecksum),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const adImports = pgTable(
  "ad_imports",
  {
    ...base(),
    batchId: uuid("batch_id").notNull(),
    fileName: text("file_name").notNull(),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    checksum: text("checksum").notNull(),
    objectKey: text("object_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    reportType: text("report_type").$type<AdFact["reportType"]>().notNull(),
    metadata: jsonb("metadata")
      .$type<Omit<AdImportInput, "files" | "accountId" | "idempotencyKey" | "allowPartial"> & {
        measurement?: AdFileMeasurement; rawInputChecksum?: string;
      }>()
      .notNull(),
    sourceRowCount: integer("source_row_count").notNull(),
    acceptedRowCount: integer("accepted_row_count").notNull(),
    rejectedRowCount: integer("rejected_row_count").notNull(),
    diagnostics: jsonb("diagnostics").$type<AdDiagnostic[]>().notNull(),
    scan: jsonb("scan").$type<Record<string, unknown>>().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("ad_imports_tenant_id").on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.batchId],
      foreignColumns: [adImportBatches.tenantId, adImportBatches.id],
    }),
    index("ad_imports_scope").on(t.tenantId, t.accountId, t.createdAt),
  ],
);
export const adFacts = pgTable(
  "ad_facts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    importId: uuid("import_id").notNull(),
    rowKey: text("row_key").notNull(),
    entityKey: text("entity_key").notNull(),
    fact: jsonb("fact").$type<AdFact>().notNull(),
  },
  (t) => [
    uniqueIndex("ad_facts_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_facts_source_row").on(t.tenantId, t.importId, t.rowKey),
    foreignKey({
      columns: [t.tenantId, t.importId],
      foreignColumns: [adImports.tenantId, adImports.id],
    }),
    index("ad_facts_entity").on(t.tenantId, t.entityKey),
  ],
);
export const adProducts = pgTable(
  "ad_products",
  {
    ...base(),
    marketplace: text("marketplace").notNull(),
    currency: text("currency").notNull(),
    asin: text("asin").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [
    uniqueIndex("ad_products_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_products_scope").on(t.tenantId, t.accountId, t.marketplace, t.currency, t.asin),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
    check("ad_products_revision", sql`${t.revision} >= 0`),
  ],
);
export const adGoalVersions = pgTable(
  "ad_goal_versions",
  {
    ...base(),
    productId: uuid("product_id").notNull(),
    revision: integer("revision").notNull(),
    fields: jsonb("fields").$type<AdGoalFields>().notNull(),
    checksum: text("checksum").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputChecksum: text("input_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("ad_goals_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_goals_version").on(t.tenantId, t.productId, t.revision),
    uniqueIndex("ad_goals_request").on(t.tenantId, t.accountId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [adProducts.tenantId, adProducts.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const adObservations = pgTable(
  "ad_observations",
  {
    ...base(),
    data: jsonb("data").$type<Omit<AdObservation, "id" | "createdAt">>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputChecksum: text("input_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("ad_observations_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_observations_request").on(t.tenantId, t.accountId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const adAnalysisRuns = pgTable(
  "ad_analysis_runs",
  {
    ...base(),
    input: jsonb("input").$type<AdAnalysisInput>().notNull(),
    inputChecksum: text("input_checksum").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    result: jsonb("result").$type<AdAnalysisResult>().notNull(),
    status: text("status").$type<"complete" | "partial">().notNull(),
  },
  (t) => [
    uniqueIndex("ad_runs_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_runs_request").on(t.tenantId, t.accountId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const adActions = pgTable(
  "ad_actions",
  {
    ...base(),
    runId: uuid("run_id").notNull(),
    recommendationKey: text("recommendation_key").notNull(),
    recommendation: jsonb("recommendation").$type<AdRecommendation>().notNull(),
    status: text("status").$type<AdActionEventInput["status"]>().notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "date" }),
    actualBeforeMinor: text("actual_before_minor"),
    actualAfterMinor: text("actual_after_minor"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_actions_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_actions_candidate")
      .on(t.tenantId, t.accountId, t.recommendationKey)
      .where(sql`${t.status} <> 'stale'`),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [adAnalysisRuns.tenantId, adAnalysisRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const adActionEvents = pgTable(
  "ad_action_events",
  {
    ...base(),
    actionId: uuid("action_id").notNull(),
    status: text("status").$type<AdActionEventInput["status"]>().notNull(),
    reason: text("reason").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputChecksum: text("input_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("ad_events_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_events_request").on(t.tenantId, t.actionId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.actionId],
      foreignColumns: [adActions.tenantId, adActions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const adImportEvents = pgTable(
  "ad_import_events",
  {
    ...base(),
    importId: uuid("import_id").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputChecksum: text("input_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("ad_import_events_request").on(t.tenantId, t.importId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.importId],
      foreignColumns: [adImports.tenantId, adImports.id],
    }),
  ],
);
export const adExports = pgTable(
  "ad_exports",
  {
    ...base(),
    runId: uuid("run_id").notNull(),
    data: jsonb("data").$type<AdExportView["payload"]>().notNull(),
    checksum: text("checksum").notNull(),
    reviewReason: text("review_reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputChecksum: text("input_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("ad_exports_tenant_id").on(t.tenantId, t.id),
    uniqueIndex("ad_exports_request").on(t.tenantId, t.accountId, t.idempotencyKey),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [adAnalysisRuns.tenantId, adAnalysisRuns.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
