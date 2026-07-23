import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const MarketplacePlatformSchema = z.enum(["amazon", "etsy"]);
export const MarketplaceAuthorizationModeSchema = z.enum([
  "amazon_private",
  "amazon_public",
  "etsy_oauth",
]);
export const MarketplaceRegionSchema = z.enum(["NA", "EU", "FE", "GLOBAL"]);
export const MarketplaceAccountStatusSchema = z.enum([
  "pending_authorization",
  "active",
  "degraded",
  "revoked",
  "disabled",
]);
export const MarketplaceCredentialStatusSchema = z.enum([
  "missing",
  "valid",
  "expiring",
  "revoked",
]);
export const MarketplaceHealthStatusSchema = z.enum([
  "not_checked",
  "healthy",
  "degraded",
  "unauthorized",
  "unavailable",
]);
export const MarketplaceCapabilitySchema = z.enum([
  "catalog_read",
  "shop_read",
  "taxonomy_read",
  "shipping_profile_read",
  "policy_read",
  "listing_read",
  "listing_write",
  "listing_delete",
  "media_write",
  "inventory_write",
  "notification_read",
]);

export const AmazonPrivateAuthorizationInputSchema = z.object({
  sellingPartnerId: z.string().trim().min(1).max(160),
  clientId: z.string().trim().min(1).max(2_048),
  clientSecret: z.string().min(1).max(8_192),
  refreshToken: z.string().min(1).max(16_384),
}).strict();

export const MarketplaceOAuthCompleteInputSchema = z.object({
  state: z.string().min(32).max(512),
  code: z.string().min(1).max(16_384),
  sellingPartnerId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const MarketplaceOAuthStartViewSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const SyncMarketplaceCapabilitiesInputSchema = z.object({
  amazonProductTypes: z.array(
    z.string().trim().min(1).max(120).regex(/^[A-Z0-9_]+$/),
  ).max(10).default([]),
  etsyTaxonomyNodeIds: z.array(z.number().int().positive()).max(10).default([]),
  ttlHours: z.number().int().min(1).max(168).default(24),
}).strict();

export const MarketplaceCapabilitySnapshotViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema,
  version: z.number().int().positive(),
  platform: MarketplacePlatformSchema,
  externalAccountId: z.string(),
  marketplaceIds: z.array(z.string()),
  capabilities: z.array(MarketplaceCapabilitySchema),
  sourceVersion: z.string(),
  sourceChecksum: z.string(),
  data: z.record(z.string(), z.unknown()),
  syncedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  stale: z.boolean(),
});

const accountCore = z.object({
  platform: MarketplacePlatformSchema,
  displayName: z.string().trim().min(1).max(120),
  externalAccountId: z.string().trim().min(1).max(160).nullable().optional(),
  region: MarketplaceRegionSchema,
  marketplaceIds: z.array(z.string().trim().min(1).max(80)).min(1).max(64),
  authorizationMode: MarketplaceAuthorizationModeSchema,
  requestedScopes: z.array(z.string().trim().min(1).max(120)).max(64).default([]),
}).strict();

export const CreateMarketplaceAccountInputSchema = accountCore.superRefine((value, context) => {
  const amazonMode = value.authorizationMode === "amazon_private" || value.authorizationMode === "amazon_public";
  if ((value.platform === "amazon") !== amazonMode) {
    context.addIssue({ code: "custom", path: ["authorizationMode"], message: "Authorization mode must match the platform" });
  }
  if (value.platform === "etsy" && value.region !== "GLOBAL") {
    context.addIssue({ code: "custom", path: ["region"], message: "Etsy accounts use the GLOBAL region" });
  }
  if (value.platform === "amazon" && value.region === "GLOBAL") {
    context.addIssue({ code: "custom", path: ["region"], message: "Amazon accounts require NA, EU, or FE" });
  }
});

export const UpdateMarketplaceAccountInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  marketplaceIds: z.array(z.string().trim().min(1).max(80)).min(1).max(64).optional(),
  requestedScopes: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const MarketplaceAccountViewSchema = z.object({
  id: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  displayName: z.string(),
  externalAccountId: z.string().nullable(),
  region: MarketplaceRegionSchema,
  marketplaceIds: z.array(z.string()),
  authorizationMode: MarketplaceAuthorizationModeSchema,
  status: MarketplaceAccountStatusSchema,
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  capabilities: z.array(MarketplaceCapabilitySchema),
  credentialStatus: MarketplaceCredentialStatusSchema,
  hasCredential: z.boolean(),
  healthStatus: MarketplaceHealthStatusSchema,
  lastHealthAt: z.iso.datetime().nullable(),
  lastCapabilitySyncAt: z.iso.datetime().nullable(),
  capabilityExpiresAt: z.iso.datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type MarketplacePlatform = z.infer<typeof MarketplacePlatformSchema>;
export type MarketplaceAuthorizationMode = z.infer<typeof MarketplaceAuthorizationModeSchema>;
export type MarketplaceRegion = z.infer<typeof MarketplaceRegionSchema>;
export type MarketplaceAccountStatus = z.infer<typeof MarketplaceAccountStatusSchema>;
export type MarketplaceCredentialStatus = z.infer<typeof MarketplaceCredentialStatusSchema>;
export type MarketplaceHealthStatus = z.infer<typeof MarketplaceHealthStatusSchema>;
export type MarketplaceCapability = z.infer<typeof MarketplaceCapabilitySchema>;
export type AmazonPrivateAuthorizationInput = z.infer<typeof AmazonPrivateAuthorizationInputSchema>;
export type MarketplaceOAuthCompleteInput = z.infer<typeof MarketplaceOAuthCompleteInputSchema>;
export type MarketplaceOAuthStartView = z.infer<typeof MarketplaceOAuthStartViewSchema>;
export type SyncMarketplaceCapabilitiesInput = z.infer<typeof SyncMarketplaceCapabilitiesInputSchema>;
export type MarketplaceCapabilitySnapshotView = z.infer<typeof MarketplaceCapabilitySnapshotViewSchema>;
export type CreateMarketplaceAccountInput = z.infer<typeof CreateMarketplaceAccountInputSchema>;
export type UpdateMarketplaceAccountInput = z.infer<typeof UpdateMarketplaceAccountInputSchema>;
export type MarketplaceAccountView = z.infer<typeof MarketplaceAccountViewSchema>;
