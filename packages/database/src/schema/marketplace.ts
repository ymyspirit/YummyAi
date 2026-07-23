import type {
  MarketplaceAutomationAction,
  MarketplaceAutomationConditions,
  MarketplaceCapability,
  MarketplaceOnlineListingSnapshot,
  MarketplacePublicationIssue,
} from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";
import { listings, listingVersions } from "./listing.js";

export interface MarketplacePublicationAssetPin {
  assetId: string;
  assetVersion: number;
  assetDomain: "authorized";
  rightsStatus: "approved";
  checksumSha256: string;
  objectKey: string;
  fileName: string;
  mediaType: string;
  publicationRole?: "listing_media" | "supplemental";
  rank?: number;
}

export const marketplaceAccounts = pgTable(
  "marketplace_accounts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    displayName: text("display_name").notNull(),
    externalAccountId: text("external_account_id"),
    region: text("region").notNull(),
    marketplaceIds: jsonb("marketplace_ids").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    authorizationMode: text("authorization_mode").notNull(),
    status: text("status").default("pending_authorization").notNull(),
    requestedScopes: jsonb("requested_scopes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    capabilities: jsonb("capabilities").$type<MarketplaceCapability[]>().default(sql`'[]'::jsonb`).notNull(),
    credentialStatus: text("credential_status").default("missing").notNull(),
    healthStatus: text("health_status").default("not_checked").notNull(),
    lastHealthAt: timestamp("last_health_at", { mode: "date", withTimezone: true }),
    lastCapabilitySyncAt: timestamp("last_capability_sync_at", { mode: "date", withTimezone: true }),
    capabilityExpiresAt: timestamp("capability_expires_at", { mode: "date", withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_accounts_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_accounts_platform_check", sql`${table.platform} in ('amazon', 'etsy')`),
    check("marketplace_accounts_region_check", sql`${table.region} in ('NA', 'EU', 'FE', 'GLOBAL')`),
    check("marketplace_accounts_status_check", sql`${table.status} in ('pending_authorization', 'active', 'degraded', 'revoked', 'disabled')`),
    check("marketplace_accounts_credential_check", sql`${table.credentialStatus} in ('missing', 'valid', 'expiring', 'revoked')`),
    check("marketplace_accounts_health_check", sql`${table.healthStatus} in ('not_checked', 'healthy', 'degraded', 'unauthorized', 'unavailable')`),
    check("marketplace_accounts_auth_mode_check", sql`(${table.platform} = 'amazon' and ${table.authorizationMode} in ('amazon_private', 'amazon_public')) or (${table.platform} = 'etsy' and ${table.authorizationMode} = 'etsy_oauth')`),
    uniqueIndex("marketplace_accounts_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_accounts_tenant_name_unique").on(table.tenantId, table.platform, table.displayName),
    uniqueIndex("marketplace_accounts_tenant_external_unique").on(table.tenantId, table.platform, table.externalAccountId, table.region),
    index("marketplace_accounts_tenant_status_idx").on(table.tenantId, table.status, table.updatedAt),
  ],
);

export const marketplaceCapabilitySnapshots = pgTable(
  "marketplace_capability_snapshots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    version: integer("version").notNull(),
    platform: text("platform").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    marketplaceIds: jsonb("marketplace_ids").$type<string[]>().notNull(),
    capabilities: jsonb("capabilities").$type<MarketplaceCapability[]>().notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    syncedAt: timestamp("synced_at", { mode: "date", withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_capability_snapshots_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_capability_snapshots_version_check", sql`${table.version} > 0`),
    check("marketplace_capability_snapshots_platform_check", sql`${table.platform} in ('amazon', 'etsy')`),
    check("marketplace_capability_snapshots_expiry_check", sql`${table.expiresAt} > ${table.syncedAt}`),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
      name: "marketplace_capability_snapshots_account_fk",
    }).onDelete("cascade"),
    uniqueIndex("marketplace_capability_snapshots_tenant_account_version_unique")
      .on(table.tenantId, table.accountId, table.version),
    uniqueIndex("marketplace_capability_snapshots_tenant_id_unique").on(table.tenantId, table.id),
    index("marketplace_capability_snapshots_latest_idx").on(table.tenantId, table.accountId, table.syncedAt),
    index("marketplace_capability_snapshots_expiry_idx").on(table.tenantId, table.expiresAt),
  ],
);

export const marketplacePublicationRequests = pgTable(
  "marketplace_publication_requests",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    capabilitySnapshotId: uuid("capability_snapshot_id").notNull(),
    listingId: uuid("listing_id").notNull(),
    listingVersionId: uuid("listing_version_id").notNull(),
    platform: text("platform").notNull(),
    marketplaceId: text("marketplace_id").notNull(),
    action: text("action").notNull(),
    parentRequestId: uuid("parent_request_id"),
    sourceExternalListingId: text("source_external_listing_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadChecksum: text("payload_checksum").notNull(),
    assetManifest: jsonb("asset_manifest").$type<MarketplacePublicationAssetPin[]>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_publication_requests_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_publication_requests_platform_check", sql`${table.platform} in ('amazon', 'etsy')`),
    check("marketplace_publication_requests_action_check", sql`${table.action} in ('amazon_validation_preview', 'amazon_submit', 'etsy_create_draft', 'etsy_activate')`),
    check("marketplace_publication_requests_platform_action_check", sql`(${table.platform} = 'amazon' and ${table.action} in ('amazon_validation_preview', 'amazon_submit')) or (${table.platform} = 'etsy' and ${table.action} in ('etsy_create_draft', 'etsy_activate'))`),
    check("marketplace_publication_requests_followup_check", sql`(${table.action} in ('amazon_validation_preview', 'etsy_create_draft') and ${table.parentRequestId} is null and ${table.sourceExternalListingId} is null) or (${table.action} = 'amazon_submit' and ${table.parentRequestId} is not null and ${table.sourceExternalListingId} is null) or (${table.action} = 'etsy_activate' and ${table.parentRequestId} is not null and ${table.sourceExternalListingId} is not null)`),
    check("marketplace_publication_requests_idempotency_check", sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`),
    check("marketplace_publication_requests_payload_checksum_check", sql`${table.payloadChecksum} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
      name: "marketplace_publication_requests_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.parentRequestId],
      foreignColumns: [table.tenantId, table.id],
      name: "marketplace_publication_requests_parent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.capabilitySnapshotId],
      foreignColumns: [marketplaceCapabilitySnapshots.tenantId, marketplaceCapabilitySnapshots.id],
      name: "marketplace_publication_requests_capability_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.listingId],
      foreignColumns: [listings.tenantId, listings.id],
      name: "marketplace_publication_requests_listing_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.listingVersionId],
      foreignColumns: [listingVersions.tenantId, listingVersions.id],
      name: "marketplace_publication_requests_listing_version_fk",
    }).onDelete("restrict"),
    uniqueIndex("marketplace_publication_requests_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_publication_requests_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
    index("marketplace_publication_requests_listing_idx").on(table.tenantId, table.listingId, table.createdAt),
    index("marketplace_publication_requests_account_idx").on(table.tenantId, table.accountId, table.createdAt),
    index("marketplace_publication_requests_parent_idx").on(table.tenantId, table.parentRequestId),
  ],
);

export const marketplacePublicationEvents = pgTable(
  "marketplace_publication_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    code: text("code"),
    message: text("message"),
    issues: jsonb("issues").$type<MarketplacePublicationIssue[]>().default(sql`'[]'::jsonb`).notNull(),
    externalListingId: text("external_listing_id"),
    externalSubmissionId: text("external_submission_id"),
    externalMediaIds: jsonb("external_media_ids").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    externalState: text("external_state"),
    retryable: boolean("retryable").default(false).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_publication_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_publication_events_sequence_check", sql`${table.sequence} > 0`),
    check("marketplace_publication_events_status_check", sql`${table.status} in ('queued', 'processing', 'validation_passed', 'validation_failed', 'draft_created', 'configuration_applied', 'submission_accepted', 'media_uploaded', 'activation_accepted', 'sync_pending', 'published', 'publication_failed', 'deactivated', 'retry_pending', 'reconciliation_required', 'failed')`),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [marketplacePublicationRequests.tenantId, marketplacePublicationRequests.id],
      name: "marketplace_publication_events_request_fk",
    }).onDelete("restrict"),
    uniqueIndex("marketplace_publication_events_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_publication_events_request_sequence_unique").on(table.tenantId, table.requestId, table.sequence),
    index("marketplace_publication_events_latest_idx").on(table.tenantId, table.requestId, table.sequence),
  ],
);

