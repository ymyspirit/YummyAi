import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import { podArtworkTasks } from "./pod.js";
import { designVersions } from "./design.js";

/** Operational receipts, not a second budget ledger or a reconciled provider invoice. */
export const podArtworkInvocations = pgTable(
  "pod_artwork_invocations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    phase: text("phase")
      .$type<"pending" | "submitted" | "received" | "completed" | "failed" | "uncertain">()
      .notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true }),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
    responseChecksum: text("response_checksum"),
    providerRequestId: text("provider_request_id"),
    modelKey: text("model_key"),
    modelVersion: text("model_version"),
    reportedCostUsd: numeric("reported_cost_usd", { precision: 20, scale: 8 }),
    metadataValid: boolean("metadata_valid"),
    resultVersionId: uuid("result_version_id"),
  },
  (t) => [
    uniqueIndex("pod_invocations_tenant_id_unique").on(t.tenantId,t.id),
    foreignKey({
      columns: [t.tenantId, t.taskId],
      foreignColumns: [podArtworkTasks.tenantId, podArtworkTasks.id],
      name: "pod_invocations_task_fk",
    }).onDelete("restrict"),
    foreignKey({columns:[t.tenantId,t.resultVersionId],foreignColumns:[designVersions.tenantId,designVersions.id],name:"pod_invocations_version_fk"}).onDelete("restrict"),
    uniqueIndex("pod_invocations_task_attempt_unique").on(t.tenantId, t.taskId, t.attemptNumber),
    index("pod_invocations_task_idx").on(t.tenantId, t.taskId, t.startedAt),
    check("pod_invocations_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check("pod_invocations_attempt_check", sql`${t.attemptNumber} between 1 and 20`),
    check(
      "pod_invocations_phase_check",
      sql`${t.phase} in ('pending','submitted','received','completed','failed','uncertain')`,
    ),
    check(
      "pod_invocations_cost_check",
      sql`${t.reportedCostUsd} is null or ${t.reportedCostUsd}>=0`,
    ),
    check(
      "pod_invocations_response_check",
      sql`(${t.receivedAt} is null and ${t.responseChecksum} is null and ${t.reportedCostUsd} is null and ${t.metadataValid} is null) or (${t.receivedAt} is not null and ${t.submittedAt} is not null and ${t.responseChecksum} is not null and ${t.responseChecksum} ~ '^[a-f0-9]{64}$' and ${t.metadataValid} is not null)`,
    ),
    check("pod_invocations_boundary_check",sql`(${t.phase} not in ('submitted','received','completed','uncertain') or ${t.submittedAt} is not null) and (${t.phase} not in ('received','completed') or ${t.receivedAt} is not null) and (${t.phase}<>'completed' or (${t.resultVersionId} is not null and ${t.finishedAt} is not null))`),
  ],
);
