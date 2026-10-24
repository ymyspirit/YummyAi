import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  foreignKey,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type { ModelBillingBudgetImpact } from "@yummyai/contracts/ai/model-billing";
import { aiAssistRuns } from "./ai-assists.js";
import { aiBudgetLedger } from "./ai.js";
import { podArtworkInvocations } from "./pod-invocations.js";
import { users } from "./identity.js";

export const modelBillingReconciliations = pgTable(
  "model_billing_reconciliations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    owner: text("owner").$type<"assist" | "pod">().notNull(),
    subjectId: uuid("subject_id").notNull(),
    assistRunId: uuid("assist_run_id"),
    podInvocationId: uuid("pod_invocation_id"),
    sequence: integer("sequence").notNull(),
    previousId: uuid("previous_id"),
    commandId: uuid("command_id").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    basisFingerprint: text("basis_fingerprint").notNull(),
    amountUsd: numeric("amount_usd", { precision: 20, scale: 8 }).notNull(),
    evidenceKind: text("evidence_kind")
      .$type<"provider_invoice" | "provider_usage" | "provider_support">()
      .notNull(),
    invoiceReference: text("invoice_reference").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    proofChecksum: text("proof_checksum").notNull(),
    budgetLedgerId: uuid("budget_ledger_id"),
    budgetImpact: jsonb("budget_impact").$type<ModelBillingBudgetImpact | null>(),
    checkedBy: uuid("checked_by")
      .notNull()
      .references(() => users.id),
    checkedAt: timestamp("checked_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("model_billing_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("model_billing_subject_id_unique").on(t.tenantId, t.owner, t.subjectId, t.id),
    uniqueIndex("model_billing_subject_sequence_unique").on(
      t.tenantId,
      t.owner,
      t.subjectId,
      t.sequence,
    ),
    uniqueIndex("model_billing_command_unique").on(t.tenantId, t.commandId),
    foreignKey({
      columns: [t.tenantId, t.assistRunId],
      foreignColumns: [aiAssistRuns.tenantId, aiAssistRuns.id],
      name: "model_billing_assist_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.podInvocationId],
      foreignColumns: [podArtworkInvocations.tenantId, podArtworkInvocations.id],
      name: "model_billing_pod_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.budgetLedgerId],
      foreignColumns: [aiBudgetLedger.tenantId, aiBudgetLedger.id],
      name: "model_billing_budget_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.owner, t.subjectId, t.previousId],
      foreignColumns: [t.tenantId, t.owner, t.subjectId, t.id],
      name: "model_billing_previous_fk",
    }).onDelete("restrict"),
    check("model_billing_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check(
      "model_billing_subject_check",
      sql`(${t.owner}='assist' and ${t.assistRunId}=${t.subjectId} and ${t.assistRunId} is not null and ${t.podInvocationId} is null) or (${t.owner}='pod' and ${t.podInvocationId}=${t.subjectId} and ${t.podInvocationId} is not null and ${t.assistRunId} is null)`,
    ),
    check(
      "model_billing_sequence_check",
      sql`${t.sequence}>0 and ((${t.sequence}=1 and ${t.previousId} is null) or (${t.sequence}>1 and ${t.previousId} is not null))`,
    ),
    check("model_billing_amount_check", sql`${t.amountUsd}>=0 and ${t.amountUsd}<=99999999.999999`),
    check(
      "model_billing_evidence_check",
      sql`${t.evidenceKind} in ('provider_invoice','provider_usage','provider_support') and ${t.proofChecksum} ~ '^[a-f0-9]{64}$' and ${t.requestChecksum} ~ '^[a-f0-9]{64}$' and ${t.basisFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "model_billing_budget_owner_check",
      sql`(${t.owner}='assist' and ${t.budgetLedgerId} is not null and ${t.budgetImpact} is not null) or (${t.owner}='pod' and ${t.budgetLedgerId} is null and ${t.budgetImpact} is null)`,
    ),
  ],
);
