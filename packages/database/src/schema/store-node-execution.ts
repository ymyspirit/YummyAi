import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext, SyncMarketplaceCapabilitiesInput } from "@yummyai/contracts";
import type { StoreNodeSealedCredential, StoreNodeExecutionState, StoreNodeExecutionPhase, StoreNodeExecutionRequestClass } from "@yummyai/contracts/marketplace/store-node-execution";
import type { PublicationPreviewNodeInput } from "@yummyai/contracts/marketplace/publication-preview";
import type {PublicationSubmitNodeInput,PublicationStatusNodeInput} from "@yummyai/contracts/marketplace/publication-submit";
import { organizations } from "./identity.js";
import { marketplaceAccounts, marketplaceCapabilitySnapshots } from "./marketplace.js";
import { marketplaceStoreNodes } from "./store-node.js";
const instant = (name: string) => timestamp(name, { mode: "date", withTimezone: true });

/** Orchestration and original owner references, never a second capability store. */
export const marketplaceStoreNodeExecutions = pgTable("marketplace_store_node_executions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), accountId: uuid("account_id").notNull(),
  nodeId: uuid("node_id").notNull(), certificateGeneration: integer("certificate_generation").notNull(), authorizationGeneration: uuid("authorization_generation").notNull(),
  bindingRevision: integer("binding_revision").notNull(), requestId: uuid("request_id").notNull(), requestChecksum: text("request_checksum").notNull(),
  operation: text("operation").default("marketplace.capabilities.sync.v1").notNull(), input: jsonb("input").$type<SyncMarketplaceCapabilitiesInput|PublicationPreviewNodeInput|PublicationSubmitNodeInput|PublicationStatusNodeInput>().notNull(),
  createdBy: uuid("created_by").notNull(), membershipId: uuid("membership_id").notNull(), authorityCeiling: jsonb("authority_ceiling").$type<TenantContext>().notNull(),
  state: text("state").$type<StoreNodeExecutionState>().default("waiting_node").notNull(), phase: text("phase").$type<StoreNodeExecutionPhase>().default("queued").notNull(), errorCode: text("error_code"),
  claimId: uuid("claim_id"), sessionId: uuid("session_id"), credentialUseId: uuid("credential_use_id"), credentialId: uuid("credential_id"),
  originalCredentialVersion: integer("original_credential_version"), credentialVersion: integer("credential_version"),
  encryptedTransportKey: text("encrypted_transport_key"), sealedCredential: jsonb("sealed_credential").$type<StoreNodeSealedCredential>(),
  etsyAppKeySha256: text("etsy_app_key_sha256"), checkpointChecksum: text("checkpoint_checksum"), completionChecksum: text("completion_checksum"), snapshotId: uuid("snapshot_id"),
  expiresAt: instant("expires_at").notNull(), runExpiresAt: instant("run_expires_at"), leaseExpiresAt: instant("lease_expires_at"),
  startedAt: instant("started_at"), completedAt: instant("completed_at"), createdAt: instant("created_at").defaultNow().notNull(), updatedAt: instant("updated_at").defaultNow().notNull(),
}, t => [
  check("store_node_execution_id_check", sql`substring(${t.id}::text from 15 for 1)='7' and substring(${t.requestId}::text from 15 for 1)='7'`),
  check("store_node_execution_digest_check", sql`${t.requestChecksum}~'^[a-f0-9]{64}$'`),
  check("store_node_execution_pins_check", sql`${t.certificateGeneration}>0 and ${t.bindingRevision}>0`),
  check("store_node_execution_operation_check", sql`${t.operation} in ('marketplace.capabilities.sync.v1','marketplace.publication.validation-preview.v1','marketplace.publication.amazon-submit.v1','marketplace.publication.amazon-status.v1')`),
  check("store_node_execution_success_shape",sql`(${t.operation}='marketplace.capabilities.sync.v1' and (${t.state}='succeeded')=(${t.snapshotId} is not null) and (${t.snapshotId} is null or ${t.completionChecksum} is not null)) or (${t.operation} in ('marketplace.publication.validation-preview.v1','marketplace.publication.amazon-submit.v1','marketplace.publication.amazon-status.v1') and ${t.snapshotId} is null and (${t.state}<>'succeeded' or ${t.completionChecksum} is not null))`),
  foreignKey({ columns: [t.tenantId,t.accountId], foreignColumns: [marketplaceAccounts.tenantId,marketplaceAccounts.id], name: "store_node_execution_account_fk" }),
  foreignKey({ columns: [t.tenantId,t.accountId,t.nodeId], foreignColumns: [marketplaceStoreNodes.tenantId,marketplaceStoreNodes.accountId,marketplaceStoreNodes.id], name: "store_node_execution_node_fk" }),
  foreignKey({ columns: [t.tenantId,t.snapshotId], foreignColumns: [marketplaceCapabilitySnapshots.tenantId,marketplaceCapabilitySnapshots.id], name: "store_node_execution_snapshot_fk" }),
  uniqueIndex("store_node_execution_tenant_id_unique").on(t.tenantId,t.id),
  uniqueIndex("store_node_execution_request_unique").on(t.tenantId,t.accountId,t.requestId),
  uniqueIndex("store_node_execution_active_unique").on(t.tenantId,t.accountId).where(sql`${t.state} in ('claimed','running')`),
  index("store_node_execution_account_idx").on(t.tenantId,t.accountId,t.id),
]);

export const marketplaceStoreNodeExecutionSteps = pgTable("marketplace_store_node_execution_steps", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), executionId: uuid("execution_id").notNull(),
  ordinal: integer("ordinal").notNull(), requestClass: text("request_class").$type<StoreNodeExecutionRequestClass>().notNull(), requestDigest: text("request_digest").notNull(),
  permitId: uuid("permit_id").notNull(), permitExpiresAt: instant("permit_expires_at").notNull(),
  outcome: text("outcome").$type<"permitted"|"received"|"unknown"|"not_sent">().default("permitted").notNull(),
  responseDigest: text("response_digest"), httpStatus: integer("http_status"), receiptChecksum: text("receipt_checksum"),
  createdAt: instant("created_at").defaultNow().notNull(), completedAt: instant("completed_at"),
}, t => [
  check("store_node_step_ordinal_check",sql`${t.ordinal} between 1 and 128`),
  check("store_node_step_request_class_check",sql`${t.requestClass} in ('amazon_lwa','amazon_participations','amazon_product_definition','amazon_schema','amazon_meta_schema','amazon_listing_validation_preview','amazon_listing_submit','amazon_listing_status','etsy_refresh','etsy_shop','etsy_sections','etsy_return_policies','etsy_taxonomy','etsy_shipping_profiles','etsy_readiness_profiles','etsy_taxonomy_properties')`),
  foreignKey({columns:[t.tenantId,t.executionId],foreignColumns:[marketplaceStoreNodeExecutions.tenantId,marketplaceStoreNodeExecutions.id],name:"store_node_step_execution_fk"}),
  uniqueIndex("store_node_step_ordinal_unique").on(t.tenantId,t.executionId,t.ordinal),
]);
