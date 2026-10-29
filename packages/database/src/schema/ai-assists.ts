import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AssistKind, AssistModel } from "@yummyai/contracts/ai/assist";
import type { ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import { organizations, users } from "./identity.js";
import { orderLines } from "./order.js";

const transactionId = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

export const aiAssistRuns = pgTable(
  "ai_assist_runs",
  {
    id: uuid("id").primaryKey(),
    benchmarkItemId: uuid("benchmark_item_id"),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    requestId: uuid("request_id").notNull(),
    kind: text("kind").$type<AssistKind>().notNull(),
    scope: text("scope").notNull(),
    orderLineId: uuid("order_line_id"),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed" | "cancelled">()
      .notNull()
      .default("queued"),
    inputFingerprint: text("input_fingerprint").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    encryptedInput: text("encrypted_input"),
    encryptedOutput: text("encrypted_output"),
    modelSnapshot: jsonb("model_snapshot")
      .$type<AssistModel & { providerConfigId: string }>()
      .notNull(),
    promptVersion: text("prompt_version").notNull(),
    errorCode: text("error_code"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    tokenUsage: jsonb("token_usage").$type<ModelTokenUsage>(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
    reservedCostUsd: numeric("reserved_cost_usd", { precision: 14, scale: 6 }).notNull(),
    // Legacy rows remain null. The database records every future insert's full transaction ID.
    creationTransactionId: transactionId("creation_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    uniqueIndex("ai_assist_runs_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("ai_assist_runs_request_unique").on(t.tenantId, t.ownerId, t.requestId),
    index("ai_assist_runs_scope_idx").on(t.tenantId, t.ownerId, t.scope, t.kind, t.createdAt),
    check("ai_assist_runs_token_usage_check", sql`${t.tokenUsage} is null or (${t.status}<>'queued' and jsonb_typeof(${t.tokenUsage})='object' and coalesce(${t.tokenUsage}->>'version','')='model-token-usage-v1')`),
    check(
      "ai_assist_runs_kind_check",
      sql`${t.kind} in ('creative','order_review','artwork_preflight','template_config','sku_package','business_review','procurement_review','after_sales_review','knowledge_answer')`,
    ),
    check(
      "ai_assist_runs_status_check",
      sql`${t.status} in ('queued','running','completed','failed','cancelled')`,
    ),
    foreignKey({
      columns: [t.tenantId, t.orderLineId],
      foreignColumns: [orderLines.tenantId, orderLines.id],
      name: "ai_assist_runs_order_line_fk",
    }).onDelete("restrict"),
  ],
);
