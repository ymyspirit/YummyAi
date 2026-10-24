import { foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, numeric, boolean } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { AssistModel } from "@yummyai/contracts/ai/assist";
import type { AgentMethodSelection } from "@yummyai/contracts/harness/methods";
import type { BenchmarkCase, BenchmarkDatasetFields, BenchmarkReport, BenchmarkAssessment, BenchmarkItem, BusinessBenchmarkRole } from "@yummyai/contracts/knowledge/benchmark";
import { organizations, users } from "./identity.js";
import { knowledgeEvaluationCases, knowledgeEvaluationRuns } from "./knowledge-governance.js";
import { aiAssistRuns } from "./ai-assists.js";
const scope=()=>({id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),
 createdBy:uuid("created_by").notNull().references(()=>users.id),createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
 creationTransactionId:text("creation_transaction_id").notNull()});
const privateIndex=(t:{tenantId:PgColumn;id:PgColumn},name:string)=>uniqueIndex(name).on(t.tenantId,t.id);
export const knowledgeBenchmarkDatasets=pgTable("knowledge_benchmark_datasets",{
 ...scope(),revision:integer("revision").notNull(),fields:jsonb("fields").$type<BenchmarkDatasetFields>().notNull(),
 dataScope:text("data_scope").$type<"self"|"team"|"tenant">().notNull(),updatedAt:timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[privateIndex(t,"knowledge_benchmark_datasets_tenant_id_unique")]);
export const knowledgeBenchmarkVersions=pgTable("knowledge_benchmark_versions",{
 ...scope(),datasetId:uuid("dataset_id").notNull(),version:integer("version").notNull(),datasetRevision:integer("dataset_revision").notNull(),
 name:text("name").notNull(),checksum:text("checksum").notNull(),itemCount:integer("item_count").notNull(),
 dataScope:text("data_scope").$type<"self"|"team"|"tenant">().notNull(),basisExpiresAt:timestamp("basis_expires_at",{withTimezone:true}).notNull(),
 manifest:jsonb("manifest").$type<Record<string,unknown>>().notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_versions_tenant_id_unique"),uniqueIndex("knowledge_benchmark_versions_sequence").on(t.tenantId,t.datasetId,t.version),
 foreignKey({columns:[t.tenantId,t.datasetId],foreignColumns:[knowledgeBenchmarkDatasets.tenantId,knowledgeBenchmarkDatasets.id]})]);
export const knowledgeBenchmarkItems=pgTable("knowledge_benchmark_items",{
 ...scope(),versionId:uuid("version_id").notNull(),ordinal:integer("ordinal").notNull(),caseId:uuid("case_id"),
 fields:jsonb("fields").$type<BenchmarkCase>().notNull(),caseChecksum:text("case_checksum").notNull(),basisFingerprint:text("basis_fingerprint").notNull(),taskFingerprint:text("task_fingerprint").notNull(),
 sourcePins:jsonb("source_pins").$type<BenchmarkItem["sourcePins"]>().notNull(),method:jsonb("method").$type<AgentMethodSelection|null>(),
 encryptedBasis:text("encrypted_basis"),expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_items_tenant_id_unique"),uniqueIndex("knowledge_benchmark_items_order").on(t.tenantId,t.versionId,t.ordinal),
 uniqueIndex("knowledge_benchmark_items_case").on(t.tenantId,t.caseId),
 foreignKey({columns:[t.tenantId,t.versionId],foreignColumns:[knowledgeBenchmarkVersions.tenantId,knowledgeBenchmarkVersions.id]}),
 foreignKey({columns:[t.tenantId,t.caseId],foreignColumns:[knowledgeEvaluationCases.tenantId,knowledgeEvaluationCases.id]})]);
export const knowledgeBenchmarkExperiments=pgTable("knowledge_benchmark_experiments",{
 ...scope(),datasetVersionId:uuid("dataset_version_id").notNull(),label:text("label").notNull(),baselineVersion:text("baseline_version").notNull(),
 graderVersion:text("grader_version").notNull(),costVersion:text("cost_version").notNull(),modelId:uuid("model_id").notNull(),modelSnapshot:jsonb("model_snapshot").$type<AssistModel>().notNull(),routeFingerprint:text("route_fingerprint").notNull(),
 maxAttemptsPerItem:integer("max_attempts_per_item").notNull(),itemCount:integer("item_count").notNull(),dataScope:text("data_scope").$type<"self"|"team"|"tenant">().notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_experiments_tenant_id_unique"),foreignKey({columns:[t.tenantId,t.datasetVersionId],foreignColumns:[knowledgeBenchmarkVersions.tenantId,knowledgeBenchmarkVersions.id]})]);
export const knowledgeBenchmarkAttempts=pgTable("knowledge_benchmark_attempts",{
 ...scope(),experimentId:uuid("experiment_id").notNull(),itemId:uuid("item_id").notNull(),arm:text("arm").$type<"baseline"|"candidate">().notNull(),ordinal:integer("ordinal").notNull(),
 evaluationRunId:uuid("evaluation_run_id"),nativeRunId:uuid("native_run_id"),requestId:uuid("request_id").notNull(),requestChecksum:text("request_checksum").notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_attempts_tenant_id_unique"),uniqueIndex("knowledge_benchmark_attempts_request").on(t.tenantId,t.requestId),
 uniqueIndex("knowledge_benchmark_attempts_ordinal").on(t.tenantId,t.experimentId,t.itemId,t.arm,t.ordinal),uniqueIndex("knowledge_benchmark_attempts_evaluation").on(t.tenantId,t.evaluationRunId),
 foreignKey({columns:[t.tenantId,t.experimentId],foreignColumns:[knowledgeBenchmarkExperiments.tenantId,knowledgeBenchmarkExperiments.id]}),
 foreignKey({columns:[t.tenantId,t.itemId],foreignColumns:[knowledgeBenchmarkItems.tenantId,knowledgeBenchmarkItems.id]}),
 foreignKey({columns:[t.tenantId,t.evaluationRunId],foreignColumns:[knowledgeEvaluationRuns.tenantId,knowledgeEvaluationRuns.id]}),
 uniqueIndex("knowledge_benchmark_attempts_native").on(t.tenantId,t.nativeRunId),
 foreignKey({columns:[t.tenantId,t.nativeRunId],foreignColumns:[aiAssistRuns.tenantId,aiAssistRuns.id]})]);
export const knowledgeBenchmarkAssessments=pgTable("knowledge_benchmark_assessments",{
 ...scope(),attemptId:uuid("attempt_id").notNull(),graderVersion:text("grader_version").notNull(),caseChecksum:text("case_checksum").notNull(),basisFingerprint:text("basis_fingerprint").notNull(),
 outputChecksum:text("output_checksum").notNull(),hardPass:boolean("hard_pass").notNull(),checks:jsonb("checks").$type<BenchmarkAssessment["checks"]>().notNull(),
 proof:text("proof").notNull(),encryptedOutput:text("encrypted_output"),expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_assessments_tenant_id_unique"),uniqueIndex("knowledge_benchmark_assessments_attempt").on(t.tenantId,t.attemptId),
 foreignKey({columns:[t.tenantId,t.attemptId],foreignColumns:[knowledgeBenchmarkAttempts.tenantId,knowledgeBenchmarkAttempts.id]})]);
export const knowledgeBenchmarkReviews=pgTable("knowledge_benchmark_reviews",{
 ...scope(),attemptId:uuid("attempt_id").notNull(),assessmentId:uuid("assessment_id").notNull(),previousId:uuid("previous_id"),sequence:integer("sequence").notNull(),
 decision:text("decision").$type<"pass"|"fail"|"needs_review">().notNull(),minutes:numeric("minutes",{precision:12,scale:3}).notNull(),hourlyUsd:numeric("hourly_usd",{precision:24,scale:8}),reason:text("reason").notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_reviews_tenant_id_unique"),uniqueIndex("knowledge_benchmark_reviews_sequence").on(t.tenantId,t.attemptId,t.sequence),
 foreignKey({columns:[t.tenantId,t.attemptId],foreignColumns:[knowledgeBenchmarkAttempts.tenantId,knowledgeBenchmarkAttempts.id]}),
 foreignKey({columns:[t.tenantId,t.assessmentId],foreignColumns:[knowledgeBenchmarkAssessments.tenantId,knowledgeBenchmarkAssessments.id]})]);
export const knowledgeBenchmarkExpenses=pgTable("knowledge_benchmark_expenses",{
 ...scope(),experimentId:uuid("experiment_id").notNull(),arm:text("arm").$type<"baseline"|"candidate">().notNull(),previousId:uuid("previous_id"),sequence:integer("sequence").notNull(),
 storageUsd:numeric("storage_usd",{precision:24,scale:8}),maintenanceUsd:numeric("maintenance_usd",{precision:24,scale:8}),activityFingerprint:text("activity_fingerprint").notNull(),
 periodStart:timestamp("period_start",{withTimezone:true}).notNull(),periodEnd:timestamp("period_end",{withTimezone:true}).notNull(),allocationBasis:text("allocation_basis").notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_expenses_tenant_id_unique"),uniqueIndex("knowledge_benchmark_expenses_sequence").on(t.tenantId,t.experimentId,t.arm,t.sequence),
 foreignKey({columns:[t.tenantId,t.experimentId],foreignColumns:[knowledgeBenchmarkExperiments.tenantId,knowledgeBenchmarkExperiments.id]})]);
export const knowledgeBenchmarkCommands=pgTable("knowledge_benchmark_commands",{
 ...scope(),requestId:uuid("request_id").notNull(),operation:text("operation").notNull(),parentId:uuid("parent_id"),requestChecksum:text("request_checksum").notNull(),
 dataScope:text("data_scope").$type<"self"|"team"|"tenant">().notNull(),receipt:jsonb("receipt").$type<{id:string;revision:number}>().notNull(),
 businessRoles:jsonb("business_roles").$type<BusinessBenchmarkRole[]>().notNull().default([]),
},t=>[uniqueIndex("knowledge_benchmark_commands_request").on(t.tenantId,t.requestId)]);
export const knowledgeBenchmarkReports=pgTable("knowledge_benchmark_reports",{
 ...scope(),experimentId:uuid("experiment_id").notNull(),sequence:integer("sequence").notNull(),manifestChecksum:text("manifest_checksum").notNull(),
 manifest:jsonb("manifest").$type<BenchmarkReport>().notNull(),proof:text("proof").notNull(),
},t=>[privateIndex(t,"knowledge_benchmark_reports_tenant_id_unique"),uniqueIndex("knowledge_benchmark_reports_sequence").on(t.tenantId,t.experimentId,t.sequence),
 foreignKey({columns:[t.tenantId,t.experimentId],foreignColumns:[knowledgeBenchmarkExperiments.tenantId,knowledgeBenchmarkExperiments.id]})]);
// Opaque routing metadata only. The worker re-enters with the recorded owner;
// private source bodies continue to use the forced owner RLS policies above.
export const knowledgeBenchmarkRetentionJobs=pgTable("knowledge_benchmark_retention_jobs",{
 id:uuid("id").primaryKey(),tenantId:uuid("tenant_id").notNull().references(()=>organizations.id),createdBy:uuid("created_by").notNull().references(()=>users.id),
 kind:text("kind").$type<"basis"|"baseline-output">().notNull(),resourceId:uuid("resource_id").notNull(),expiresAt:timestamp("expires_at",{withTimezone:true}).notNull(),
 state:text("state").$type<"pending"|"completed">().notNull().default("pending"),createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),completedAt:timestamp("completed_at",{withTimezone:true}),
},t=>[uniqueIndex("knowledge_benchmark_retention_source").on(t.tenantId,t.kind,t.resourceId)]);
