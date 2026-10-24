import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CreativeExecutionAuthority, CreativeExecutionCompletion, CreativeExecutionKind, HarnessExecutionContract, PodInvocationReceipt } from "@yummyai/contracts/harness";
import type { AgentMethodSelection } from "@yummyai/contracts/harness/methods";
import { aiBudgetLedger } from "./ai.js";
import { organizations, users } from "./identity.js";
import { creativeDesignCandidates, creativeDesignVersions, mockupBatchItems, mockupTemplateSourceInspections } from "./pod-batches.js";
import { creativeStudioGenerations } from "./creative-studio.js";

/** New original executions only. Existing business owners and budget ledger remain authoritative. */
export const creativeExecutions = pgTable("creative_executions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  parentExecutionId: uuid("parent_execution_id"),
  kind: text("kind").$type<CreativeExecutionKind>().notNull(), stepKey: text("step_key").notNull(),
  candidateId: uuid("candidate_id"), creativeVersionId: uuid("creative_version_id"), inspectionId: uuid("inspection_id"),
  mockupItemId: uuid("mockup_item_id"), studioGenerationId: uuid("studio_generation_id"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  authoritySnapshot: jsonb("authority_snapshot").$type<CreativeExecutionAuthority>().notNull(),
  authorityChecksum: text("authority_checksum").notNull(), inputFingerprint: text("input_fingerprint").notNull(),
  executionContract: jsonb("execution_contract").$type<HarnessExecutionContract>().notNull(),
  methodSelection: jsonb("method_selection").$type<AgentMethodSelection>().notNull(),
  effect: text("effect").$type<"external_request" | "internal_write">().notNull(),
  phase: text("phase").$type<"pending" | "preparing" | "submitted" | "response_staging" | "response_ready" | "completed" | "failed" | "uncertain">().notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0), dispatchCount: integer("dispatch_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true, mode: "date" }),
  leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
  submissionToken: uuid("submission_token"), budgetLimitUsd: numeric("budget_limit_usd", { precision: 14, scale: 6 }),
  receipt: jsonb("receipt").$type<PodInvocationReceipt>(), budgetLedgerId: uuid("budget_ledger_id"),
  responseObjectKey: text("response_object_key"), encryptedChecksum: text("encrypted_checksum"), responseChecksum: text("response_checksum"),
  responseExpiresAt: timestamp("response_expires_at", { withTimezone: true, mode: "date" }),
  responsePurgedAt: timestamp("response_purged_at", { withTimezone: true, mode: "date" }),
  artifactManifest: jsonb("artifact_manifest").$type<Array<{ objectKey: string; checksumSha256: string }>>(),
  completionEvidence: jsonb("completion_evidence").$type<CreativeExecutionCompletion>(), completionChecksum: text("completion_checksum"),
  errorCode: text("error_code"), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("creative_executions_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("creative_executions_original_step_unique").on(t.tenantId, t.kind, sql`coalesce(${t.candidateId},${t.creativeVersionId},${t.inspectionId},${t.mockupItemId},${t.studioGenerationId})`, t.stepKey),
  index("creative_executions_dispatch_idx").on(t.tenantId, t.phase, t.nextAttemptAt),
  foreignKey({ columns: [t.tenantId, t.parentExecutionId], foreignColumns: [t.tenantId, t.id], name: "creative_exec_parent_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.candidateId], foreignColumns: [creativeDesignCandidates.tenantId, creativeDesignCandidates.id], name: "creative_exec_candidate_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.creativeVersionId], foreignColumns: [creativeDesignVersions.tenantId, creativeDesignVersions.id], name: "creative_exec_version_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.inspectionId], foreignColumns: [mockupTemplateSourceInspections.tenantId, mockupTemplateSourceInspections.id], name: "creative_exec_inspection_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.mockupItemId], foreignColumns: [mockupBatchItems.tenantId, mockupBatchItems.id], name: "creative_exec_mockup_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.studioGenerationId], foreignColumns: [creativeStudioGenerations.tenantId, creativeStudioGenerations.id], name: "creative_exec_studio_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.budgetLedgerId], foreignColumns: [aiBudgetLedger.tenantId, aiBudgetLedger.id], name: "creative_exec_budget_fk" }).onDelete("restrict"),
  check("creative_exec_owner_check", sql`num_nonnulls(${t.candidateId},${t.creativeVersionId},${t.inspectionId},${t.mockupItemId},${t.studioGenerationId})=1 AND
    ((${t.kind}='creative_candidate' AND ${t.candidateId} IS NOT NULL) OR (${t.kind}='creative_adaptation' AND ${t.creativeVersionId} IS NOT NULL) OR
     (${t.kind}='template_compile' AND ${t.inspectionId} IS NOT NULL) OR (${t.kind}='mockup_render' AND ${t.mockupItemId} IS NOT NULL) OR (${t.kind}='studio_generation' AND ${t.studioGenerationId} IS NOT NULL))`),
  check("creative_exec_authority_check", sql`(${t.authoritySnapshot}->>'version'='creative-authority-v1' AND ${t.authoritySnapshot}->'context'->>'tenantId'=${t.tenantId}::text AND ${t.authoritySnapshot}->'context'->>'userId'=${t.requestedBy}::text) IS TRUE`),
  check("creative_exec_uuid_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
  check("creative_exec_hash_check", sql`${t.authorityChecksum} ~ '^[a-f0-9]{64}$' AND ${t.inputFingerprint} ~ '^[a-f0-9]{64}$'`),
  check("creative_exec_state_check", sql`${t.phase} IN ('pending','preparing','submitted','response_staging','response_ready','completed','failed','uncertain') AND ${t.effect} IN ('external_request','internal_write') AND ${t.attemptCount} BETWEEN 0 AND 3 AND ${t.dispatchCount}>=0`),
  check("creative_exec_lease_check", sql`(${t.leaseToken} IS NULL)=(${t.leaseExpiresAt} IS NULL)`),
  check("creative_exec_step_check", sql`length(${t.stepKey}) BETWEEN 1 AND 160`),
  check("creative_exec_submission_check", sql`((${t.submittedAt} IS NULL AND ${t.submissionToken} IS NULL) OR (${t.effect}='external_request' AND ${t.submittedAt} IS NOT NULL AND ${t.submissionToken} IS NOT NULL AND ${t.budgetLedgerId} IS NOT NULL AND ${t.budgetLimitUsd}>0)) IS TRUE`),
  check("creative_exec_completion_check", sql`((${t.phase}<>'completed' AND ${t.completionEvidence} IS NULL AND ${t.completionChecksum} IS NULL) OR (${t.phase}='completed' AND ${t.completionEvidence} IS NOT NULL AND ${t.completionChecksum} ~ '^[a-f0-9]{64}$')) IS TRUE`),
  check("creative_exec_response_check", sql`((${t.responseObjectKey} IS NULL AND ${t.encryptedChecksum} IS NULL AND ${t.responseChecksum} IS NULL AND ${t.responseExpiresAt} IS NULL AND ${t.responsePurgedAt} IS NULL) OR
    (${t.responseObjectKey} IS NOT NULL AND ${t.encryptedChecksum} ~ '^[a-f0-9]{64}$' AND ${t.responseChecksum} ~ '^[a-f0-9]{64}$' AND ${t.responseExpiresAt} IS NOT NULL AND (${t.effect}='internal_write' OR ${t.receipt} IS NOT NULL))) IS TRUE`),
  check("creative_exec_checkpoint_check", sql`${t.phase} NOT IN ('response_staging','response_ready','completed') OR ${t.responseObjectKey} IS NOT NULL`),
]);