export const marketplaceListingSyncRequests = pgTable(
  "marketplace_listing_sync_requests",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    sourcePublicationRequestId: uuid("source_publication_request_id").notNull(),
    listingId: uuid("listing_id").notNull(),
    listingVersionId: uuid("listing_version_id").notNull(),
    platform: text("platform").notNull(),
    marketplaceId: text("marketplace_id").notNull(),
    externalListingId: text("external_listing_id").notNull(),
    action: text("action").notNull(),
    desiredState: jsonb("desired_state").$type<Record<string, unknown>>().notNull(),
    desiredChecksum: text("desired_checksum").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_listing_sync_requests_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_listing_sync_requests_platform_check", sql`${table.platform} in ('amazon','etsy')`),
    check("marketplace_listing_sync_requests_action_check", sql`${table.action} in ('read','push_price_inventory')`),
    check("marketplace_listing_sync_requests_desired_checksum_check", sql`${table.desiredChecksum} ~ '^[0-9a-f]{64}$'`),
    check("marketplace_listing_sync_requests_idempotency_check", sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`),
    foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "marketplace_listing_sync_requests_account_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.sourcePublicationRequestId], foreignColumns: [marketplacePublicationRequests.tenantId, marketplacePublicationRequests.id], name: "marketplace_listing_sync_requests_publication_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.listingId], foreignColumns: [listings.tenantId, listings.id], name: "marketplace_listing_sync_requests_listing_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.listingVersionId], foreignColumns: [listingVersions.tenantId, listingVersions.id], name: "marketplace_listing_sync_requests_version_fk" }).onDelete("restrict"),
    uniqueIndex("marketplace_listing_sync_requests_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_listing_sync_requests_idempotency_unique").on(table.tenantId, table.idempotencyKey),
    index("marketplace_listing_sync_requests_listing_idx").on(table.tenantId, table.listingId, table.createdAt),
    index("marketplace_listing_sync_requests_account_idx").on(table.tenantId, table.accountId, table.createdAt),
  ],
);

export const marketplaceListingSyncEvents = pgTable(
  "marketplace_listing_sync_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    code: text("code"),
    message: text("message"),
    issues: jsonb("issues").$type<MarketplacePublicationIssue[]>().default(sql`'[]'::jsonb`).notNull(),
    snapshot: jsonb("snapshot").$type<MarketplaceOnlineListingSnapshot>(),
    snapshotChecksum: text("snapshot_checksum"),
    retryable: boolean("retryable").default(false).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_listing_sync_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_listing_sync_events_sequence_check", sql`${table.sequence} > 0`),
    check("marketplace_listing_sync_events_status_check", sql`${table.status} in ('queued','processing','completed','drift_detected','retry_pending','reconciliation_required','failed')`),
    check("marketplace_listing_sync_events_snapshot_checksum_check", sql`${table.snapshotChecksum} is null or ${table.snapshotChecksum} ~ '^[0-9a-f]{64}$'`),
    foreignKey({ columns: [table.tenantId, table.requestId], foreignColumns: [marketplaceListingSyncRequests.tenantId, marketplaceListingSyncRequests.id], name: "marketplace_listing_sync_events_request_fk" }).onDelete("restrict"),
    uniqueIndex("marketplace_listing_sync_events_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_listing_sync_events_sequence_unique").on(table.tenantId, table.requestId, table.sequence),
    index("marketplace_listing_sync_events_latest_idx").on(table.tenantId, table.requestId, table.sequence),
  ],
);

export const marketplaceAutomationRules = pgTable(
  "marketplace_automation_rules",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    conditions: jsonb("conditions").$type<MarketplaceAutomationConditions>().notNull(),
    action: jsonb("action").$type<MarketplaceAutomationAction>().notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_automation_rules_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_automation_rules_trigger_check", sql`${table.trigger} = 'listing_approved'`),
    uniqueIndex("marketplace_automation_rules_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_automation_rules_name_unique").on(table.tenantId, table.name),
    index("marketplace_automation_rules_trigger_idx").on(table.tenantId, table.enabled, table.trigger, table.updatedAt),
  ],
);

export const marketplaceAutomationRuns = pgTable(
  "marketplace_automation_runs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").notNull(),
    listingId: uuid("listing_id").notNull(),
    listingVersionId: uuid("listing_version_id").notNull(),
    triggerKey: text("trigger_key").notNull(),
    status: text("status").notNull(),
    outputType: text("output_type"),
    outputId: uuid("output_id"),
    code: text("code"),
    message: text("message"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_automation_runs_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_automation_runs_trigger_key_check", sql`${table.triggerKey} ~ '^[0-9a-f]{64}$'`),
    check("marketplace_automation_runs_status_check", sql`${table.status} in ('skipped','enqueued','failed')`),
    foreignKey({ columns: [table.tenantId, table.ruleId], foreignColumns: [marketplaceAutomationRules.tenantId, marketplaceAutomationRules.id], name: "marketplace_automation_runs_rule_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.listingId], foreignColumns: [listings.tenantId, listings.id], name: "marketplace_automation_runs_listing_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.listingVersionId], foreignColumns: [listingVersions.tenantId, listingVersions.id], name: "marketplace_automation_runs_version_fk" }).onDelete("restrict"),
    uniqueIndex("marketplace_automation_runs_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("marketplace_automation_runs_trigger_unique").on(table.tenantId, table.ruleId, table.triggerKey),
    index("marketplace_automation_runs_listing_idx").on(table.tenantId, table.listingId, table.occurredAt),
  ],
);

export const marketplaceCredentials = pgTable(
  "marketplace_credentials",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    kind: text("kind").notNull(),
    encryptedEnvelope: text("encrypted_envelope").notNull(),
    version: integer("version").default(1).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { mode: "date", withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_credentials_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_credentials_kind_check", sql`${table.kind} in ('amazon_private', 'amazon_public', 'etsy_oauth')`),
    check("marketplace_credentials_version_check", sql`${table.version} > 0`),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
      name: "marketplace_credentials_account_fk",
    }).onDelete("cascade"),
    uniqueIndex("marketplace_credentials_tenant_account_unique").on(table.tenantId, table.accountId),
    uniqueIndex("marketplace_credentials_tenant_id_unique").on(table.tenantId, table.id),
  ],
);

export const marketplaceAuthorizationSessions = pgTable(
  "marketplace_authorization_sessions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    authorizationMode: text("authorization_mode").notNull(),
    stateDigest: text("state_digest").notNull(),
    encryptedPkceVerifier: text("encrypted_pkce_verifier"),
    redirectUri: text("redirect_uri").notNull(),
    requestedScopes: jsonb("requested_scopes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    failureCode: text("failure_code"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("marketplace_authorization_sessions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("marketplace_authorization_sessions_mode_check", sql`${table.authorizationMode} in ('amazon_public', 'etsy_oauth')`),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
      name: "marketplace_authorization_sessions_account_fk",
    }).onDelete("cascade"),
    uniqueIndex("marketplace_authorization_sessions_state_unique").on(table.stateDigest),
    uniqueIndex("marketplace_authorization_sessions_tenant_id_unique").on(table.tenantId, table.id),
    index("marketplace_authorization_sessions_expiry_idx").on(table.tenantId, table.accountId, table.expiresAt),
  ],
);
