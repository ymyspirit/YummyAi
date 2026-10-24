import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts";
import type { StoreNodeHeartbeatView } from "@yummyai/contracts/marketplace/store-node";
import { organizations } from "./identity.js";
import { marketplaceAccounts } from "./marketplace.js";

const instant = (name: string) => timestamp(name, { mode: "date", withTimezone: true });
/** Identity only. These records never grant a platform operation or hold marketplace credentials. */
export const marketplaceStoreNodes = pgTable("marketplace_store_nodes", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  accountId: uuid("account_id").notNull(), label: text("label").notNull(), publicKeyPem: text("public_key_pem").notNull(),
  publicKeySpkiSha256: text("public_key_spki_sha256").notNull(), creationRequestKey: text("creation_request_key").notNull(),
  creationInputDigest: text("creation_input_digest").notNull(), status: text("status").$type<"pending_enrollment"|"enrolled"|"revoked">().default("pending_enrollment").notNull(),
  certificateGeneration: integer("certificate_generation").default(1).notNull(), certificateFingerprintSha256: text("certificate_fingerprint_sha256"),
  certificatePem: text("certificate_pem"), certificateExpiresAt: instant("certificate_expires_at"), certificateIssuedAt: instant("certificate_issued_at"),
  authorizationGeneration: uuid("authorization_generation").notNull(), createdBy: uuid("created_by").notNull(),
  membershipId: uuid("membership_id").notNull(), authorityCeiling: jsonb("authority_ceiling").$type<TenantContext>().notNull(),
  ticketDigest: text("ticket_digest"), ticketState: text("ticket_state").$type<"none"|"issued"|"claimed"|"consumed">().default("none").notNull(),
  ticketExpiresAt: instant("ticket_expires_at"), enrollmentClaimId: uuid("enrollment_claim_id"),
  sessionId: uuid("session_id"), lastSequence: integer("last_sequence").default(0).notNull(),
  sessionExpiresAt: instant("session_expires_at"), lastSeenAt: instant("last_seen_at"),
  lastHeartbeatResponse: jsonb("last_heartbeat_response").$type<StoreNodeHeartbeatView>(),
  createdAt: instant("created_at").defaultNow().notNull(), updatedAt: instant("updated_at").defaultNow().notNull(), revokedAt: instant("revoked_at"),
}, t => [
  check("store_nodes_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
  check("store_nodes_generation_check", sql`${t.certificateGeneration}>0 and ${t.lastSequence}>=0`),
  check("store_nodes_status_check", sql`${t.status} in ('pending_enrollment','enrolled','revoked')`),
  check("store_nodes_ticket_state_check", sql`${t.ticketState} in ('none','issued','claimed','consumed')`),
  check("store_nodes_digest_check", sql`${t.publicKeySpkiSha256}~'^[a-f0-9]{64}$' and ${t.creationRequestKey}~'^[a-f0-9]{64}$' and ${t.creationInputDigest}~'^[a-f0-9]{64}$'`),
  check("store_nodes_certificate_shape", sql`(${t.status}='enrolled' and num_nonnulls(${t.certificateFingerprintSha256},${t.certificatePem},${t.certificateExpiresAt},${t.certificateIssuedAt})=4) or (${t.status}<>'enrolled' and num_nonnulls(${t.certificateFingerprintSha256},${t.certificatePem},${t.certificateExpiresAt},${t.certificateIssuedAt})=0)`),
  check("store_nodes_ticket_shape", sql`(${t.ticketState}='none' and ${t.ticketDigest} is null and ${t.ticketExpiresAt} is null and ${t.enrollmentClaimId} is null) or (${t.ticketState}<>'none' and ${t.ticketDigest} is not null and ${t.ticketDigest}~'^[a-f0-9]{64}$' and ${t.ticketExpiresAt} is not null and ((${t.ticketState} in ('claimed','consumed'))=(${t.enrollmentClaimId} is not null)))`),
  foreignKey({columns:[t.tenantId,t.accountId],foreignColumns:[marketplaceAccounts.tenantId,marketplaceAccounts.id],name:"store_nodes_account_fk"}),
  uniqueIndex("store_nodes_tenant_account_id_unique").on(t.tenantId,t.accountId,t.id),
  uniqueIndex("store_nodes_creation_unique").on(t.tenantId,t.creationRequestKey),
  uniqueIndex("store_nodes_key_unique").on(t.tenantId,t.accountId,t.publicKeySpkiSha256),
  uniqueIndex("store_nodes_certificate_unique").on(t.certificateFingerprintSha256).where(sql`${t.certificateFingerprintSha256} is not null`),
  index("store_nodes_account_idx").on(t.tenantId,t.accountId,t.createdAt),
]);

export const marketplaceStoreNodeBindings = pgTable("marketplace_store_node_bindings", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  accountId: uuid("account_id").notNull(), revision: integer("revision").default(0).notNull(),
  state: text("state").$type<"unbound"|"active"|"draining">().default("unbound").notNull(), nodeId: uuid("node_id"),
  certificateGeneration: integer("certificate_generation"), authorizationGeneration: uuid("authorization_generation"),
  leaseExpiresAt: instant("lease_expires_at"), approvedBy: uuid("approved_by"), membershipId: uuid("membership_id"),
  authorityCeiling: jsonb("authority_ceiling").$type<TenantContext>(), updatedAt: instant("updated_at").defaultNow().notNull(),
}, t => [
  check("store_node_bindings_revision_check", sql`${t.revision}>=0`),
  check("store_node_bindings_state_check", sql`${t.state} in ('unbound','active','draining')`),
  foreignKey({columns:[t.tenantId,t.accountId],foreignColumns:[marketplaceAccounts.tenantId,marketplaceAccounts.id],name:"store_node_bindings_account_fk"}),
  foreignKey({columns:[t.tenantId,t.accountId,t.nodeId],foreignColumns:[marketplaceStoreNodes.tenantId,marketplaceStoreNodes.accountId,marketplaceStoreNodes.id],name:"store_node_bindings_node_fk"}),
  uniqueIndex("store_node_bindings_account_unique").on(t.tenantId,t.accountId),
]);
