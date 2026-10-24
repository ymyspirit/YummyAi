import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users, memberships } from "./identity.js";
import { fulfillmentFactories } from "./factory-directory.js";
import {
  productionDeliveryItems,
  productionDeliveryFeedback,
} from "./order-production-delivery.js";

const closure = () => ({
  revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  revokedBy: uuid("revoked_by").references(() => users.id),
  revocationKey: uuid("revocation_key"),
  revocationReason: text("revocation_reason"),
});
export const factoryAccessGrants = pgTable(
  "factory_access_grants",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    factoryId: uuid("factory_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    canRespond: boolean("can_respond").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    ...closure(),
  },
  (t) => [
    check("factory_access_grants_uuid_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check("factory_access_grants_checksum_check", sql`${t.requestChecksum} ~ '^[a-f0-9]{64}$'`),
    check("factory_access_grants_expiry_check", sql`${t.expiresAt}>${t.createdAt}`),
    check(
      "factory_access_grants_closure_check",
      sql`(${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revocationKey} is null and ${t.revocationReason} is null) or (${t.revokedAt}>=${t.createdAt} and ${t.revokedBy} is not null and ${t.revocationKey} is not null and ${t.revocationReason} is not null and length(${t.revocationReason}) between 5 and 500)`,
    ),
    uniqueIndex("factory_access_grants_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("factory_access_grants_request_unique").on(t.tenantId, t.idempotencyKey),
    uniqueIndex("factory_access_grants_active_unique")
      .on(t.tenantId, t.factoryId, t.membershipId)
      .where(sql`${t.revokedAt} is null`),
    foreignKey({
      columns: [t.tenantId, t.factoryId],
      foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id],
      name: "factory_access_grants_factory_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
      name: "factory_access_grants_member_fk",
    }),
    index("factory_access_grants_member_idx").on(t.tenantId, t.membershipId),
  ],
);
export const factoryTaskAssignments = pgTable(
  "factory_task_assignments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    grantId: uuid("grant_id").notNull(),
    deliveryItemId: uuid("delivery_item_id").notNull(),
    fileChecksum: text("file_checksum").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    ...closure(),
  },
  (t) => [
    check("factory_task_assignments_uuid_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    check(
      "factory_task_assignments_checksum_check",
      sql`${t.fileChecksum} ~ '^[a-f0-9]{64}$' and ${t.requestChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check("factory_task_assignments_expiry_check", sql`${t.expiresAt}>${t.createdAt}`),
    check(
      "factory_task_assignments_closure_check",
      sql`(${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revocationKey} is null and ${t.revocationReason} is null) or (${t.revokedAt}>=${t.createdAt} and ${t.revokedBy} is not null and ${t.revocationKey} is not null and ${t.revocationReason} is not null and length(${t.revocationReason}) between 5 and 500)`,
    ),
    uniqueIndex("factory_task_assignments_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("factory_task_assignments_request_unique").on(t.tenantId, t.idempotencyKey),
    uniqueIndex("factory_task_assignments_active_unique")
      .on(t.tenantId, t.grantId, t.deliveryItemId)
      .where(sql`${t.revokedAt} is null`),
    foreignKey({
      columns: [t.tenantId, t.grantId],
      foreignColumns: [factoryAccessGrants.tenantId, factoryAccessGrants.id],
      name: "factory_task_assignments_grant_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.deliveryItemId],
      foreignColumns: [productionDeliveryItems.tenantId, productionDeliveryItems.id],
      name: "factory_task_assignments_item_fk",
    }),
    index("factory_task_assignments_grant_idx").on(t.tenantId, t.grantId, t.createdAt, t.id),
  ],
);
export const factoryTaskReceipts = pgTable(
  "factory_task_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    assignmentId: uuid("assignment_id").notNull(),
    feedbackId: uuid("feedback_id").notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("factory_task_receipts_uuid_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
    uniqueIndex("factory_task_receipts_feedback_unique").on(t.tenantId, t.feedbackId),
    foreignKey({
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [factoryTaskAssignments.tenantId, factoryTaskAssignments.id],
      name: "factory_task_receipts_assignment_fk",
    }),
    foreignKey({
      columns: [t.tenantId, t.feedbackId],
      foreignColumns: [productionDeliveryFeedback.tenantId, productionDeliveryFeedback.id],
      name: "factory_task_receipts_feedback_fk",
    }),
  ],
);
