import {
  boolean,
  doublePrecision,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeFields } from "@yummyai/contracts/knowledge";
import type {
  KnowledgeAccount,
  KnowledgeEvaluationCase,
} from "@yummyai/contracts/knowledge/governance";
import type {
  KnowledgeEvaluationProtocol,
  KnowledgeEvaluationAssessment,
} from "@yummyai/contracts/knowledge/evaluation-protocol";
import type { KnowledgeSearch } from "@yummyai/contracts/knowledge";
import { organizations, users } from "./identity.js";
import { marketplaceAccounts } from "./marketplace.js";
import { knowledgeEntries, knowledgeVersions } from "./knowledge.js";
import { aiAssistRuns } from "./ai-assists.js";
const scope = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => organizations.id),
});
const stamp = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    ...scope(),
    ...stamp(),
    revision: integer("revision").notNull().default(1),
    kind: text("kind").$type<"reference" | "account">().notNull(),
    fileName: text("file_name").notNull(),
    mediaType: text("media_type").notNull(),
    checksum: text("checksum").notNull(),
    encryptedOriginal: text("encrypted_original"),
    encryptedParsed: text("encrypted_parsed"),
    rawExpiresAt: timestamp("raw_expires_at", { withTimezone: true }).notNull(),
    safeText: text("safe_text").notNull().default(""),
    state: text("state").$type<"preview" | "confirmed" | "failed" | "archived">().notNull(),
    diagnostics: jsonb("diagnostics").$type<string[]>().notNull(),
    fields: jsonb("fields").$type<KnowledgeFields>().notNull(),
    account: jsonb("account").$type<KnowledgeAccount>(),
    storeId: uuid("store_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    requestId: uuid("request_id").notNull(),
    requestChecksum: text("request_checksum").notNull(),
  },
  (t) => [
    uniqueIndex("knowledge_documents_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("knowledge_documents_request_unique").on(t.tenantId, t.requestId),
    foreignKey({
      columns: [t.tenantId, t.storeId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    }),
  ],
);
export const knowledgeCandidates = pgTable(
  "knowledge_candidates",
  {
    ...scope(),
    ...stamp(),
    documentId: uuid("document_id").notNull(),
    revision: integer("revision").notNull().default(1),
    fields: jsonb("fields").$type<KnowledgeFields>().notNull(),
    locator: text("locator").notNull(),
    excerpt: text("excerpt").notNull(),
    decision: text("decision")
      .$type<"pending" | "accepted" | "rejected">()
      .notNull()
      .default("pending"),
    entryId: uuid("entry_id"),
    requestId: uuid("request_id"),
    requestChecksum: text("request_checksum"),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.documentId],
      foreignColumns: [knowledgeDocuments.tenantId, knowledgeDocuments.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.entryId],
      foreignColumns: [knowledgeEntries.tenantId, knowledgeEntries.id],
    }),
  ],
);
export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    ...scope(),
    ...stamp(),
    revision: integer("revision").notNull().default(1),
    label: text("label").notNull(),
    url: text("url").notNull(),
    owner: text("owner").notNull(),
    checkEveryHours: integer("check_every_hours").notNull(),
    freshnessDays: integer("freshness_days").notNull(),
    monitoring: boolean("monitoring").notNull(),
    latestSnapshotId: uuid("latest_snapshot_id"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    requestId: uuid("request_id").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("knowledge_sources_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("knowledge_sources_request_unique").on(t.tenantId, t.requestId),
  ],
);
export const knowledgeSourceSnapshots = pgTable(
  "knowledge_source_snapshots",
  {
    ...scope(),
    ...stamp(),
    sourceId: uuid("source_id").notNull(),
    url: text("url").notNull(),
    body: text("body").notNull(),
    checksum: text("checksum").notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("knowledge_source_snapshots_tenant_id_unique").on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }),
  ],
);
export const knowledgeSourceChecks = pgTable(
  "knowledge_source_checks",
  {
    ...scope(),
    ...stamp(),
    sourceId: uuid("source_id").notNull(),
    result: text("result").notNull(),
    diagnostic: text("diagnostic").notNull(),
    snapshotId: uuid("snapshot_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.snapshotId],
      foreignColumns: [knowledgeSourceSnapshots.tenantId, knowledgeSourceSnapshots.id],
    }),
  ],
);
export const knowledgeSourceReviews = pgTable(
  "knowledge_source_reviews",
  {
    ...scope(),
    ...stamp(),
    sourceId: uuid("source_id").notNull(),
    revision: integer("revision").notNull().default(1),
    beforeSnapshotId: uuid("before_snapshot_id"),
    afterSnapshotId: uuid("after_snapshot_id").notNull(),
    state: text("state")
      .$type<
        "pending" | "no_business_change" | "revision_required" | "needs_evidence" | "completed"
      >()
      .notNull()
      .default("pending"),
    reason: text("reason").notNull().default(""),
    entryIds: jsonb("entry_ids").$type<string[]>().notNull().default([]),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.beforeSnapshotId],
      foreignColumns: [knowledgeSourceSnapshots.tenantId, knowledgeSourceSnapshots.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.afterSnapshotId],
      foreignColumns: [knowledgeSourceSnapshots.tenantId, knowledgeSourceSnapshots.id],
    }),
  ],
);
export const knowledgeNeeds = pgTable("knowledge_needs", {
  ...scope(),
  ...stamp(),
  revision: integer("revision").notNull().default(1),
  question: text("question").notNull(),
  owner: text("owner").notNull(),
  searchScope: jsonb("search_scope").$type<KnowledgeSearch>().notNull(),
  entryIds: jsonb("entry_ids").$type<string[]>().notNull(),
  requestId: uuid("request_id").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
export const knowledgeConflicts = pgTable(
  "knowledge_conflicts",
  {
    ...scope(),
    ...stamp(),
    revision: integer("revision").notNull().default(1),
    key: text("key").notNull(),
    leftVersionId: uuid("left_version_id").notNull(),
    rightVersionId: uuid("right_version_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity").$type<"warning" | "blocking">().notNull(),
    state: text("state")
      .$type<"open" | "conditional" | "superseded" | "needs_evidence">()
      .notNull()
      .default("open"),
    reason: text("reason").notNull().default(""),
  },
  (t) => [
    uniqueIndex("knowledge_conflicts_identity").on(t.tenantId, t.fingerprint),
    foreignKey({
      columns: [t.tenantId, t.leftVersionId],
      foreignColumns: [knowledgeVersions.tenantId, knowledgeVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.rightVersionId],
      foreignColumns: [knowledgeVersions.tenantId, knowledgeVersions.id],
    }),
  ],
);
export const knowledgeEvaluationCases = pgTable(
  "knowledge_evaluation_cases",
  {
    ...scope(),
    ...stamp(),
    revision: integer("revision").notNull().default(1),
    fields: jsonb("fields").$type<KnowledgeEvaluationCase>().notNull(),
    benchmarkVersionId: uuid("benchmark_version_id"),
    requestId: uuid("request_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("knowledge_evaluation_cases_tenant_id_unique").on(t.tenantId, t.id)],
);
export const knowledgeEvaluationRuns = pgTable(
  "knowledge_evaluation_runs",
  {
    ...scope(),
    ...stamp(),
    caseId: uuid("case_id").notNull(),
    assistRunId: uuid("assist_run_id").notNull(),
    caseSnapshot: jsonb("case_snapshot").$type<KnowledgeEvaluationCase>().notNull(),
    requestId: uuid("request_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("knowledge_evaluation_runs_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("knowledge_evaluation_request").on(t.tenantId, t.requestId),
    foreignKey({
      columns: [t.tenantId, t.caseId],
      foreignColumns: [knowledgeEvaluationCases.tenantId, knowledgeEvaluationCases.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.assistRunId],
      foreignColumns: [aiAssistRuns.tenantId, aiAssistRuns.id],
    }),
  ],
);
export const knowledgeEvaluationProtocols = pgTable(
  "knowledge_evaluation_protocols",
  {
    runId: uuid("run_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
    caseRevision: integer("case_revision").notNull(),
    caseChecksum: text("case_checksum").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    basisFingerprint: text("basis_fingerprint").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    modelId: uuid("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    dataScope: text("data_scope").$type<"self" | "team" | "tenant">().notNull(),
    assertionVersion: text("assertion_version").$type<KnowledgeEvaluationProtocol["assertionVersion"]>().notNull(),
    proof: text("proof").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    creationTransactionId: text("creation_transaction_id").notNull(),
    ...stamp(),
  },
  (t) => [
    uniqueIndex("knowledge_evaluation_protocols_tenant_run_unique").on(t.tenantId, t.runId),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [knowledgeEvaluationRuns.tenantId, knowledgeEvaluationRuns.id],
      name: "knowledge_evaluation_protocol_run_fk",
    }),
  ],
);
export const knowledgeEvaluationAssessments = pgTable(
  "knowledge_evaluation_assessments",
  {
    ...scope(),
    ...stamp(),
    runId: uuid("run_id").notNull(),
    basisFingerprint: text("basis_fingerprint").notNull(),
    outputChecksum: text("output_checksum").notNull(),
    assertionVersion: text("assertion_version").$type<KnowledgeEvaluationAssessment["assertionVersion"]>().notNull(),
    retrievalRecall: doublePrecision("retrieval_recall"),
    citedRecall: doublePrecision("cited_recall"),
    checks: jsonb("checks").$type<KnowledgeEvaluationAssessment["checks"]>().notNull(),
    resultChecksum: text("result_checksum").notNull(),
    proof: text("proof").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    creationTransactionId: text("creation_transaction_id").notNull(),
  },
  (t) => [
    uniqueIndex("knowledge_evaluation_assessments_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("knowledge_evaluation_assessments_run_unique").on(t.runId),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [knowledgeEvaluationProtocols.tenantId, knowledgeEvaluationProtocols.runId],
      name: "knowledge_evaluation_assessment_protocol_fk",
    }),
  ],
);
export const knowledgeEvidenceLinks = pgTable(
  "knowledge_evidence_links",
  {
    ...scope(),
    versionId: uuid("version_id").notNull(),
    documentId: uuid("document_id"),
    snapshotId: uuid("snapshot_id"),
  },
  (t) => [
    uniqueIndex("knowledge_evidence_document_unique").on(t.tenantId, t.versionId, t.documentId),
    uniqueIndex("knowledge_evidence_snapshot_unique").on(t.tenantId, t.versionId, t.snapshotId),
    foreignKey({
      columns: [t.tenantId, t.versionId],
      foreignColumns: [knowledgeVersions.tenantId, knowledgeVersions.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.documentId],
      foreignColumns: [knowledgeDocuments.tenantId, knowledgeDocuments.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.snapshotId],
      foreignColumns: [knowledgeSourceSnapshots.tenantId, knowledgeSourceSnapshots.id],
    }),
  ],
);
export const knowledgeGovernanceEvents = pgTable("knowledge_governance_events", {
  ...scope(),
  ...stamp(),
  resourceId: uuid("resource_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
});
