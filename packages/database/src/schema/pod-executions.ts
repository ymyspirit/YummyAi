import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { podArtworkTasks } from "./pod.js";
import type { PodMethodSnapshot } from "@yummyai/contracts/harness/methods";
import type { PodCompletionV1 } from "@yummyai/contracts/pod/completion";

/** Recovery metadata for new original POD tasks. Historical tasks are not backfilled. */
export const podArtworkExecutions = pgTable("pod_artwork_executions", {
  taskId: uuid("task_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  contractVersion: text("contract_version").notNull().default("pod-execution-v1"),
  inputFingerprint: text("input_fingerprint").notNull(),
  methodSnapshot: jsonb("method_snapshot").$type<PodMethodSnapshot>(),
  completionEvidence: jsonb("completion_evidence").$type<PodCompletionV1>(),
  completionChecksum: text("completion_checksum"),
  phase: text("phase").$type<"pending" | "preparing" | "response_staging" | "response_ready" | "completed" | "failed" | "uncertain">().notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  dispatchCount: integer("dispatch_count").notNull().default(0),
  lastDispatchedAt: timestamp("last_dispatched_at", { mode: "date", withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
  responseObjectKey: text("response_object_key"),
  encryptedChecksum: text("encrypted_checksum"),
  responseChecksum: text("response_checksum"),
  responseExpiresAt: timestamp("response_expires_at", { mode: "date", withTimezone: true }),
  responsePurgedAt: timestamp("response_purged_at", { mode: "date", withTimezone: true }),
  artifactManifest: jsonb("artifact_manifest").$type<Array<{ objectKey: string; checksumSha256: string }>>(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.tenantId, t.taskId], foreignColumns: [podArtworkTasks.tenantId, podArtworkTasks.id], name: "pod_executions_task_fk" }).onDelete("restrict"),
  index("pod_executions_dispatch_idx").on(t.tenantId, t.phase, t.nextAttemptAt),
  check("pod_executions_contract_check", sql`${t.contractVersion}='pod-execution-v1' AND ${t.inputFingerprint} ~ '^[a-f0-9]{64}$'`),
  check("pod_executions_phase_check", sql`${t.phase} IN ('pending','preparing','response_staging','response_ready','completed','failed','uncertain')`),
  check("pod_executions_attempt_check", sql`${t.attemptCount} BETWEEN 0 AND 3 AND ${t.dispatchCount}>=0`),
  check("pod_executions_lease_check", sql`(${t.leaseToken} IS NULL)=(${t.leaseExpiresAt} IS NULL)`),
  check("pod_executions_response_check", sql`(${t.responseObjectKey} IS NULL AND ${t.encryptedChecksum} IS NULL AND ${t.responseChecksum} IS NULL AND ${t.responseExpiresAt} IS NULL AND ${t.responsePurgedAt} IS NULL) OR (${t.responseObjectKey} IS NOT NULL AND ${t.encryptedChecksum} ~ '^[a-f0-9]{64}$' AND ${t.responseChecksum} ~ '^[a-f0-9]{64}$' AND ${t.responseExpiresAt} IS NOT NULL)`),
  check("pod_executions_checkpoint_check", sql`${t.phase} NOT IN ('response_staging','response_ready','completed') OR ${t.responseObjectKey} IS NOT NULL`),
  check("pod_executions_artifacts_check", sql`${t.artifactManifest} IS NULL OR (jsonb_typeof(${t.artifactManifest})='array' AND jsonb_array_length(${t.artifactManifest}) BETWEEN 1 AND 100)`),
  check("pod_completion_pair_check", sql`(${t.completionEvidence} IS NULL AND ${t.completionChecksum} IS NULL) OR (${t.completionEvidence} IS NOT NULL AND ${t.completionChecksum} IS NOT NULL AND ${t.completionChecksum} ~ '^[a-f0-9]{64}$' AND ${t.phase}='completed')`),
  check("pod_completion_v2_required_check", sql`${t.methodSnapshot}#>>'{executionContract,skill,version}' IS DISTINCT FROM 'pod-method-2026-10-18-v2' OR ${t.phase}<>'completed' OR ${t.completionEvidence} IS NOT NULL`),
]);
