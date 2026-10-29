import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { aiAssistRuns } from "./ai-assists.js";
const transactionId = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" });

/** Execution metadata belongs to the original assist owner. Legacy runs are never backfilled. */
export const aiAssistExecutions = pgTable(
  "ai_assist_executions",
  {
    runId: uuid("run_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    contractVersion: text("contract_version").notNull().default("assist-execution-v1"),
    inputFingerprint: text("input_fingerprint").notNull(),
    policyChecksum: text("policy_checksum").notNull(),
    phase: text("phase")
      .$type<"pending" | "preparing" | "response_ready" | "completed" | "failed" | "uncertain">()
      .notNull()
      .default("pending"),
    submissionState: text("submission_state")
      .$type<"not_submitted" | "submitted" | "received">()
      .notNull()
      .default("not_submitted"),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchCount: integer("dispatch_count").notNull().default(0),
    lastDispatchedAt: timestamp("last_dispatched_at", { mode: "date", withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
    encryptedResponse: text("encrypted_response"),
    responseChecksum: text("response_checksum"),
    providerRequestId: text("provider_request_id"),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true }),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }),
    /** Database-owned first receipt origin; null on historical receipts. */
    responseReceiptTransactionId: transactionId("response_receipt_transaction_id"),
    nextAttemptAt: timestamp("next_attempt_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ai_assist_executions_receipt_origin_check", sql`${t.responseReceiptTransactionId} is null or ${t.receivedAt} is not null`),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [aiAssistRuns.tenantId, aiAssistRuns.id],
      name: "ai_assist_executions_run_fk",
    }).onDelete("restrict"),
    index("ai_assist_executions_dispatch_idx").on(t.tenantId, t.phase, t.nextAttemptAt),
    check(
      "ai_assist_executions_phase_check",
      sql`${t.phase} IN ('pending','preparing','response_ready','completed','failed','uncertain')`,
    ),
    check(
      "ai_assist_executions_submission_check",
      sql`${t.submissionState} IN ('not_submitted','submitted','received')`,
    ),
    check(
      "ai_assist_executions_attempt_check",
      sql`${t.attemptCount} BETWEEN 0 AND 3 AND ${t.dispatchCount} >= 0`,
    ),
    check(
      "ai_assist_executions_lease_check",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "ai_assist_executions_response_check",
      sql`${t.encryptedResponse} IS NULL OR (${t.responseChecksum} ~ '^[a-f0-9]{64}$' AND ${t.submissionState}='received' AND ${t.receivedAt} IS NOT NULL)`,
    ),
  ],
);
